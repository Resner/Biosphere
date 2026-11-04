import type { BundleIndex, Problem, VerifyOptions } from './verify';

// The gates family of `verifyLineage` (ADR 0055): the life clock, matings' maturity, cooldowns and
// costs, growth, and freezes and returns, record by record under the bundle's scales and the one
// rulebook (`gates.ts`). M9 T5.

export function verifyGates(_index: BundleIndex, _opts: VerifyOptions): Problem[] {
  return [];
}
