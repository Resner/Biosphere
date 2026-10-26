import { readFileSync, writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  report,
  runTournament,
  SCENARIOS,
  type Scenario,
  type Tournament,
} from '../../tests/tournament';
import { RULES_VERSION } from '../sim/rules';

// Four sim scenarios, six archetypes, eight seeds each (M3 T17): no build is best at everything.
// The forage scenario takes about 12 s; the other three together under 4 s.
describe('archetype tournament', () => {
  let t: Tournament;
  beforeAll(() => {
    t = runTournament();
    if (process.env.TOURNAMENT_REPORT === '1') console.log(report(t));
  }, 120_000);

  const wins = (a: string): number => SCENARIOS.filter((sc) => t.winners[sc] === a).length;
  const topTwo = (a: string): number =>
    SCENARIOS.filter((sc) => t.ranking[sc].slice(0, 2).includes(a)).length;

  it('ranks every body in every scenario with a finite score', () => {
    for (const a of t.archetypes)
      for (const sc of SCENARIOS) expect(Number.isFinite(t.means[a]?.[sc])).toBe(true);
  });

  it('gives each scenario its own ranking', () => {
    const orders = SCENARIOS.map((sc) => t.ranking[sc].join('>'));
    expect(new Set(orders).size).toBe(SCENARIOS.length);
  });

  it('lets no archetype win more than 2 of the 4 scenarios', () => {
    for (const a of t.archetypes) expect(wins(a), a).toBeLessThanOrEqual(2);
  });

  it('lets every archetype win one scenario or place first or second in two', () => {
    for (const a of t.archetypes) expect(wins(a) >= 1 || topTwo(a) >= 2, a).toBe(true);
  });

  it('is deterministic: a second run of the quick scenarios gives the same hash', {
    timeout: 30_000,
  }, () => {
    const quick: Scenario[] = ['sprint', 'cruise'];
    expect(runTournament(quick).hash).toBe(runTournament(quick).hash);
  });

  it('keeps the summary hash frozen per rules version', () => {
    const file = new URL('./__golden__/tournament.json', import.meta.url);
    if (process.env.UPDATE_GOLDENS === '1') {
      writeFileSync(
        file,
        `${JSON.stringify({ rulesVersion: RULES_VERSION, hash: t.hash, ranking: t.ranking }, null, 2)}\n`,
      );
    }
    const golden = JSON.parse(readFileSync(file, 'utf8')) as {
      rulesVersion: number;
      hash: string;
      ranking: Tournament['ranking'];
    };
    expect(golden.rulesVersion).toBe(RULES_VERSION);
    expect(t.ranking).toEqual(golden.ranking);
    expect(t.hash).toBe(golden.hash);
  });
});
