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
/** Past the newest snapshot a remote keeps coasting on its velocity for this long, then holds. */
export const EXTRAPOLATE_MS = 250;
export const FADE_AFTER_MS = 2000;
export const FADE_MS = 1000;
export const REMOVE_AFTER_MS = 6000;

const TICK_MS = 1000 / TICK_HZ;
const MAX_SAMPLES = 16;
const SEQ_RANGE = 0x10000;
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
}

const NO_MARKS: SnapshotMarks = { ready: false, egg: false };

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
    genomeRef,
  };
}

/** Sends one snapshot per 100 ms of loop time, on a schedule so frame timing does not drift it. */
export class SnapshotSender {
  private seq = 0;
  private due = 0;

  constructor(private readonly send: (bytes: Uint8Array) => void) {}

  /** Call once per frame. `build` runs only when a snapshot is due. */
  update(ms: number, hidden: boolean, build: () => SnapshotFields): void {
    if (ms < this.due) return;
    // After a pause (a hidden tab), restart the schedule instead of sending the backlog.
    const late = ms - this.due > SNAPSHOT_INTERVAL_MS;
    this.due = (late ? ms : this.due) + SNAPSHOT_INTERVAL_MS;
    if (hidden) return;
    this.send(encodeSnapshot({ ...build(), seq: this.seq }));
    this.seq = (this.seq + 1) % SEQ_RANGE;
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
   * time wins even when `seq` looks old: a peer that reloaded starts counting from 0 again.
   */
  push(s: Snapshot): boolean {
    const t = s.tick * TICK_MS;
    const last = this.samples[this.samples.length - 1];
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

  /** The pose at `pondMs`, or null before anything was heard. The result is overwritten by the next call. */
  sample(pondMs: number): RemotePose | null {
    const { samples, pose } = this;
    const newest = samples[samples.length - 1];
    if (!newest) return null;
    let i = samples.length - 1;
    while (i > 0 && (samples[i] as Sample).t > pondMs) i--;
    const from = samples[i] as Sample;
    pose.biomass = newest.biomass;
    pose.alive = newest.alive;
    pose.dashing = newest.dashing;
    pose.vx = newest.vx;
    pose.vy = newest.vy;
    if (pondMs <= from.t) {
      // Older than anything held: hold the oldest pose.
      pose.x = from.x;
      pose.y = from.y;
      pose.heading = from.heading;
    } else if (i < samples.length - 1) {
      const to = samples[i + 1] as Sample;
      const f = (pondMs - from.t) / (to.t - from.t);
      pose.x = lerp(from.x, to.x, f);
      pose.y = lerp(from.y, to.y, f);
      pose.heading = from.heading + wrapAngle(to.heading - from.heading) * f;
    } else {
      const seconds = Math.min(pondMs - newest.t, EXTRAPOLATE_MS) / 1000;
      pose.x = newest.x + newest.vx * seconds;
      pose.y = newest.y + newest.vy * seconds;
      pose.heading = newest.heading;
    }
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
}

interface Remote {
  buffer: RemoteBuffer;
  lastHeardMs: number;
  view: RemoteView;
}

/** Every remote creature in the pond: names from the roster, poses from snapshots. */
export class RemoteSet {
  private readonly names = new Map<string, string>();
  private readonly remotes = new Map<string, Remote>();
  private readonly views: RemoteView[] = [];

  setMember(id: string, name: string): void {
    this.names.set(id, name);
    const remote = this.remotes.get(id);
    if (remote) remote.view.name = name;
  }

  removeMember(id: string): void {
    this.names.delete(id);
    this.remotes.delete(id);
  }

  /** Feeds a decoded snapshot; `localMs` is the receiver's wall clock. */
  receive(id: string, snapshot: Snapshot, localMs: number): void {
    let remote = this.remotes.get(id);
    if (!remote) {
      remote = {
        buffer: new RemoteBuffer(),
        lastHeardMs: localMs,
        view: {
          id,
          name: this.names.get(id) ?? id.slice(0, 6),
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
        },
      };
      this.remotes.set(id, remote);
    }
    // Only news counts as life: a peer repeating old packets must still fade away.
    if (remote.buffer.push(snapshot)) {
      remote.lastHeardMs = localMs;
      remote.view.genomeRef = snapshot.genomeRef;
      remote.view.ready = snapshot.ready;
      remote.view.egg = snapshot.egg;
    }
  }

  /**
   * The live remotes as they should be drawn at `pondMs`, which is shown `INTERPOLATION_MS`
   * late. The array and its views are reused between calls.
   */
  sample(localMs: number, pondMs: number): readonly RemoteView[] {
    this.views.length = 0;
    for (const [id, remote] of this.remotes) {
      const quiet = localMs - remote.lastHeardMs;
      if (quiet > REMOVE_AFTER_MS) {
        this.remotes.delete(id);
        continue;
      }
      const pose = remote.buffer.sample(pondMs - INTERPOLATION_MS);
      if (!pose?.alive) continue;
      const { view } = remote;
      view.x = pose.x;
      view.y = pose.y;
      view.heading = pose.heading;
      view.radius = Math.sqrt(clamp(pose.biomass, MIN_DRAWN_BIOMASS, MAX_DRAWN_BIOMASS));
      view.beat = pose.dashing ? 1 : clamp(Math.hypot(pose.vx, pose.vy) / CRUISE, 0, 1);
      view.alpha = clamp(1 - (quiet - FADE_AFTER_MS) / FADE_MS, 0, 1);
      this.views.push(view);
    }
    return this.views;
  }
}

function hueOf(playerId: string): number {
  return hashU32(...seedFromString(playerId)) / 0x100000000;
}
