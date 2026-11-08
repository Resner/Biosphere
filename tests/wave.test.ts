import { describe, expect, it } from 'vitest';
import { GATE_KEYS, type RunResult } from './aoi-types';
import { heavyTest } from './heavy';
import { runWave, SCALED_WAVE, waveGates, waveScenario } from './wave';
import type { Arrival, WaveRecord } from './wave-record';

// The population wave (M12 T9): the gates of `docs/perf/wave.md` as tests. `npm run sim:wave` runs
// the full wave; the `heavyTest` here runs a scaled one against the same gates.

const arrival = (patch: Partial<Arrival> = {}): Arrival => ({
  id: 'p0',
  t: 0,
  ride: false,
  tier: 0,
  groupSize: 3,
  fallback: 'none',
  edgeClearances: 1.2,
  linkMs: 1500,
  groupLinkMs: 1500,
  ...patch,
});

/** A run that meets every gate, to break one at a time. */
function clean(patch: Partial<WaveRecord> = {}, run: Partial<RunResult> = {}): RunResult {
  const wave: WaveRecord = {
    params: {
      peakFrom: 0,
      peakUntil: 1,
      regroupFrom: 0,
      crowdsGoneAt: 0,
      holdFrom: 0,
      holdUntil: 60_000,
    },
    arrivals: [arrival(), arrival({ id: 'p1' })],
    rides: [],
    fights: [],
    minutes: [],
    regroup: [{ t: 0, eligible: 10, linked: 10 }],
    crowdsLeft: 0,
    peakSeconds: 100,
    peakCrowded: 0,
    holdPerMinute: [3, 4, 5],
    messageTotal: 100,
    lifeMinutes: 10,
    ...patch,
  };
  return {
    scenario: 'wave',
    seed: 't',
    seconds: 60,
    clients: 2,
    violations: Object.fromEntries(GATE_KEYS.map((k) => [k, 0])) as RunResult['violations'],
    examples: Object.fromEntries(GATE_KEYS.map((k) => [k, []])) as unknown as RunResult['examples'],
    perMinute: [3, 4, 5],
    joinMinute: [10],
    maxHeld: 20,
    spawns: 2,
    spawnFallbacks: 0,
    rides: 0,
    wave,
    ...run,
  } as RunResult;
}

const failing = (r: RunResult): number[] =>
  waveGates([r])
    .filter((g) => !g.ok)
    .map((g) => g.n);

describe('the wave gates', () => {
  it('pass a clean run', () => {
    expect(failing(clean())).toEqual([]);
  });

  it('fail the gate a run breaks and no other', () => {
    const base = clean();
    const v = (k: string): RunResult['violations'] => ({ ...base.violations, [k]: 1 });
    expect(failing(clean({}, { violations: v('clearance') }))).toEqual([1]);
    // Gate 2: the group link at the median, the p95, and a newcomer never linked.
    const slow = (ms: number | null) => [
      arrival({ groupLinkMs: ms }),
      arrival({ groupLinkMs: ms, id: 'p1' }),
    ];
    expect(failing(clean({ arrivals: slow(3500) }))).toEqual([2]);
    expect(failing(clean({ arrivals: slow(null) }))).toEqual([2]);
    expect(failing(clean({ arrivals: [arrival({ linkMs: 16_000 })] }))).toEqual([2]);
    // Gate 3: past the edge, or placed at the centre though a group was found.
    expect(failing(clean({ arrivals: [arrival({ edgeClearances: 3.1 })] }))).toEqual([3]);
    expect(failing(clean({ arrivals: [arrival({ fallback: 'centre-rings' })] }))).toEqual([3]);
    // Gate 4: the share of player-seconds linked, not the worst second.
    const seconds = (linked: number[]) =>
      linked.map((n, t) => ({ t: t * 1000, eligible: 10, linked: n }));
    expect(failing(clean({ regroup: seconds([10, 8, 10, 10, 10, 10, 10, 10, 10, 10]) }))).toEqual(
      [],
    );
    expect(failing(clean({ regroup: seconds([10, 6, 6, 6, 6, 10, 10, 10, 10, 10]) }))).toEqual([4]);
    expect(failing(clean({ regroup: [] }))).toEqual([4]);
    // Gate 5: crowded at the peak, over the cap, or a crowd left.
    expect(failing(clean({ peakCrowded: 2 }))).toEqual([5]);
    expect(failing(clean({}, { maxHeld: 33 }))).toEqual([5]);
    expect(failing(clean({ crowdsLeft: 1 }))).toEqual([5]);
    expect(failing(clean({}, { violations: v('hidden') }))).toEqual([6]);
    // Gate 7: instance changes in a fight, a ride by a fighter within 120 s of its fight.
    expect(failing(clean({}, { violations: v('fightWater') }))).toEqual([7]);
    const fight = { fighters: ['p0', 'p1'], from: 10_000, until: 40_000 };
    expect(failing(clean({ fights: [fight], rides: [{ id: 'p0', t: 150_000 }] }))).toEqual([7]);
    expect(failing(clean({ fights: [fight], rides: [{ id: 'p0', t: 161_000 }] }))).toEqual([]);
    expect(failing(clean({ fights: [fight], rides: [{ id: 'p2', t: 50_000 }] }))).toEqual([]);
    // Gate 8: the hold's median and p95, and the whole wave's mean.
    expect(failing(clean({ holdPerMinute: [7, 7, 7] }))).toEqual([8]);
    expect(failing(clean({ holdPerMinute: [...Array.from({ length: 19 }, () => 1), 13] }))).toEqual(
      [8],
    );
    expect(failing(clean({ messageTotal: 250 }))).toEqual([8]);
    expect(failing(clean({ holdPerMinute: [] }))).toEqual([8]);
  });
});

describe('the wave scenario', () => {
  it('has the shape of the spec: 5 → 300 → 20, fights every minute of the peak', () => {
    const sc = waveScenario('shape');
    expect(sc.clients).toHaveLength(300);
    const spawns = sc.clients.map((c) => c.spawnAt);
    expect(spawns.filter((t) => t < 120_000)).toHaveLength(5);
    expect(Math.max(...spawns)).toBeLessThanOrEqual(12 * 60_000);
    expect(sc.clients.every((c) => c.place)).toBe(true);
    const leaving = sc.clients.filter((c) => c.leaveAt !== undefined);
    expect(leaving).toHaveLength(280);
    for (const c of leaving) {
      expect(c.leaveAt).toBeGreaterThanOrEqual(14 * 60_000);
      expect(c.leaveAt).toBeLessThan(18 * 60_000);
    }
    expect(sc.seconds).toBe(24 * 60);
    const t1 = sc.clients.filter((c) => c.r >= 32).length;
    expect(t1).toBeGreaterThan(10);
    expect(t1).toBeLessThan(60);
    expect(sc.fights).toHaveLength(18);
    expect(new Set(sc.fights?.map((f) => f.from)).size).toBe(6);
    expect(sc).toEqual(waveScenario('shape'));
  });
});

heavyTest('a scaled wave (5 → 60 → 10 over 8 minutes) meets the same gates', () => {
  const run = runWave('scaled', SCALED_WAVE);
  const failed = waveGates([run]).filter((g) => !g.ok);
  expect(failed.map((g) => `gate ${g.n} ${g.name}: ${g.detail}`)).toEqual([]);
  expect(run.wave?.arrivals.length).toBeGreaterThanOrEqual(60);
  expect(run.wave?.fights.length).toBeGreaterThan(0);
});
