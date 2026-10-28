// The pair of children of one mating (ADR 0021). Both come from the one committed round, so there
// is nothing to reroll; the same inputs give the same pair on the authority, the clients and the
// verifier.

import { RULES_VERSION } from '../sim/rules';
import { type Genome, genomeHash } from './codec';
import { breed, offspringSeed } from './inherit';
import { breedV5 } from './inherit-v5';
import { karyotypeForRules } from './karyotype';

const LAST_SLOT = 255;

/**
 * The two children of parents `a` (the courting player's creature) and `b`. Slot 0 is `a`'s owner's
 * child. Slot 1 is `b`'s owner's child; if it would equal slot 0's genome (identical clones can do
 * this), it takes the next slot byte that differs, up to 255. `slots` says which were used.
 * `rules` is the rules version of the birth records: up to 5 the frozen v5 inheritance breeds v1
 * children, from 6 the parents are padded to karyotype v2 and the children are v2.
 */
export function offspringPair(
  randomness: Uint8Array,
  commitId: string,
  a: Genome,
  b: Genome,
  rules: number = RULES_VERSION,
): { children: [Genome, Genome]; slots: [number, number] } {
  const child = (slot: number): Genome => {
    const seed = offspringSeed(randomness, commitId, slot);
    return karyotypeForRules(rules) === 1 ? breedV5(a, b, seed) : breed(a, b, seed);
  };
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
