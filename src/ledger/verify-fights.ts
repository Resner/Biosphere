import type { BundleIndex, LineageReport, Problem, VerifyOptions } from './verify';

// The fights family of `verifyLineage` (ADR 0055): each fight record against its settlement, the
// locked time and growth around a fight, and, with logs and a replay, the fight replayed. M9 T6.

export function verifyFights(_index: BundleIndex, _opts: VerifyOptions): Problem[] {
  return [];
}

/** The bundle's settlements: how many were replayed, had their log pruned, or had none given. */
export function fightsOf(index: BundleIndex, opts: VerifyOptions): LineageReport['fights'] {
  const settled = index.settlements.size;
  let pruned = 0;
  for (const enc of index.settlements.keys()) if (opts.logs?.get(enc) === null) pruned++;
  return { settled, replayed: 0, pruned, unreplayed: settled - pruned };
}
