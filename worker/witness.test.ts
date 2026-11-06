import { describe, expect, it } from 'vitest';
import { PINNED_ORDER, pinnedOrder } from '../tests/witness-order-table';

// The witness order in workerd (ADR 0058): the authority must draw the order every witness and
// verifier draws from the same beacon, so the pinned case is checked in both pools.

describe('witnessOrder in workerd', () => {
  it('matches the pinned order that Node checks', () => {
    expect(PINNED_ORDER).toHaveLength(16);
    expect(pinnedOrder()).toEqual(PINNED_ORDER);
  });
});
