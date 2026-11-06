import { randomnessOf } from '../src/ledger/drand';
import { playerIdOf, publicKeyFromSecret } from '../src/ledger/identity';
import { witnessOrder } from '../src/ledger/witness';
import rounds from './fixtures/drand/rounds.json';

// The pinned witness order (ADR 0058): the authority, every witness and every verifier must draw
// the same order from a beacon, so `src/ledger/witness.test.ts` and `worker/witness.test.ts` both
// compare this case with `PINNED_ORDER`.

/** 16 player ids from the secrets [i, i, …, i], sorted, as a pool is. */
export const PINNED_POOL: readonly string[] = Array.from({ length: 16 }, (_, i) =>
  playerIdOf(publicKeyFromSecret(new Uint8Array(32).fill(i + 1))),
).sort();

export const PINNED_COMMIT = 'a5'.repeat(32);

/** The order of `PINNED_POOL` under the first recorded beacon and `PINNED_COMMIT`, as pool indices. */
export const PINNED_ORDER: readonly number[] = [
  3, 1, 2, 15, 10, 5, 0, 9, 12, 11, 8, 6, 4, 13, 7, 14,
];

export function pinnedOrder(): number[] {
  const beacon = rounds.beacons[0] as { round: number; signature: string };
  return witnessOrder(PINNED_POOL, randomnessOf(beacon), PINNED_COMMIT).map((id) =>
    PINNED_POOL.indexOf(id),
  );
}
