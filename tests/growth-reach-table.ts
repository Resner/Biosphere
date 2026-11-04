import { genesisGenome } from '../src/genome/genesis';
import { growthReach } from '../src/ledger/gates';
import { seedFromString } from '../src/sim/prng';

// The pinned table of `growthReach` (ADR 0055): 64 values that Node and workerd must agree on,
// so the authority's clamp and every verifier draw the same line. `src/ledger/gates.test.ts` and
// `worker/gates.test.ts` compare it with `src/ledger/__golden__/growth-reach.json`.

export const REACH_TABLE_SEEDS = Array.from({ length: 8 }, (_, i) => `reach-${i}`);
const FROM = [0, 5000, 10_000, 8000, 50_000, 250_000, 1_000_000, 24_000_000];
const ACTIVE_MS = [0, 1, 2000, 30_000, 900_000, 1_800_000, 3_600_000, 5_400_000];

export interface ReachEntry {
  seed: string;
  from: number;
  activeMs: number;
  reach: number;
}

export function reachTable(): ReachEntry[] {
  return REACH_TABLE_SEEDS.flatMap((seed, j) => {
    const genome = genesisGenome(seedFromString(seed));
    return FROM.map((from, k) => {
      const activeMs = ACTIVE_MS[(k + j) % ACTIVE_MS.length] as number;
      return { seed, from, activeMs, reach: growthReach(from, genome, activeMs) };
    });
  });
}
