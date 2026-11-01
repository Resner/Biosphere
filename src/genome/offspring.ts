// The pair of children of one mating (ADR 0021). Both come from the one committed round, so there
// is nothing to reroll; the same inputs give the same pair on the authority, the clients and the
// verifier.

import { type Genome, genomeHash } from './codec';
import { breed, offspringSeed } from './inherit';

const LAST_SLOT = 255;

/**
 * The two children of parents `a` (the courting player's creature) and `b`. Slot 0 is `a`'s owner's
 * child. Slot 1 is `b`'s owner's child; if it would equal slot 0's genome (identical clones can do
 * this), it takes the next slot byte that differs, up to 255. `slots` says which were used.
 * Always under the live rules version (ADR 0040).
 */
export function offspringPair(
  randomness: Uint8Array,
  commitId: string,
  a: Genome,
  b: Genome,
): { children: [Genome, Genome]; slots: [number, number] } {
  const child = (slot: number): Genome => breed(a, b, offspringSeed(randomness, commitId, slot));
  const first = child(0);
  const firstHash = genomeHash(first);
  let slot = 1;
  let second = child(slot);
  while (slot < LAST_SLOT && genomeHash(second) === firstHash) {
    slot++;
    second = child(slot);
  }
  return { children: [first, second], slots: [0, slot] };
}
