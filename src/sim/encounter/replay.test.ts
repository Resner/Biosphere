import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { depthAt } from '../bathymetry';
import { plumesNear } from '../hazards';
import { RULES, RULES_VERSION } from '../rules';
import { createWorld } from '../world';
import { drive, IDLE_CODE, starterFighter, startOf } from './fixture';
import { type EncounterLog, replayEncounter } from './replay';

interface Golden {
  log: EncounterLog;
  hash: string;
  results: ReturnType<typeof replayEncounter>['results'];
}

const NAMES = ['encounter-approach', 'encounter-escape', 'encounter-plume'] as const;
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
  return { 'encounter-approach': approach, 'encounter-escape': fleeing, 'encounter-plume': plume };
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
    const approach = load('encounter-approach');
    expect(approach.results.map((r) => r.outcome)).toEqual(['stood', 'stood']);
    expect(approach.results[0]?.frame).toBe(approach.log.frames.length);
  });

  it('refuses a log from other rules', () => {
    const golden = load('encounter-approach');
    expect(() => replayEncounter({ ...golden.log, rules: RULES_VERSION - 1 })).toThrow();
    expect(RULES.encounter.frameTicks).toBe(3);
  });
});
