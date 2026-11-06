import { describe, expect, it } from 'vitest';
import {
  cost,
  DELAYS_S,
  DUEL_CUT,
  modelOfMeasure,
  SCENARIOS,
  SPAN_CUT,
  total as sum,
  type WitnessMeasure,
  witnessReport,
} from './witness-report';

// What `worker/witness-cost.test.ts` printed for a 30 s hunt (its `WITNESS_MEASURE` line).
const measured: WitnessMeasure = {
  frames: 299,
  from: 33,
  before: { input: 66, signal: 4, 'duty-ok': 1 },
  span: { batch: 27 },
  after: { 'duty-ok': 1, attest: 1 },
  aloneBefore: { input: 66 },
  aloneSpan: { input: 532 },
  handoverMs: 3000,
  batchMs: 5,
};

describe('the witness cost model', () => {
  it('agrees with what the hub counted', () => {
    const c = modelOfMeasure(measured);
    expect(c.handFrom).toBe(measured.from);
    expect(c.batches).toBe(measured.span.batch);
    expect(c.witnessed).toBe(sum(measured.before) + sum(measured.span) + sum(measured.after));
    expect(c.alone).toBe(sum(measured.aloneBefore) + sum(measured.aloneSpan));
  });

  it('cuts a 30 s duel at least 4 times and the span at least 10 times per participant-second', () => {
    for (const d of DELAYS_S) {
      const c = cost(30, 2, d);
      expect(c.alone / c.witnessed, `delay ${d} s`).toBeGreaterThanOrEqual(DUEL_CUT);
      // Per participant-second: 10 inputs a second each against one batch a second shared.
      expect((2 * c.span) / c.batches).toBeGreaterThanOrEqual(SPAN_CUT);
    }
  });

  it('saves nothing when the fight is over before the handover, and more with more fighters', () => {
    expect(cost(2, 2, 3)).toMatchObject({ alone: 40, witnessed: 40, batches: 0 });
    const duel = cost(30, 2, 3);
    const melee = cost(30, 4, 3);
    expect(melee.alone / melee.witnessed).toBeGreaterThan(duel.alone / duel.witnessed);
  });

  it('puts the median genesis duel near the ADR’s 2.5–3.5 times at its likeliest delay', () => {
    const c = cost(10.4, 2, 3);
    expect(c.alone / c.witnessed).toBeGreaterThan(2.4);
    expect(c.alone / c.witnessed).toBeLessThan(3.6);
  });
});

describe('the witness report', () => {
  it('lists every scenario and delay, and is the same text twice', () => {
    const text = witnessReport(measured);
    for (const s of SCENARIOS) expect(text).toContain(s.name);
    for (const d of DELAYS_S) expect(text).toContain(`Cut (${d} s)`);
    expect(text).toContain('at most 5 ms per batch');
    expect(witnessReport({ ...measured, frames: 300, aloneSpan: { input: 534 } })).toBe(text);
  });
});
