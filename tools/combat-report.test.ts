import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { STARTER_COMBAT, STARTER_PHYS } from '../src/sim/body';
import { RULES_VERSION } from '../src/sim/rules';
import { ARCHETYPE_NAMES, duel, type Side } from '../tests/combat-tournament';
import { CALM } from '../tests/encounter-fixture';
import { heavyTest } from '../tests/heavy';
import {
  combatReport,
  GATE,
  gateLines,
  type Measured,
  measure,
  reportBody,
  reportHash,
} from './combat-report';

/**
 * The report's hash per rules version (its body, without the closing hash line). A change to the
 * rules or the tournament changes it: regenerate `docs/perf/combat.md` with `npm run report:combat`
 * and pin the new hash here, together with the gate holding.
 */
const PINNED: Record<number, string> = { 9: '49b2cacd16ab16fb' };

let measured: Measured | null = null;
const once = (): Measured => {
  measured ??= measure();
  return measured;
};

const starter = (biomass: number): Side => ({
  body: { phys: STARTER_PHYS, combat: STARTER_COMBAT, behaviour: CALM },
  biomass,
});

describe('combat tournament', () => {
  it('replays the same duel for the same layout', () => {
    const a = starter(300);
    const b = starter(300);
    expect(duel(a, b, 3)).toEqual(duel(a, b, 3));
  });

  it('puts the first side on either end of the line', () => {
    const a = starter(300);
    const b = starter(450);
    const one = duel(a, b, 1, false);
    const two = duel(a, b, 1, true);
    expect(one.seconds).toBeGreaterThan(0);
    expect(two.seconds).toBeGreaterThan(0);
    expect([0, 0.5, 1]).toContain(one.score);
  });

  it('runs the eleven archetypes', () => {
    expect(ARCHETYPE_NAMES).toHaveLength(11);
  });
});

describe('combat gate (ADR 0051)', () => {
  heavyTest('every line of the tuning gate holds', () => {
    const m = once();
    for (const g of gateLines(m)) expect(g.ok, `${g.line}: ${g.value}`).toBe(true);
  });

  heavyTest('the win matrix is mirrored: a pair splits its duels', () => {
    const m = once();
    for (const [i, row] of m.matrix.entries()) {
      for (const [j, v] of row.entries()) {
        if (i === j) expect(v).toBe(0.5);
        else expect(v + (m.matrix[j]?.[i] as number)).toBeCloseTo(1, 9);
      }
    }
  });

  heavyTest('the report is pinned per rules version and reproduces docs/perf/combat.md', () => {
    const m = once();
    const body = reportBody(m);
    expect(
      PINNED[RULES_VERSION],
      `pin the hash ${reportHash(body)} for rules v${RULES_VERSION}`,
    ).toBe(reportHash(body));
    const doc = readFileSync(new URL('../docs/perf/combat.md', import.meta.url), 'utf8');
    expect(doc).toBe(combatReport(m));
  });
});
