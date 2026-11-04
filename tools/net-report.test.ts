import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RULES_VERSION } from '../src/sim/rules';
import { heavyTest } from '../tests/heavy';
import {
  type Cell,
  GRID,
  measure,
  netReport,
  onTimeShare,
  reportBody,
  reportHash,
} from './net-report';

/**
 * The report's hash per rules version (its body, without the closing hash line). A change to the
 * rules, the harness or the lead's constants changes it: regenerate `docs/perf/netcode.md` with
 * `npm run report:net` and pin the new hash here.
 */
const PINNED: Record<number, string> = { 10: 'bffbaf49be91d5de' };

let measured: Cell[] | null = null;
const once = (): Cell[] => {
  measured ??= measure();
  return measured;
};

describe('netcode report', () => {
  it('has one row per grid cell', () => {
    expect(Object.values(GRID).reduce((k, axis) => k * axis.length, 1)).toBe(108);
  });

  heavyTest('every cell ends on the referee’s hash, and a good link is on time', () => {
    for (const c of once()) {
      const cell = `${c.oneWayMs}/${c.jitterMs}/${c.loss}/${c.clockErrMs}`;
      expect(c.result.converged, cell).toBe(true);
      if (c.oneWayMs <= 150 && c.jitterMs <= 30 && c.loss === 0 && c.clockErrMs <= 20) {
        expect(onTimeShare(c.result), cell).toBeGreaterThanOrEqual(0.95);
      }
    }
  });

  heavyTest('the report is pinned per rules version and reproduces docs/perf/netcode.md', () => {
    const cells = once();
    const body = reportBody(cells);
    expect(
      PINNED[RULES_VERSION],
      `pin the hash ${reportHash(body)} for rules v${RULES_VERSION}`,
    ).toBe(reportHash(body));
    const doc = readFileSync(new URL('../docs/perf/netcode.md', import.meta.url), 'utf8');
    expect(doc).toBe(netReport(cells));
  });
});
