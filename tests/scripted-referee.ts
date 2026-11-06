// A scripted in-process referee and a lossy-latency link for encounter client tests (M7 T10). It
// follows the referee's rules (ADR 0050): an input is taken from 2 frames ahead until 120 ms after
// its frame starts, the first one wins, a frame is final at its deadline or once every fighter
// still in has sent, and a missing input is the fallback marker null.

import { genomeToBase64url } from '../src/genome/codec';
import { starterGenome } from '../src/genome/starter';
import type { EncStartMsg } from '../src/net/encounter-sync';
import type { FighterOutcome, HubMsg } from '../src/net/protocol';
import { FRAME_MS } from '../src/net/referee';
import { createEncounter, hashEncounter, results, stepFrame } from '../src/sim/encounter/encounter';
import { applyJoins } from '../src/sim/encounter/join';
import type { Encounter, EncounterJoin, EncounterStart } from '../src/sim/encounter/types';
import { createRng, type Rng, seedFromString } from '../src/sim/prng';
import { RULES } from '../src/sim/rules';
import { maxHealth, starterEnergy } from '../src/sim/vitals';

/** Every fighter's final state and result, by slot, as an `enc-end` carries them. */
function fighterOutcomes(enc: Encounter): FighterOutcome[] {
  const res = results(enc);
  return enc.fighters.map((f, slot) => {
    const r = res[slot] as (typeof res)[number];
    const b = f.body;
    return {
      player: f.player,
      creature: f.creature,
      x: b.x,
      y: b.y,
      vx: b.vx,
      vy: b.vy,
      heading: b.heading,
      biomass: b.biomass,
      energy: b.energy,
      health: b.health,
      outcome: r.outcome,
      cause: r.cause,
      by: r.by,
      egg: r.egg,
      eggBy: r.eggBy,
    };
  });
}

const E = RULES.encounter;
const EARLY_FRAMES = 2;

export const STARTER_TEXT = genomeToBase64url(starterGenome());
export const TEST_POND = { seed: 'sync-pond', size: RULES.world.size };

/**
 * An `enc-start` for starters in a row 30 wu apart from (x, y) eastward: by default two, `a`
 * (player `pa`) and `b` (player `pb`); with `count` up to 4, `c` and `d` follow.
 */
export function startMsg(at = 10_000, x = 5200, y = 3000, count = 2): EncStartMsg {
  const biomass = RULES.starter.biomass;
  const fighter = (player: string, creature: string, fx: number, heading: number) => ({
    player,
    creature,
    genome: STARTER_TEXT,
    x: fx,
    y,
    vx: 0,
    vy: 0,
    heading,
    biomass,
    energy: starterEnergy(biomass),
    health: maxHealth(biomass),
    elder: false,
    egg: false,
    worth: 1,
  });
  return {
    t: 'enc-start',
    enc: 'e1'.repeat(32),
    seed: '5eed'.repeat(16),
    round: 0,
    t0: 1000,
    at,
    fighters: Array.from({ length: count }, (_, i) =>
      fighter(`p${'abcd'[i]}`, 'abcd'[i] as string, x + 30 * i, i % 2 === 0 ? 0 : Math.PI),
    ),
  };
}

/** Messages in flight one way: in order, each after the latency plus a seeded jitter. */
export class Link<T> {
  private readonly queue: { at: number; msg: T }[] = [];
  private last = 0;
  /** Messages sent before this hub time arrive no sooner than it (a stalled connection). */
  stallUntil = -Infinity;
  private readonly rng: Rng;

  constructor(
    private readonly latencyMs: number,
    private readonly jitterMs: number,
    seed: string,
  ) {
    this.rng = createRng(seedFromString(seed), 'link');
  }

  send(now: number, msg: T): void {
    let at = now + this.latencyMs + this.rng.range(0, this.jitterMs);
    if (now < this.stallUntil) at = Math.max(at, this.stallUntil);
    at = Math.max(at, this.last);
    this.last = at;
    this.queue.push({ at, msg });
  }

  take(now: number): T[] {
    let n = 0;
    while (n < this.queue.length && (this.queue[n] as { at: number }).at <= now) n++;
    return this.queue.splice(0, n).map((q) => q.msg);
  }
}

export class ScriptedReferee {
  readonly enc: Encounter;
  /** Frames finalized. */
  next = 0;
  late = 0;
  early = 0;
  readonly bundles: (number | null)[][] = [];
  /** Fighters joined (M7 T15), each seated before its frame is stepped. */
  readonly joins: EncounterJoin[] = [];
  /** Frames a witness referees (M10 T3): they come from its batches (`take`), never from inputs. */
  witnessed: { from: number; to: number } | null = null;
  private readonly inputs = new Map<number, (number | null)[]>();

  constructor(
    readonly start: EncounterStart,
    readonly at: number,
  ) {
    this.enc = createEncounter(start);
  }

  slotOf(player: string): number {
    const seated = this.enc.fighters.findIndex((f) => f.player === player);
    if (seated >= 0) return seated;
    const joining = this.joins.findIndex((j) => j.fighter.player === player);
    return joining < 0 ? -1 : this.start.fighters.length + joining;
  }

  /** A fighter joins from frame `f` (at least the next to be finalized). */
  join(f: number, fighter: EncounterJoin['fighter']): void {
    if (f < this.next) throw new Error('a join in the past');
    this.joins.push({ f, fighter });
  }

  /** Slots that take inputs for frame `f`. */
  private width(f: number): number {
    return this.start.fighters.length + this.joins.filter((j) => j.f <= f).length;
  }

  input(slot: number, f: number, code: number, now: number): void {
    if (f < this.next || now > this.at + f * FRAME_MS + E.inputDeadlineMs) {
      this.late++;
      return;
    }
    if (f > this.next + EARLY_FRAMES) {
      this.early++;
      return;
    }
    if (slot < 0 || slot >= this.width(f)) return;
    const row = this.inputs.get(f) ?? new Array<number | null>(this.width(f)).fill(null);
    if (row[slot] === null) row[slot] = code;
    this.inputs.set(f, row);
  }

  /** The frames finalized by `now`, in order, each stepped on the referee's own encounter. */
  due(now: number): Extract<HubMsg, { t: 'enc-frame' }>[] {
    const out: Extract<HubMsg, { t: 'enc-frame' }>[] = [];
    while (!this.enc.over && this.next < E.timeoutFrames) {
      const f = this.next;
      if (this.witnessed && f >= this.witnessed.from && f < this.witnessed.to) break;
      applyJoins(this.enc, this.joins);
      const row = this.inputs.get(f) ?? [];
      while (row.length < this.width(f)) row.push(null);
      const allIn = this.enc.fighters.every((x, s) => x.status !== 'in' || row[s] !== null);
      if (!allIn && now < this.at + f * FRAME_MS + E.inputDeadlineMs) break;
      this.inputs.delete(f);
      this.bundles.push(row);
      stepFrame(this.enc, row);
      this.next++;
      out.push({ t: 'enc-frame', enc: this.start.id, f, i: row });
    }
    return out;
  }

  /**
   * A witness's batch: frames `f` on, each stepped on the referee's own encounter as if finalized
   * here. Frames already final are skipped; a gap stops it. Returns the frames taken.
   */
  take(f: number, rows: readonly (number | null)[][]): Extract<HubMsg, { t: 'enc-frame' }>[] {
    const out: Extract<HubMsg, { t: 'enc-frame' }>[] = [];
    rows.forEach((row, k) => {
      if (f + k !== this.next || this.enc.over) return;
      applyJoins(this.enc, this.joins);
      this.bundles.push([...row]);
      stepFrame(this.enc, row);
      this.next++;
      out.push({ t: 'enc-frame', enc: this.start.id, f: f + k, i: [...row] });
    });
    return out;
  }

  endMsg(): Extract<HubMsg, { t: 'enc-end' }> {
    return {
      t: 'enc-end',
      enc: this.start.id,
      f: this.enc.frame,
      hash: hashEncounter(this.enc),
      fighters: fighterOutcomes(this.enc),
    };
  }
}
