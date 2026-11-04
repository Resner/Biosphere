import { describe, expect, it } from 'vitest';
import golden from '../src/ledger/__golden__/growth-reach.json';
import { reachTable } from '../tests/growth-reach-table';

// The growth reach in workerd (ADR 0055): the authority's clamp must draw the same line as a
// verifier in Node or a browser, so the pinned table is checked in both pools.

describe('growthReach in workerd', () => {
  it('matches the pinned table of 64 values that Node checks', () => {
    expect(golden.table).toHaveLength(64);
    expect(reachTable()).toEqual(golden.table);
  });
});
