import { describe, expect, it } from 'vitest';
import { CENTRE, runScenario } from './aoi-harness';
import {
  type Gate,
  gatesOf,
  makeScenario,
  pct,
  type ScenarioName,
  type ScenarioOptions,
  sum,
} from './aoi-scenarios';
import type { RunResult, Scenario } from './aoi-types';
import { heavyTest } from './heavy';

// The headless area-of-interest harness (M11 T10, ADR 0062): the gates of `docs/perf/aoi.md` as
// tests. Each gate is judged over the runs of its scenario; a broken gate names what broke.

function runs(name: ScenarioName, seeds: number, opts: ScenarioOptions = {}): RunResult[] {
  return Array.from({ length: seeds }, (_, i) =>
    runScenario(makeScenario(name, `t${i}`, opts), `t${i}`),
  );
}

function failed(gates: Gate[]): string[] {
  return gates.filter((g) => !g.ok).map((g) => `gate ${g.n} ${g.name}: ${g.detail}`);
}

describe('the harness', () => {
  it('is deterministic: a scenario and a seed give the same run', () => {
    const a = runScenario(makeScenario('friends', 'x'), 'x');
    const b = runScenario(makeScenario('friends', 'x'), 'x');
    const c = runScenario(makeScenario('friends', 'y'), 'y');
    expect(b).toEqual(a);
    expect(c.friendMs).not.toEqual(a.friendMs);
  });

  it('judges each gate: a run that breaks one fails that gate and no other', () => {
    const base = runScenario(makeScenario('friends', 'g'), 'g');
    expect(failed(gatesOf([base]))).toEqual([]);
    const broken = (patch: Partial<RunResult>, gate: number) => {
      const bad = { ...base, ...patch } as RunResult;
      expect(
        gatesOf([bad])
          .filter((g) => !g.ok)
          .map((g) => g.n),
      ).toEqual([gate]);
    };
    broken({ violations: { ...base.violations, cap: 1 } }, 1);
    broken({ violations: { ...base.violations, hidden: 1 } }, 2);
    broken({ violations: { ...base.violations, pops: 1 } }, 3);
    broken({ violations: { ...base.violations, late: 1 } }, 3);
    broken({ friendMs: [...base.friendMs, ...Array.from({ length: 5 }, () => 9000)] }, 4);
    broken({ perMinute: Array.from({ length: 20 }, () => 13) }, 5);
    broken({ gossipBytes: base.linkSeconds * 400 }, 6);
    broken({ violations: { ...base.violations, tierLink: 1 } }, 7);
    broken({ violations: { ...base.violations, swarm: 1 } }, 7);
    broken({ violations: { ...base.violations, duty: 1 }, duties: 3 }, 8);
    broken({ linkUpload: 5000 }, 9);
    broken({ upload24: 13_000, upload24Sum: 13_000, upload24Samples: 1 }, 9);
  });

  it('links friends who spawn on the ring, with their directory, gossip and hello all in play', () => {
    const [run] = runs('friends', 1);
    const r = run as RunResult;
    expect(r.friendMs).toHaveLength(15);
    expect(r.maxHeld).toBeLessThanOrEqual(5);
    expect(r.gossipBytes).toBeGreaterThan(0);
  });
});

// Scenarios at normal speed, a few seeds each: the report's rows.
const SCENARIOS: [ScenarioName, number][] = [
  ['friends', 10],
  ['crowd', 3],
  ['tiers', 3],
  ['witnesses', 3],
];

describe('the scenarios', () => {
  for (const [name, seeds] of SCENARIOS) {
    heavyTest(`${name} meets its gates over ${seeds} seeds`, () => {
      const rs = runs(name, seeds);
      expect(failed(gatesOf(rs))).toEqual([]);
    });
  }

  heavyTest(
    'the tiers scenario exercises swarms, the cross-tier rule and a creature growing a tier',
    () => {
      const rs = runs('tiers', 2);
      for (const r of rs) {
        expect(r.maxHeld).toBeGreaterThan(5);
        expect(r.entries).toBeGreaterThan(10);
      }
    },
  );

  heavyTest(
    'witnesses are linked to their fighters across 20,000 wu, and the cap holds with the duties',
    () => {
      const rs = runs('witnesses', 3);
      for (const r of rs) {
        expect(r.duties).toBe(6);
        expect(r.dutiesTaken).toBe(6);
        expect(r.maxHeld).toBeLessThanOrEqual(32);
      }
    },
  );
});

// The property test: 50 seeded runs of the open-world scenarios at twice the speed, in three tests
// so that each has its own timeout.
describe('the property test', () => {
  const fast = { speed: 2 };
  const groups: [ScenarioName, number, ScenarioOptions][] = [
    ['sparse', 20, { ...fast, scale: 0.2 }],
    ['streams', 20, fast],
    ['traveller', 10, { ...fast, scale: 0.25 }],
  ];
  for (const [name, seeds, opts] of groups) {
    heavyTest(`${seeds} seeded runs of ${name} at twice the speed meet every gate`, () => {
      const rs = runs(name, seeds, opts);
      expect(rs).toHaveLength(seeds);
      expect(failed(gatesOf(rs))).toEqual([]);
      // Not vacuous: creatures came into view, and the budget had minutes to judge.
      expect(sum(rs, (r) => r.entries)).toBeGreaterThan(name === 'traveller' ? 20 : 100);
      if (name === 'sparse') {
        expect(sum(rs, (r) => r.lateLinks)).toBeGreaterThan(100);
        expect(
          pct(
            rs.flatMap((r) => r.discoveryMs),
            0.95,
          ),
        ).toBeLessThan(10_000);
      }
    });
  }
});

describe('a pile of creatures', () => {
  // 60 comparable creatures inside 700 wu: each has 59 P1, so everyone is crowded (past 32).
  const pile: Scenario = {
    name: 'pile',
    seconds: 45,
    clients: Array.from({ length: 60 }, (_, i) => ({
      id: `p${i}`,
      x: CENTRE + ((i * 37) % 600) - 300,
      y: CENTRE + ((i * 91) % 600) - 300,
      r: 20,
      adultR: 20,
      spawnAt: (i % 10) * 500,
      walk: {
        heading: i,
        speed: 60,
        turn: 1,
        dash: false,
        box: { x0: CENTRE - 350, y0: CENTRE - 350, x1: CENTRE + 350, y1: CENTRE + 350 },
      },
    })),
  };

  heavyTest('never holds more than 32 links, and says it is crowded', () => {
    const r = runScenario(pile, 'pile');
    expect(r.maxHeld).toBeLessThanOrEqual(32);
    expect(r.violations.cap).toBe(0);
    expect(r.crowdedSeconds / r.clientSeconds).toBeGreaterThan(0.5);
  });
});
