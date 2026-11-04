import type { BundleIndex, Problem, VerifyOptions } from './verify';

// The origin family of `verifyLineage` (ADR 0055): each held creature's genesis or birth recomputed
// from its committed beacon and its parents, the commitments' timing, and the lineage graph. M9 T4.

export function verifyOrigin(_index: BundleIndex, _opts: VerifyOptions): Problem[] {
  return [];
}

/** How far back the checked graph reaches: whether every ancestor path ends at a checked genesis. */
export function reachOf(_index: BundleIndex): { toGenesis: boolean; generations: number } {
  return { toGenesis: false, generations: 0 };
}
