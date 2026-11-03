import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  drive,
  hunterFighter,
  IDLE_CODE,
  starterFighter,
  startOf,
} from '../../../tests/encounter-fixture';
import { depthAt } from '../bathymetry';
import { plumesNear } from '../hazards';
import { RULES, RULES_VERSION } from '../rules';
import { createWorld } from '../world';
import { type EncounterLog, replayEncounter } from './replay';

interface Golden {
  log: EncounterLog;
  hash: string;
  results: ReturnType<typeof replayEncounter>['results'];
}

const NAMES = [
  'encounter-approach',
  'encounter-escape',
  'encounter-plume',
  'encounter-duel',
  'encounter-egg',
  'encounter-autopilot',
] as const;
const file = (name: string) => new URL(`./../__golden__/${name}.json`, import.meta.url);

const log = (start: EncounterLog['start'], frames: EncounterLog['frames']): EncounterLog => ({
  rules: RULES_VERSION,
  start,
  frames,
});

function build(): Record<(typeof NAMES)[number], EncounterLog> {
  // Two starters 80 wu apart swim at each other for 6 s, bump and slide past.
  const approach = log(
    startOf('golden-approach', [
      starterFighter('a', 5200, 3000),
      starterFighter('b', 5280, 3000, Math.PI),
    ]),
    Array.from({ length: 24 }, (_, f) =>
      f < 20 ? [drive(0, 15, { dash: f === 2 }), drive(128, 12)] : [IDLE_CODE, IDLE_CODE],
    ),
  );
  // One flees west at full throttle and escapes; the other idles.
  const fleeing = log(
    startOf('golden-escape', [
      starterFighter('a', 5200, 3000),
      starterFighter('b', 5230, 3000, Math.PI),
    ]),
    Array.from({ length: 80 }, () => [drive(128, 15, { stance: 'evasive' }), IDLE_CODE]),
  );
  // A fighter with 3 hp swims east into a seeded plume, in water mild enough to meet only the toxin.
  const probe = createWorld({ seed: 'golden-plume' });
  probe.tick = 1000;
  const mild = (x: number, y: number): boolean => {
    const depth = depthAt(probe.seed32, x, y);
    return depth > 0.3 && depth < 0.65;
  };
  const found = plumesNear(probe, 4096, 4096, 8192).find(
    (p) => p.x - p.radius > 300 && mild(p.x, p.y) && mild(p.x - p.radius - 40, p.y),
  );
  if (found === undefined) throw new Error('golden-plume has no plume');
  const x = Math.round(found.x - found.radius - 40);
  const y = Math.round(found.y);
  const plume = log(
    startOf('golden-plume', [
      { ...starterFighter('a', x, y), health: 3 },
      starterFighter('b', x - 300, y),
    ]),
    Array.from({ length: 40 }, (_, f) => [drive(0, 15, { dash: f === 1 }), IDLE_CODE]),
  );
  // A hunter closes on a starter that braces once and then drifts: it is bitten to death.
  const duel = log(
    startOf('golden-duel', [
      hunterFighter('a', 5200, 3000),
      starterFighter('b', 5242, 3000, Math.PI),
    ]),
    Array.from({ length: 60 }, (_, f) => [
      drive(0, 15, { stance: 'aggressive', dash: f === 4 }),
      drive(128, 0, { brace: f === 1 }),
    ]),
  );
  // A hunter nips the egg trailing a drifting starter until it is eaten (target 5 is slot 1's egg).
  const eggStart = startOf('golden-egg', [
    hunterFighter('a', 5200, 3000),
    { ...starterFighter('b', 5200 + 3.5 * Math.sqrt(RULES.starter.biomass), 3000), egg: true },
  ]);
  const egg = log(
    eggStart,
    Array.from({ length: 60 }, (_, f) => [
      drive(0, f < 4 ? 3 : 0, { target: 5 }),
      drive(0, f < 10 ? 3 : 0),
    ]),
  );
  // Three fighters, one carrying an egg, all on the autopilot (every input is the fallback marker).
  const pilots = log(
    startOf('golden-autopilot', [
      {
        ...hunterFighter('a', 5200, 3000),
        behaviour: {
          aggression: 0.9,
          caution: 0.2,
          curiosity: 0.8,
          reflex: 0.6,
          targetPref: 'nearest',
        },
      },
      {
        ...hunterFighter('b', 5330, 3000, Math.PI),
        egg: true,
        behaviour: {
          aggression: 0.4,
          caution: 0.8,
          curiosity: 0.3,
          reflex: 0.9,
          targetPref: 'weakest',
        },
      },
      {
        ...starterFighter('c', 5260, 3150, -Math.PI / 2),
        behaviour: {
          aggression: 0.7,
          caution: 0.1,
          curiosity: 0.5,
          reflex: 0.5,
          targetPref: 'largest',
        },
      },
    ]),
    Array.from({ length: 200 }, () => [null, null, null]),
  );
  return {
    'encounter-autopilot': pilots,
    'encounter-egg': egg,
    'encounter-approach': approach,
    'encounter-escape': fleeing,
    'encounter-plume': plume,
    'encounter-duel': duel,
  };
}

function regenerate(): void {
  for (const [name, l] of Object.entries(build())) {
    const { hash, results } = replayEncounter(l);
    writeFileSync(file(name), `${JSON.stringify({ log: l, hash, results }, null, 1)}\n`);
  }
}

const load = (name: string): Golden => JSON.parse(readFileSync(file(name), 'utf8')) as Golden;

describe('encounter goldens', () => {
  if (process.env.UPDATE_GOLDENS) regenerate();

  it('are for the current rules', () => {
    for (const name of NAMES) expect(load(name).log.rules).toBe(RULES_VERSION);
  });

  for (const name of NAMES) {
    it(`${name} replays to its stored hash twice`, () => {
      const golden = load(name);
      const first = replayEncounter(golden.log);
      expect(first.hash).toBe(golden.hash);
      expect(first.results).toEqual(golden.results);
      expect(replayEncounter(golden.log)).toEqual(first);
    });
  }

  it('the scenarios do what their names promise', () => {
    expect(load('encounter-escape').results.map((r) => r.outcome)).toEqual(['escaped', 'stood']);
    const [a] = load('encounter-plume').results;
    expect(a).toMatchObject({ outcome: 'died', cause: 'toxin' });
    const duelResults = load('encounter-duel').results;
    expect(duelResults.map((r) => r.outcome)).toEqual(['stood', 'killed']);
    expect(duelResults[1]).toMatchObject({ cause: 'killed', by: 0 });
    expect(load('encounter-egg').results[1]).toMatchObject({ egg: 'eaten', eggBy: 0 });
    const pilots = load('encounter-autopilot');
    expect(pilots.log.frames.every((f) => f.every((c) => c === null))).toBe(true);
    expect(pilots.results.some((r) => r.outcome === 'killed' || r.egg === 'eaten')).toBe(true);
    const approach = load('encounter-approach');
    expect(approach.results.map((r) => r.outcome)).toEqual(['stood', 'stood']);
    expect(approach.results[0]?.frame).toBe(approach.log.frames.length);
  });

  it('refuses a log from other rules', () => {
    const golden = load('encounter-approach');
    expect(() => replayEncounter({ ...golden.log, rules: RULES_VERSION - 1 })).toThrow();
  });
});
