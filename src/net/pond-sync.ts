// Pond sync: what a client sends about its own creature and how it shows the others. Remote
// creatures are never simulated; they are drawn from the quantised snapshots they send.

import { clamp, lerp, wrapAngle } from '../sim/math';
import { hashU32, seedFromString } from '../sim/prng';
import { RULES, TICK_HZ } from '../sim/rules';
import type { CreatureState } from '../sim/types';
import { maxEnergy, maxHealth } from '../sim/vitals';
import { encodeSnapshot, type Snapshot } from './protocol';

export const SNAPSHOT_INTERVAL_MS = 100;
/** Remote creatures are drawn this far behind the pond clock, so two samples bracket the view. */
export const INTERPOLATION_MS = 120;
/**
 * A remote heard less often (M11 T15: 5, 2 or 1 Hz) is drawn its snapshots' spacing plus this far
 * behind, so two of them still bracket the view; the lag eases between the two.
 */
const LAG_MARGIN_MS = INTERPOLATION_MS - SNAPSHOT_INTERVAL_MS;
/** Spacings up to this count as 10 Hz (the sender's ticks make it 67 to 133 ms). */
const FULL_RATE_GAP_MS = 150;
/** The widest spacing the lag follows: 1 Hz, the slowest asked rate. */
const MAX_GAP_MS = 1000;
/** The lag follows the smallest of this many newest spacings, so one lost snapshot does not slow a remote. */
const GAP_SAMPLES = 3;
/** A shrinking lag runs the drawn clock at most this much fast, so a remote eases in at 1.2× (`EASE_SPEED`). */
const LAG_SHRINK = 0.2;
/** A growing lag runs the drawn clock at half speed at the slowest. */
const LAG_GROW = 0.5;
/** Past the newest snapshot a remote keeps coasting on its velocity for this long, then holds. */
export const EXTRAPOLATE_MS = 250;
/** A drawn creature never moves faster than this × its snapshots' speed, so a late snapshot eases in (M6b T1). */
export const EASE_SPEED = 1.2;
/** A creature that has stopped still catches up at this speed (wu/s), so it is never left behind. */
const EASE_MIN_SPEED = 40;
/** Further than this from where the snapshots put it, a creature has been moved: it is drawn there at once. */
const SNAP_DISTANCE = 400;
export const FADE_AFTER_MS = 2000;
export const FADE_MS = 1000;
export const REMOVE_AFTER_MS = 6000;
/** An away fighter, drawn from proxies or its fight, shows at most this opaque (M8 T11). */
export const AWAY_ALPHA = 0.6;
/** Names of players who left, kept so a proxy of one can still be labelled. */
const LEFT_NAMES = 32;

const TICK_MS = 1000 / TICK_HZ;
const MAX_SAMPLES = 16;
export const SEQ_RANGE = 0x10000;
/** Steady swimming speed, so a remote's flagellum beats in proportion to how fast it moves. */
const CRUISE = RULES.movement.thrust / RULES.movement.drag;
/** A remote is drawn within this range of biomass whatever its peer claims (the snapshot can carry up to 2^24). */
const MIN_DRAWN_BIOMASS = 10;
const MAX_DRAWN_BIOMASS = RULES.body.maxBiomassCeiling;
/** A dash shows for this many ticks after it starts. */
const DASH_SHOWN_TICKS = 8;

export type SnapshotFields = Omit<Snapshot, 'seq'>;

/** What the life around the creature adds to its snapshot (see `Snapshot`). */
export interface SnapshotMarks {
  ready: boolean;
  egg: boolean;
  spawnProtected: boolean;
  fighting: boolean;
}

const NO_MARKS: SnapshotMarks = {
  ready: false,
  egg: false,
  spawnProtected: false,
  fighting: false,
};

/** The creature as peers see it. Energy and health are fractions of their maxima. */
export function snapshotOf(
  creature: CreatureState,
  tick: number,
  genomeRef: number,
  marks: SnapshotMarks = NO_MARKS,
): SnapshotFields {
  const sinceDash = tick - (creature.dashReadyTick - RULES.movement.dashCooldownTicks);
  return {
    tick,
    x: creature.x,
    y: creature.y,
    heading: creature.heading,
    vx: creature.vx,
    vy: creature.vy,
    biomass: creature.biomass,
    energy: clamp(creature.energy / maxEnergy(creature.biomass), 0, 1),
    health: clamp(creature.health / maxHealth(creature.biomass), 0, 1),
    alive: creature.alive,
    dashing: sinceDash >= 0 && sinceDash < DASH_SHOWN_TICKS,
    ready: marks.ready,
    egg: marks.egg,
    spawnProtected: marks.spawnProtected,
    fighting: marks.fighting,
    genomeRef,
  };
}

/** Every second snapshot (200 ms) may go out signed, to engage candidates (M7 T7). */
export const SIGN_EVERY = 2;

/**
 * Makes one snapshot per 100 ms of loop time, on a schedule so frame timing does not drift it.
 * `send` gets the 29 bytes, for every second snapshot the 93-byte signed frame when `update` was
 * given a signer that made one, and the snapshot's number `n` (from 0), by which each link's asked
 * rate picks its share (`SendRates`, M11 T15).
 */
export class SnapshotSender {
  private seq = 0;
  private due = 0;
  private sent = 0;

  constructor(
    private readonly send: (bytes: Uint8Array, signed: Uint8Array | null, n: number) => void,
  ) {}

  /** The seq the next snapshot takes. */
  get nextSeq(): number {
    return this.seq;
  }

  /**
   * Call once per frame. `build` runs only when a snapshot is due, and `sign` (the 29 bytes to a
   * 93-byte frame, or null) only for every second one.
   */
  update(
    ms: number,
    hidden: boolean,
    build: () => SnapshotFields,
    sign?: (bytes: Uint8Array) => Uint8Array | null,
  ): void {
    if (ms < this.due) return;
    // After a pause (a hidden tab), restart the schedule instead of sending the backlog.
    const late = ms - this.due > SNAPSHOT_INTERVAL_MS;
    this.due = (late ? ms : this.due) + SNAPSHOT_INTERVAL_MS;
    if (hidden) return;
    const bytes = encodeSnapshot({ ...build(), seq: this.seq });
    const signed = sign && this.sent % SIGN_EVERY === 0 ? sign(bytes) : null;
    this.send(bytes, signed, this.sent);
    this.seq = (this.seq + 1) % SEQ_RANGE;
    this.sent++;
  }
}

interface Sample {
  /** Pond time in ms, from the sender's tick. */
  t: number;
  x: number;
  y: number;
  heading: number;
  vx: number;
  vy: number;
  biomass: number;
  alive: boolean;
  dashing: boolean;
}

/** Where a remote creature is at one moment of pond time; the object is reused by `sample`. */
export interface RemotePose {
  x: number;
  y: number;
  heading: number;
  vx: number;
  vy: number;
  biomass: number;
  alive: boolean;
  dashing: boolean;
}

/** Newest snapshots of one peer, in pond time, with interpolation between them. */
export class RemoteBuffer {
  private readonly samples: Sample[] = [];
  private newestSeq = -1;
  /** Where `sample` last drew the creature, and when (pond ms); NaN before the first call. */
  private shownAt = Number.NaN;
  private shownX = 0;
  private shownY = 0;
  /** How far behind the pond clock `sampleLate` draws (ms), and when it last did. */
  private lag = INTERPOLATION_MS;
  private lagAt = Number.NaN;
  /** The fastest it was drawn, as a share of its snapshots' speed (M11 T15). */
  pace = 0;
  private readonly pose: RemotePose = {
    x: 0,
    y: 0,
    heading: 0,
    vx: 0,
    vy: 0,
    biomass: 0,
    alive: true,
    dashing: false,
  };

  /**
   * Returns false for a snapshot that is a duplicate or older than the newest one. A newer pond
   * time wins even when `seq` looks old: a peer that reloaded starts counting from 0 again. With
   * `newerOnly` (proxies, which several relays number apart) only a newer pond time counts.
   */
  push(s: Snapshot, newerOnly = false): boolean {
    const t = s.tick * TICK_MS;
    const last = this.samples[this.samples.length - 1];
    if (newerOnly && last && t <= last.t) return false;
    if (this.newestSeq >= 0 && last && t <= last.t) {
      const ahead = (s.seq - this.newestSeq + SEQ_RANGE) % SEQ_RANGE;
      if (ahead === 0 || ahead >= SEQ_RANGE / 2) return false;
    }
    this.newestSeq = s.seq;
    // A newer snapshot that claims an earlier time means the sender's clock was reset.
    if (last && t <= last.t) this.samples.length = 0;
    this.samples.push({
      t,
      x: s.x,
      y: s.y,
      heading: s.heading,
      vx: s.vx,
      vy: s.vy,
      biomass: s.biomass,
      alive: s.alive,
      dashing: s.dashing,
    });
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
    return true;
  }

  /**
   * After a gap the snapshots put the creature well ahead of where it was drawn: it catches up at
   * `EASE_SPEED` times its speed instead of jumping, unless it was moved (`SNAP_DISTANCE`).
   * `pondMs` is the pond clock now, not the moment drawn.
   */
  private ease(pose: RemotePose, pondMs: number, speed: number): void {
    const dt = (pondMs - this.shownAt) / 1000;
    if (dt > 0) {
      const dx = pose.x - this.shownX;
      const dy = pose.y - this.shownY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const pace = Math.max(speed, EASE_MIN_SPEED) * dt;
      const step = EASE_SPEED * pace;
      if (distance > step && distance <= SNAP_DISTANCE) {
        pose.x = this.shownX + (dx * step) / distance;
        pose.y = this.shownY + (dy * step) / distance;
      }
      this.pace = Math.max(this.pace, Math.min(distance, step) / pace);
      if (distance > SNAP_DISTANCE) this.pace = Math.max(this.pace, distance / pace);
    } else if (dt === 0) {
      pose.x = this.shownX;
      pose.y = this.shownY;
    }
    this.shownAt = pondMs;
    this.shownX = pose.x;
    this.shownY = pose.y;
  }

  /** The pose at `pondMs`, or null before anything was heard. The result is overwritten by the next call. */
  sample(pondMs: number): RemotePose | null {
    return this.poseAt(pondMs, pondMs);
  }

  /**
   * The pose to draw at `pondMs`, the pond clock now: `INTERPOLATION_MS` behind it for a remote
   * heard at 10 Hz, its snapshots' spacing plus 20 ms behind for one heard less often (M11 T15).
   * The lag eases between the two, so a remote whose rate rises catches up at 1.2× its speed at
   * most and one whose rate falls slows down; neither jumps.
   */
  sampleLate(pondMs: number): RemotePose | null {
    const dt = Number.isNaN(this.lagAt) ? 0 : Math.max(0, pondMs - this.lagAt);
    this.lagAt = pondMs;
    const want = this.wantedLag();
    this.lag =
      want > this.lag
        ? Math.min(want, this.lag + LAG_GROW * dt)
        : Math.max(want, this.lag - LAG_SHRINK * dt);
    return this.poseAt(pondMs - this.lag, pondMs);
  }

  /** The lag the newest snapshots' spacing asks for: the smallest of the last few. */
  private wantedLag(): number {
    const { samples } = this;
    let gap = Number.POSITIVE_INFINITY;
    for (let i = Math.max(1, samples.length - GAP_SAMPLES); i < samples.length; i++) {
      gap = Math.min(gap, (samples[i] as Sample).t - (samples[i - 1] as Sample).t);
    }
    if (!(gap > FULL_RATE_GAP_MS)) return INTERPOLATION_MS;
    return Math.min(gap, MAX_GAP_MS) + LAG_MARGIN_MS;
  }

  private poseAt(drawnMs: number, pondMs: number): RemotePose | null {
    const { samples, pose } = this;
    const newest = samples[samples.length - 1];
    if (!newest) return null;
    let i = samples.length - 1;
    while (i > 0 && (samples[i] as Sample).t > drawnMs) i--;
    const from = samples[i] as Sample;
    pose.biomass = newest.biomass;
    pose.alive = newest.alive;
    pose.dashing = newest.dashing;
    pose.vx = newest.vx;
    pose.vy = newest.vy;
    let speed = Math.hypot(newest.vx, newest.vy);
    if (drawnMs <= from.t) {
      // Older than anything held: hold the oldest pose.
      pose.x = from.x;
      pose.y = from.y;
      pose.heading = from.heading;
    } else if (i < samples.length - 1) {
      const to = samples[i + 1] as Sample;
      const f = (drawnMs - from.t) / (to.t - from.t);
      speed = Math.max(speed, (Math.hypot(to.x - from.x, to.y - from.y) * 1000) / (to.t - from.t));
      pose.x = lerp(from.x, to.x, f);
      pose.y = lerp(from.y, to.y, f);
      pose.heading = from.heading + wrapAngle(to.heading - from.heading) * f;
    } else {
      const seconds = Math.min(drawnMs - newest.t, EXTRAPOLATE_MS) / 1000;
      pose.x = newest.x + newest.vx * seconds;
      pose.y = newest.y + newest.vy * seconds;
      pose.heading = newest.heading;
    }
    // A creature that died is drawn afresh where it next appears, not glided there.
    if (newest.alive) this.ease(pose, pondMs, speed);
    else this.shownAt = Number.NaN;
    return pose;
  }
}

/** One remote creature as the renderer and HUD read it. */
export interface RemoteView {
  id: string;
  name: string;
  x: number;
  y: number;
  heading: number;
  /** In world units. */
  radius: number;
  /** 0..1, how hard the flagellum beats. */
  beat: number;
  /** 0..1, fades out when the peer goes quiet. */
  alpha: number;
  /** 0..1, a stable colour from the player id. */
  hue: number;
  /** The genome ref of the newest snapshot (see `genomeRefOf`). */
  genomeRef: number;
  /** The newest snapshot's ready-to-mate and egg marks (a hint; see `Snapshot`). */
  ready: boolean;
  egg: boolean;
  /** The newest snapshot's spawn-protected and fighting marks (M7): who can be engaged. */
  spawnProtected: boolean;
  fighting: boolean;
  /** The newest snapshot's health, a share of its maximum (M7 T12: a drop flashes it). */
  health: number;
  /**
   * A fighter whose player is away (M8 T11): drawn from proxy snapshots or the own fight, faded to
   * `AWAY_ALPHA`, and never offered for an engage.
   */
  away: boolean;
  /** The fastest it was drawn, as a share of its snapshots' speed (M11 T15: at most `EASE_SPEED`). */
  pace: number;
}

interface Remote {
  buffer: RemoteBuffer;
  lastHeardMs: number;
  /** When its own snapshot last brought news; -Infinity before the first. */
  lastOwnMs: number;
  /** Its newest own snapshot said it is fighting (a proxy never sets this). */
  ownFighting: boolean;
  /** When it stopped sharing water with this page (M12 T6), or null: it fades out over `FADE_MS`. */
  fadeFrom: number | null;
  view: RemoteView;
}

/**
 * Every remote creature in the pond: names from the roster, poses from snapshots. A fighter whose
 * player left stays while proxies or its fight move it (M8 T11), and fades out when they stop.
 */
export class RemoteSet {
  private readonly names = new Map<string, string>();
  /** Names of players who left, most recent last. */
  private readonly left = new Map<string, string>();
  private readonly remotes = new Map<string, Remote>();
  private readonly views: RemoteView[] = [];

  /** `gone` hears of each remote that faded out after its player left the roster. */
  constructor(private readonly gone?: (id: string) => void) {}

  setMember(id: string, name: string): void {
    this.names.set(id, name);
    this.left.delete(id);
    const remote = this.remotes.get(id);
    if (remote) {
      remote.view.name = name;
    }
    // A new link to it: it shares water again.
    this.fadeIn(id);
  }

  /**
   * `id` stopped sharing water with this page (M12 T6): it fades out over `FADE_MS` from `localMs`
   * and then goes, whether or not its link is still open.
   */
  fadeOut(id: string, localMs: number): void {
    const remote = this.remotes.get(id);
    if (remote && remote.fadeFrom === null) remote.fadeFrom = localMs;
  }

  /** `id` shares water with this page again: its fade, if any, ends. */
  fadeIn(id: string): void {
    const remote = this.remotes.get(id);
    if (remote) remote.fadeFrom = null;
  }

  /**
   * A player left the roster. Its creature stays while it may still be fighting (its newest own
   * snapshot said so, or proxies move it), to fade when nothing moves it any more, or while it fades
   * out of the shared water (M12 T6); true then.
   */
  removeMember(id: string): boolean {
    const name = this.names.get(id);
    this.names.delete(id);
    if (name !== undefined) {
      this.left.delete(id);
      this.left.set(id, name);
      if (this.left.size > LEFT_NAMES) this.left.delete(this.left.keys().next().value as string);
    }
    const remote = this.remotes.get(id);
    if (remote && (remote.ownFighting || remote.view.away || remote.fadeFrom !== null)) return true;
    this.remotes.delete(id);
    return false;
  }

  private remote(id: string, snapshot: Snapshot, localMs: number): Remote {
    let remote = this.remotes.get(id);
    if (!remote) {
      remote = {
        buffer: new RemoteBuffer(),
        lastHeardMs: localMs,
        lastOwnMs: Number.NEGATIVE_INFINITY,
        ownFighting: false,
        fadeFrom: null,
        view: {
          id,
          name: this.names.get(id) ?? this.left.get(id) ?? id.slice(0, 6),
          x: 0,
          y: 0,
          heading: 0,
          radius: 1,
          beat: 0,
          alpha: 1,
          hue: hueOf(id),
          genomeRef: snapshot.genomeRef,
          ready: snapshot.ready,
          egg: snapshot.egg,
          spawnProtected: snapshot.spawnProtected,
          fighting: snapshot.fighting,
          health: snapshot.health,
          away: false,
          pace: 0,
        },
      };
      this.remotes.set(id, remote);
    }
    return remote;
  }

  private take(remote: Remote, snapshot: Snapshot, localMs: number): void {
    const { view } = remote;
    remote.lastHeardMs = localMs;
    view.genomeRef = snapshot.genomeRef;
    view.ready = snapshot.ready;
    view.egg = snapshot.egg;
    view.spawnProtected = snapshot.spawnProtected;
    view.fighting = snapshot.fighting;
    view.health = snapshot.health;
  }

  /** Feeds a decoded snapshot; `localMs` is the receiver's wall clock. */
  receive(id: string, snapshot: Snapshot, localMs: number): void {
    const remote = this.remote(id, snapshot, localMs);
    // Only news counts as life: a peer repeating old packets must still fade away.
    if (remote.buffer.push(snapshot)) {
      this.take(remote, snapshot, localMs);
      remote.lastOwnMs = localMs;
      remote.ownFighting = snapshot.fighting;
      remote.view.away = false;
    }
  }

  /**
   * Feeds an away fighter's pose that someone else stands in for (M8 T11): a relayed proxy, or
   * the own fight's view of an opponent. It draws the creature away; only a newer pond time counts.
   */
  proxy(id: string, snapshot: Snapshot, localMs: number): void {
    const remote = this.remote(id, snapshot, localMs);
    if (!remote.buffer.push(snapshot, true)) return;
    this.take(remote, snapshot, localMs);
    // A stand-in pose never makes a creature look ready, protected or engageable.
    remote.view.ready = false;
    remote.view.spawnProtected = false;
    remote.view.away = true;
  }

  /** Whether `id`'s newest own snapshot said it is fighting (proxies do not count). */
  fighting(id: string): boolean {
    return this.remotes.get(id)?.ownFighting === true;
  }

  /** Ms since `id`'s own snapshot last brought news; Infinity when none ever did. */
  quietMs(id: string, localMs: number): number {
    return localMs - (this.remotes.get(id)?.lastOwnMs ?? Number.NEGATIVE_INFINITY);
  }

  /**
   * The live remotes as they should be drawn at `pondMs`, each shown late by its own lag
   * (`RemoteBuffer.sampleLate`). The array and its views are reused between calls.
   */
  sample(localMs: number, pondMs: number): readonly RemoteView[] {
    this.views.length = 0;
    for (const [id, remote] of this.remotes) {
      const quiet = localMs - remote.lastHeardMs;
      const shared = remote.fadeFrom === null ? 1 : 1 - (localMs - remote.fadeFrom) / FADE_MS;
      if (quiet > REMOVE_AFTER_MS || shared <= 0) {
        this.remotes.delete(id);
        if (!this.names.has(id)) this.gone?.(id);
        continue;
      }
      const pose = remote.buffer.sampleLate(pondMs);
      if (!pose?.alive) continue;
      const { view } = remote;
      view.pace = remote.buffer.pace;
      view.x = pose.x;
      view.y = pose.y;
      view.heading = pose.heading;
      view.radius = Math.sqrt(clamp(pose.biomass, MIN_DRAWN_BIOMASS, MAX_DRAWN_BIOMASS));
      view.beat = pose.dashing ? 1 : clamp(Math.hypot(pose.vx, pose.vy) / CRUISE, 0, 1);
      const alpha = clamp(Math.min(shared, 1 - (quiet - FADE_AFTER_MS) / FADE_MS), 0, 1);
      view.alpha = view.away ? Math.min(alpha, AWAY_ALPHA) : alpha;
      this.views.push(view);
    }
    return this.views;
  }
}

function hueOf(playerId: string): number {
  return hashU32(...seedFromString(playerId)) / 0x100000000;
}
