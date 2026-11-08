import { describe, expect, it } from 'vitest';
import { createRng, seedFromString } from '../src/sim/prng';
import { Meter } from './aoi-meter';
import { GATE_KEYS, type RunResult } from './aoi-types';
import { heavyTest } from './heavy';
import {
  boxFor,
  FULL_LOAD,
  loadGates,
  loadPlayers,
  loadScenario,
  runLoad,
  SCALED_LOAD,
} from './load';
import { emptyWave } from './wave-record';

// The load scenario (M13 T5): its players and the gates of `docs/perf/load.md` as tests. `npm run
// sim:load` runs 10,000 players; the `heavyTest` here runs 500 against the same gates.

const MIN = 60_000;

describe('the players of a load run', () => {
  const shape = { ...FULL_LOAD, players: 2000, boxHalf: 50_000 };
  const players = loadPlayers(createRng(seedFromString('layout7'), 'layout'), shape);

  it('fills evenly: 10 in the first minute, the rest by minute 10', () => {
    const first = players.filter((p) => p.spawnAt < MIN);
    expect(first.length).toBe(10);
    const fill = players.filter((p) => p.spawnAt < shape.holdFrom);
    expect(fill.length).toBe(2000);
    expect(Math.max(...fill.map((p) => p.spawnAt))).toBeLessThanOrEqual(shape.fillUntil);
  });

  it('holds the population: every leaver in the hold is replaced at once', () => {
    const live = (t: number) =>
      players.filter((p) => p.spawnAt <= t && (p.leaveAt === undefined || p.leaveAt > t)).length;
    for (const t of [10 * MIN + 1, 12 * MIN, 15 * MIN, 15.99 * MIN]) {
      expect(Math.abs(live(t) - 2000)).toBeLessThanOrEqual(1);
    }
    const joins = players.filter((p) => p.spawnAt >= shape.holdFrom);
    for (const j of joins) expect(j.spawnAt).toBeLessThan(shape.holdUntil);
  });

  it('leaves at the rate of a 30-minute mean session', () => {
    // 2,000 players for 6 minutes at a 30-minute mean: 400 leave, within sampling error.
    const left = players.filter((p) => p.leaveAt !== undefined && p.leaveAt < shape.holdUntil);
    expect(left.length).toBeGreaterThan(300);
    expect(left.length).toBeLessThan(500);
  });

  it('draws 90% starters, 9% T1 and 1% T2, the larger ones at an ancestor size', () => {
    const tier = (r: number) => (r < 32 ? 0 : r < 128 ? 1 : 2);
    const count = [0, 0, 0];
    for (const p of players) count[tier(p.r)] = (count[tier(p.r)] as number) + 1;
    const n = players.length;
    expect((count[0] as number) / n).toBeGreaterThan(0.87);
    expect((count[1] as number) / n).toBeGreaterThan(0.06);
    expect((count[1] as number) / n).toBeLessThan(0.12);
    expect(count[2]).toBeGreaterThan(0);
    for (const p of players) expect(p.adultR).toBe(p.r);
  });

  it('is the same for the same seed', () => {
    const again = loadPlayers(createRng(seedFromString('layout7'), 'layout'), shape);
    expect(again).toEqual(players);
  });

  it('puts one fight in 100 players in each minute of the hold', () => {
    const sc = loadScenario('t', { ...FULL_LOAD, players: 1000, boxHalf: 50_000 });
    const starts = new Set((sc.fights ?? []).map((f) => f.from));
    expect(starts.size).toBe(6);
    for (const from of starts) {
      expect((sc.fights ?? []).filter((f) => f.from === from).length).toBe(10);
    }
  });
});

/** A run that meets every gate, to break one at a time. */
function clean(): RunResult {
  const wave = emptyWave({
    peakFrom: 0,
    peakUntil: 1,
    regroupFrom: 0,
    crowdsGoneAt: 0,
    holdFrom: 0,
    holdUntil: 60_000,
  });
  wave.holdSteady = [3, 4, 5, 6, 5];
  wave.holdJoin = [20, 30];
  wave.holdMessages = 400;
  wave.holdMinutes = 100;
  wave.arrivals = [
    {
      id: 'p0',
      t: 0,
      ride: false,
      tier: 0,
      groupSize: 3,
      fallback: 'none',
      edgeClearances: 1,
      linkMs: 1500,
      groupLinkMs: 1500,
    },
  ];
  wave.fights = [{ fighters: ['a', 'b'], from: 0, until: 1 }];
  return {
    scenario: 'load',
    seed: 't',
    seconds: 60,
    clients: 2,
    violations: Object.fromEntries(GATE_KEYS.map((k) => [k, 0])) as RunResult['violations'],
    examples: Object.fromEntries(GATE_KEYS.map((k) => [k, []])) as unknown as RunResult['examples'],
    maxHeld: 20,
    spawns: 1,
    spawnFallbacks: 0,
    crowdedLate: 0,
    clientLate: 1000,
    wave,
  } as RunResult;
}

describe('the load gates', () => {
  const failing = (run: RunResult) =>
    loadGates(run)
      .filter((g) => !g.ok)
      .map((g) => g.n);

  it('pass a clean run', () => expect(failing(clean())).toEqual([]));

  it('fail the budget on the median, the p95, a joiner and the mean', () => {
    const median = clean();
    (median.wave as NonNullable<RunResult['wave']>).holdSteady = [7, 7, 7, 7, 7];
    expect(failing(median)).toEqual([1]);
    const tail = clean();
    (tail.wave as NonNullable<RunResult['wave']>).holdSteady = [1, 1, 1, 1, 1, 1, 1, 1, 1, 13];
    expect(failing(tail)).toEqual([1]);
    const joiner = clean();
    (joiner.wave as NonNullable<RunResult['wave']>).holdJoin = [101, 101];
    expect(failing(joiner)).toEqual([1]);
    const mean = clean();
    (mean.wave as NonNullable<RunResult['wave']>).holdMessages = 1300;
    expect(failing(mean)).toEqual([1]);
  });

  it('fail placement on a violation, a fall back and a spawn too far from its group', () => {
    const clearance = clean();
    clearance.violations.clearance = 1;
    expect(failing(clearance)).toEqual([2]);
    const fallback = clean();
    fallback.spawnFallbacks = 1;
    expect(failing(fallback)).toEqual([2]);
    const far = clean();
    (
      (far.wave as NonNullable<RunResult['wave']>).arrivals[0] as { edgeClearances: number }
    ).edgeClearances = 3.5;
    expect(failing(far)).toEqual([2]);
  });

  it('fail together on a slow link and on one never made', () => {
    const slow = clean();
    (
      (slow.wave as NonNullable<RunResult['wave']>).arrivals[0] as { groupLinkMs: number | null }
    ).groupLinkMs = 3500;
    expect(failing(slow)).toEqual([3]);
    const never = clean();
    (
      (never.wave as NonNullable<RunResult['wave']>).arrivals[0] as { groupLinkMs: number | null }
    ).groupLinkMs = null;
    expect(failing(never)).toEqual([3]);
  });

  it('fail bounded on 33 links and on a crowded share over 1%', () => {
    const links = clean();
    links.maxHeld = 33;
    expect(failing(links)).toEqual([4]);
    const crowded = clean();
    crowded.crowdedLate = 11;
    expect(failing(crowded)).toEqual([4]);
  });

  it('fail on a hidden creature and on a fight that changed water', () => {
    const hidden = clean();
    hidden.violations.hidden = 1;
    expect(failing(hidden)).toEqual([5]);
    const water = clean();
    water.violations.fightWater = 1;
    expect(failing(water)).toEqual([6]);
  });
});

describe('the scaled load run', () => {
  heavyTest('100 players, filled in three minutes and held for six, pass every gate', () => {
    const meter = new Meter();
    const run = runLoad('scaled', SCALED_LOAD, meter);
    const gates = loadGates(run);
    for (const g of gates) expect(g.ok, `${g.n}. ${g.name}: ${g.detail}`).toBe(true);
    // The meter saw every kind of work the report prints.
    expect(meter.ops.where.length).toBeGreaterThan(0);
    expect(meter.ops.place.length).toBeGreaterThan(0);
    expect(meter.ops.signal.length).toBeGreaterThan(0);
    expect(meter.ops.pool.length).toBeGreaterThan(0);
    expect(meter.msgs.spawn).toBeGreaterThan(0);
    expect(meter.msgs.gone).toBeGreaterThan(0);
    expect(meter.setups).toBeGreaterThan(0);
    expect(meter.heapBytes).not.toBeNull();
  });

  heavyTest('the same seed gives the same counters', () => {
    const shape = {
      ...SCALED_LOAD,
      players: 60,
      boxHalf: boxFor(60),
      fillUntil: MIN,
      holdFrom: MIN,
      holdUntil: 2 * MIN,
    };
    const a = runLoad('same', shape, new Meter());
    const b = runLoad('same', shape, new Meter());
    expect(b.wave?.holdSteady).toEqual(a.wave?.holdSteady);
    expect(b.spawns).toBe(a.spawns);
    expect(b.violations).toEqual(a.violations);
  });
});
