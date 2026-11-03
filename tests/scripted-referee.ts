// A scripted in-process referee and a lossy-latency link for encounter client tests (M7 T10). It
// follows the referee's rules (ADR 0050): an input is taken from 2 frames ahead until 120 ms after
// its frame starts, the first one wins, a frame is final at its deadline or once every fighter
// still in has sent, and a missing input is the fallback marker null.

import { genomeToBase64url } from '../src/genome/codec';
import { starterGenome } from '../src/genome/starter';
import { type EncStartMsg, FRAME_MS, fighterOutcomes } from '../src/net/encounter-sync';
import type { HubMsg } from '../src/net/protocol';
import { createEncounter, hashEncounter, stepFrame } from '../src/sim/encounter/encounter';
import type { Encounter, EncounterStart } from '../src/sim/encounter/types';
import { createRng, type Rng, seedFromString } from '../src/sim/prng';
import { RULES } from '../src/sim/rules';
import { maxHealth, starterEnergy } from '../src/sim/vitals';

const E = RULES.encounter;
const EARLY_FRAMES = 2;

export const STARTER_TEXT = genomeToBase64url(starterGenome());
export const TEST_POND = { seed: 'sync-pond', size: RULES.world.size };

/** An `enc-start` for two starters, `a` (player `pa`) at (x, y) and `b` (player `pb`) 30 wu east. */
export function startMsg(at = 10_000, x = 5200, y = 3000): EncStartMsg {
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
  });
  return {
    t: 'enc-start',
    enc: 'e1'.repeat(32),
    seed: '5eed'.repeat(16),
    round: 0,
    t0: 1000,
    at,
    fighters: [fighter('pa', 'a', x, 0), fighter('pb', 'b', x + 30, Math.PI)],
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
  private readonly inputs = new Map<number, (number | null)[]>();

  constructor(
    readonly start: EncounterStart,
    readonly at: number,
  ) {
    this.enc = createEncounter(start);
  }

  slotOf(player: string): number {
    return this.enc.fighters.findIndex((f) => f.player === player);
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
    const row = this.inputs.get(f) ?? this.enc.fighters.map(() => null);
    if (row[slot] === null) row[slot] = code;
    this.inputs.set(f, row);
  }

  /** The frames finalized by `now`, in order, each stepped on the referee's own encounter. */
  due(now: number): Extract<HubMsg, { t: 'enc-frame' }>[] {
    const out: Extract<HubMsg, { t: 'enc-frame' }>[] = [];
    while (!this.enc.over && this.next < E.timeoutFrames) {
      const f = this.next;
      const row = this.inputs.get(f) ?? this.enc.fighters.map(() => null);
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
