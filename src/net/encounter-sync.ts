// Client prediction and rollback for a refereed encounter (ADR 0050, M7 T10). Pure: the hub clock
// is passed in, and nothing here touches the DOM.
//
// Frames are numbered from 0: frame f starts at hub time `at + f × FRAME_MS`, an `input` and an
// `enc-frame` name the frame they belong to, and an `enc-end`'s `f` counts the frames stepped. The
// local clock leads the hub's by `leadMs(oneWay)`. The own input is sampled when its frame begins,
// sent, and used at once; the others repeat their last confirmed input, brace and dash cleared. A
// bundle that differs from what was predicted rolls the fight back to that frame and replays it.

import type { Creature } from '../genome/stats';
import { decodeFrameInput, encodeFrameInput } from '../sim/encounter/codec';
import {
  checkFighter,
  createEncounter,
  hashEncounter,
  stepFrame,
} from '../sim/encounter/encounter';
import { applyJoins } from '../sim/encounter/join';
import type {
  Encounter,
  EncounterEvent,
  EncounterJoin,
  EncounterStart,
  FrameInput,
} from '../sim/encounter/types';
import { wrapAngle } from '../sim/math';
import { RULES } from '../sim/rules';
import type { CreatureState } from '../sim/types';
import { type EncJoin, type EncStart, encounterStartOf, fighterStartOf } from './encounter-start';
import type { ClientMsg, FighterInfo, FighterOutcome, HubMsg } from './protocol-defs';
import { FRAME_MS } from './referee';

const E = RULES.encounter;

/** Rollback keeps this many frames of states; a bundle further behind replays the fight from frame 0. */
export const KEEP_FRAMES = 10;
/** A remote's correction after a rollback eases out over this long instead of jumping. */
export const EASE_MS = 100;
/** The lead is the one-way latency less this, between 0 and `MAX_LEAD_MS`. */
const LEAD_SLACK_MS = 80;
const MAX_LEAD_MS = 100;

export type EncStartMsg = EncStart;
export type EncFrameMsg = Extract<HubMsg, { t: 'enc-frame' }>;
export type EncJoinMsg = EncJoin;
export type EncEndMsg = Extract<HubMsg, { t: 'enc-end' }>;
export type InputMsg = Extract<ClientMsg, { t: 'input' }>;
type Inputs = (number | null)[];

/** How far the local clock runs ahead of the hub's, so an input sent at its frame's start arrives in time. */
export const leadMs = (oneWayMs: number): number =>
  Math.min(MAX_LEAD_MS, Math.max(0, (Number.isFinite(oneWayMs) ? oneWayMs : 0) - LEAD_SLACK_MS));

const STATE_KEYS = ['x', 'y', 'vx', 'vy', 'heading', 'biomass', 'energy', 'health'] as const;

const sameInputs = (a: Inputs | undefined, b: Inputs): boolean =>
  a !== undefined && a.length === b.length && a.every((v, i) => v === b[i]);

/** A remote's prediction: its last confirmed input with brace and dash cleared (null stays the autopilot). */
function repeated(code: number | null | undefined): number | null {
  if (code === null || code === undefined) return null;
  return encodeFrameInput({ ...decodeFrameInput(code), brace: false, dash: false });
}

export interface Pose {
  x: number;
  y: number;
  heading: number;
}

interface Ease {
  dx: number;
  dy: number;
  dh: number;
  at: number;
}

export interface SyncOptions {
  /** This player's id: its fighter is the one sampled and sent. */
  me: string;
  /** The own input for frame `f`, sampled as it begins; null leaves the frame to the autopilot. */
  sample(f: number): FrameInput | null;
  send(msg: InputMsg): void;
  /** The one-way latency to the hub in ms (half the round trip). */
  oneWayMs(): number;
  /**
   * Every simulated frame's events, for the fight's cues (M7 T12). A rollback replays frames, so
   * the same event can come again: a hit names its tick, and the listener drops repeats.
   */
  events?(events: readonly EncounterEvent[]): void;
}

export class EncounterSync {
  /** The fight being played, or null before the first start. */
  enc: Encounter | null = null;
  id = '';
  /** The own slot; -1 for a joiner before its `enc-join` names it (M7 T15). */
  slot = -1;
  /** Frames simulated locally (the current state is at this frame). */
  frame = 0;
  /** Frames confirmed by the referee from frame 0 without a gap. */
  confirmed = 0;
  /** The referee's `enc-end` has been applied. */
  over = false;
  /** The local `hashEncounter` once over. */
  hash: string | null = null;
  /** The referee's hash from `enc-end`, once over. */
  endHash: string | null = null;
  rollbacks = 0;
  resyncs = 0;
  desyncs = 0;
  /** The most frames one rollback replayed. */
  longestRollback = 0;
  /** Bundles for another fight or of the wrong width. */
  dropped = 0;

  private origin: EncounterStart | null = null;
  /** Fighters joined after the start, each seated before its frame (M7 T15). */
  private joins: EncounterJoin[] = [];
  private bodies: ((genome: string) => Creature | null) | undefined;
  private at = 0;
  private bundles: (Inputs | undefined)[] = [];
  private newest = -1;
  /** The inputs each simulated frame used. */
  private used: Inputs[] = [];
  /** The own code sent for each frame, or null where the autopilot played. */
  private own: (number | null)[] = [];
  /** `states.get(f)`: the fight before frame f, for the last `KEEP_FRAMES` frames. */
  private readonly states = new Map<number, Encounter>();
  /** The earliest simulated frame whose bundle differed from its prediction. */
  private dirty: number | null = null;
  private ease: Ease[] = [];

  constructor(private readonly opts: SyncOptions) {}

  /** A fight is running: started and not yet ended. */
  get running(): boolean {
    return this.enc !== null && !this.over;
  }

  /**
   * Begins the fight of an `enc-start` this player is in; false (and nothing changes) otherwise.
   * With `joining`, a fight it is not in yet also begins: the player is joining it (M7 T15), and
   * its slot comes with the `enc-join` that names it.
   */
  start(
    msg: EncStartMsg,
    pond: { seed: string; size: number },
    bodies?: (genome: string) => Creature | null,
    joining = false,
  ): boolean {
    const start = encounterStartOf(msg, pond.seed, bodies);
    if (!start) return false;
    let enc: Encounter;
    try {
      enc = createEncounter(start);
    } catch {
      return false;
    }
    const slot = enc.fighters.findIndex((f) => f.player === this.opts.me);
    if (slot < 0 && !joining) return false;
    this.origin = start;
    this.joins = [];
    this.bodies = bodies;
    this.enc = enc;
    this.id = msg.enc;
    this.slot = slot;
    this.at = msg.at;
    this.frame = 0;
    this.confirmed = 0;
    this.over = false;
    this.hash = null;
    this.endHash = null;
    this.rollbacks = 0;
    this.resyncs = 0;
    this.desyncs = 0;
    this.longestRollback = 0;
    this.dropped = 0;
    this.bundles = [];
    this.newest = -1;
    this.used = [];
    this.own = [];
    this.states.clear();
    this.dirty = null;
    this.ease = enc.fighters.map(() => ({ dx: 0, dy: 0, dh: 0, at: -Infinity }));
    return true;
  }

  /** The hub time frame `f` starts. */
  frameStart(f: number): number {
    return this.at + f * FRAME_MS;
  }

  /** Frames begun by local time (the hub's plus the lead), up to the timeout. */
  private due(hubNow: number): number {
    const local = hubNow + leadMs(this.opts.oneWayMs());
    if (local < this.at) return 0;
    return Math.min(E.timeoutFrames, Math.floor((local - this.at) / FRAME_MS) + 1);
  }

  /**
   * Settles any correction, then simulates every frame begun by now. Only the newest one samples
   * the own input: older ones (a hidden tab catching up) are already past their deadline, so the
   * autopilot played them. Returns the frames stepped.
   */
  step(hubNow: number): number {
    if (!this.running) return 0;
    this.reconcile(hubNow);
    const target = this.due(hubNow);
    const from = this.frame;
    while (this.frame < target) this.simulate(this.frame === target - 1);
    return this.frame - from;
  }

  /** A frame bundle from the referee. A difference from the prediction is settled at the next step. */
  receive(msg: EncFrameMsg): void {
    const { enc } = this;
    if (!enc || msg.enc !== this.id || this.over) return;
    if (msg.i.length !== this.width(msg.f) || msg.f >= E.timeoutFrames) {
      this.dropped++;
      return;
    }
    if (this.bundles[msg.f] !== undefined) return;
    const inputs = [...msg.i];
    this.bundles[msg.f] = inputs;
    if (msg.f > this.newest) this.newest = msg.f;
    while (this.bundles[this.confirmed] !== undefined) this.confirmed++;
    if (msg.f >= this.frame || sameInputs(this.used[msg.f], inputs)) return;
    // Once the fight is over, a later frame changes nothing.
    if (enc.over && msg.f >= enc.frame) return;
    this.dirty = this.dirty === null ? msg.f : Math.min(this.dirty, msg.f);
  }

  /** Fighters in frame `f`: the start's and those joined by then. */
  private width(f: number): number {
    const first = this.origin?.fighters.length ?? 0;
    return first + this.joins.filter((j) => j.f <= f).length;
  }

  /**
   * A fighter joins the fight from frame `msg.f` (M7 T15): the own player takes the next slot,
   * anyone else is seated there. A join this client has simulated past rolls back to its frame at
   * the next step. False for another fight, a creature already in it, a fight already full, a
   * frame before the last join or the last confirmed bundle, or a body that does not build.
   */
  join(msg: EncJoinMsg): boolean {
    const { enc, origin } = this;
    if (!enc || !origin || msg.enc !== this.id || this.over) return false;
    const last = this.joins[this.joins.length - 1]?.f ?? 0;
    if (!Number.isInteger(msg.f) || msg.f < last || msg.f < this.confirmed) return false;
    if (msg.f >= E.timeoutFrames) return false;
    const seated = origin.fighters.length + this.joins.length;
    if (seated >= E.maxFighters) return false;
    const creature = msg.fighter.creature;
    const taken = (c: string) => c === creature;
    if (
      origin.fighters.some((f) => taken(f.creature)) ||
      this.joins.some((j) => taken(j.fighter.creature))
    ) {
      return false;
    }
    const fighter = fighterStartOf(msg.fighter, this.bodies);
    if (!fighter) return false;
    try {
      checkFighter(fighter);
    } catch {
      return false;
    }
    this.joins.push({ f: msg.f, fighter });
    if (fighter.player === this.opts.me && this.slot < 0) this.slot = seated;
    if (msg.f < this.frame && !(enc.over && msg.f >= enc.frame)) {
      this.dirty = this.dirty === null ? msg.f : Math.min(this.dirty, msg.f);
    }
    return true;
  }

  /**
   * The referee's end: the fight is played out to `f` with every bundle, and the own fighter takes
   * the authority's final state exactly. A different hash or own state counts as a desync. Returns
   * the own fighter's outcome, or null for another fight.
   */
  end(msg: EncEndMsg): FighterOutcome | null {
    const { enc } = this;
    if (!enc || msg.enc !== this.id || this.over) return null;
    const mine = msg.fighters[this.slot];
    if (!mine) {
      // A joiner whose join frame never came: the fight is over without it.
      this.endHash = msg.hash;
      this.over = true;
      return null;
    }
    this.reconcile(null);
    if (this.frame > msg.f) this.rewind(msg.f);
    while (this.frame < msg.f) this.simulate(false, false);
    const live = this.enc as Encounter;
    this.hash = hashEncounter(live);
    this.endHash = msg.hash;
    const body = (live.fighters[this.slot] as Encounter['fighters'][number]).body;
    const differs = this.hash !== msg.hash || STATE_KEYS.some((k) => body[k] !== mine[k]);
    if (differs) this.desyncs++;
    for (const k of STATE_KEYS) body[k] = mine[k];
    this.over = true;
    return mine;
  }

  /** The own fighter's simulated body, or null before a start. */
  ownBody(): CreatureState | null {
    return this.enc?.fighters[this.slot]?.body ?? null;
  }

  /**
   * Where slot `slot` is drawn at `hubNow`: between its state at the newest frame's start and its
   * end, by how far that frame has run. `eased` adds what is left of a rollback's correction.
   */
  pose(slot: number, hubNow: number, eased = true): Pose | null {
    const to = this.enc?.fighters[slot]?.body;
    if (!to) return null;
    const from = this.over ? to : (this.states.get(this.frame - 1)?.fighters[slot]?.body ?? to);
    const k = this.progress(hubNow);
    const pose = {
      x: from.x + (to.x - from.x) * k,
      y: from.y + (to.y - from.y) * k,
      heading: wrapAngle(from.heading + wrapAngle(to.heading - from.heading) * k),
    };
    const e = this.ease[slot];
    if (!eased || !e) return pose;
    const left = 1 - (hubNow - e.at) / EASE_MS;
    if (left <= 0) return pose;
    pose.x += e.dx * left;
    pose.y += e.dy * left;
    pose.heading = wrapAngle(pose.heading + e.dh * left);
    return pose;
  }

  /**
   * Where slot `slot`'s carried egg is drawn at `hubNow`, as `pose` draws its carrier: between its
   * place at the newest frame's start and its end, plus what is left of the carrier's eased
   * correction. Null for a fighter without an egg.
   */
  eggAt(slot: number, hubNow: number): { x: number; y: number } | null {
    const to = this.enc?.fighters[slot]?.eggBody;
    if (!to) return null;
    const from = this.over ? to : (this.states.get(this.frame - 1)?.fighters[slot]?.eggBody ?? to);
    const k = this.progress(hubNow);
    const at = { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k };
    const e = this.ease[slot];
    const left = e ? 1 - (hubNow - e.at) / EASE_MS : 0;
    if (e && left > 0) {
      at.x += e.dx * left;
      at.y += e.dy * left;
    }
    return at;
  }

  /** How far the newest frame has run at `hubNow` on the local clock, 0..1. */
  private progress(hubNow: number): number {
    const local = hubNow + leadMs(this.opts.oneWayMs());
    return Math.min(1, Math.max(0, (local - this.frameStart(this.frame - 1)) / FRAME_MS));
  }

  /** Steps frame `this.frame` with its bundle, or with the own input and the remotes' predictions. */
  private simulate(sample: boolean, keep = true): void {
    const enc = this.enc as Encounter;
    const f = this.frame;
    this.seat(enc);
    const inputs = this.inputsFor(f, sample);
    if (keep) this.states.set(f, structuredClone(enc));
    this.states.delete(f - KEEP_FRAMES);
    this.used[f] = inputs;
    const events = stepFrame(enc, inputs);
    this.frame = f + 1;
    if (events.length > 0) this.opts.events?.(events);
  }

  /** Seats the joins due before the frame `enc` is at; each new slot starts with no correction to ease. */
  private seat(enc: Encounter): void {
    const before = enc.fighters.length;
    applyJoins(enc, this.joins);
    for (let s = before; s < enc.fighters.length; s++) {
      this.ease[s] = { dx: 0, dy: 0, dh: 0, at: -Infinity };
    }
  }

  private inputsFor(f: number, sample: boolean): Inputs {
    const known = this.bundles[f];
    if (known) return known;
    let own = this.own[f];
    if (own === undefined) {
      // A joiner samples nothing before its own slot is seated.
      const seated = this.slot >= 0 && this.slot < (this.enc as Encounter).fighters.length;
      own = sample && seated ? this.sampleOwn(f) : null;
      this.own[f] = own;
    }
    const latest = this.newest >= 0 ? this.bundles[this.newest] : undefined;
    const enc = this.enc as Encounter;
    return enc.fighters.map((_, s) => (s === this.slot ? own : repeated(latest?.[s])));
  }

  private sampleOwn(f: number): number | null {
    const input = this.opts.sample(f);
    if (!input) return null;
    const code = encodeFrameInput(input);
    this.opts.send({ t: 'input', enc: this.id, f, i: code });
    return code;
  }

  /**
   * Replays from the earliest frame a bundle corrected: from its kept state, or from frame 0 when
   * it is more than `KEEP_FRAMES` behind. With `hubNow`, each fighter's drawn jump eases out.
   */
  private reconcile(hubNow: number | null): void {
    const from = this.dirty;
    if (from === null || !this.origin) return;
    this.dirty = null;
    const before = hubNow === null ? [] : this.poses(hubNow, true);
    const upTo = this.frame;
    const kept = this.states.get(from);
    if (upTo - from > KEEP_FRAMES || !kept) {
      this.resyncs++;
      this.states.clear();
      this.enc = createEncounter(this.origin);
      this.frame = 0;
    } else {
      this.rollbacks++;
      this.longestRollback = Math.max(this.longestRollback, upTo - from);
      this.enc = kept;
      this.frame = from;
    }
    while (this.frame < upTo) this.simulate(false, this.frame >= upTo - KEEP_FRAMES);
    if (hubNow === null) return;
    const after = this.poses(hubNow, false);
    this.ease = after.map((a, slot) => {
      const b = before[slot] ?? a;
      return { dx: b.x - a.x, dy: b.y - a.y, dh: wrapAngle(b.heading - a.heading), at: hubNow };
    });
  }

  /** Back to the start of frame `f`: from its kept state, or from frame 0 when it is older. */
  private rewind(f: number): void {
    const kept = this.states.get(f);
    if (kept) {
      this.enc = kept;
      this.frame = f;
    } else {
      this.enc = createEncounter(this.origin as EncounterStart);
      this.frame = 0;
    }
  }

  private poses(hubNow: number, eased: boolean): Pose[] {
    const enc = this.enc as Encounter;
    return enc.fighters.map((_, slot) => this.pose(slot, hubNow, eased) as Pose);
  }
}
