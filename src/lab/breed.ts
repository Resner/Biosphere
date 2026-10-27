// The Creature Lab's genetics tools (M3 T14): a mutation step and a batch of eight children.
// Pure and seeded, so the same page, selection and step always give the same creatures.

import { sha256 } from '@noble/hashes/sha2.js';
import { type Genome, genomeHash } from '../genome/codec';
import { breed, type MutationOptions, mutateGenome, offspringSeed } from '../genome/inherit';
import { seedFromString } from '../sim/prng';

export const BREED_COUNT = 8;
/** How hard the Lab's Mutate button pushes (the default rate is 1). */
export const LAB_MUTATION = 4;
/** More tries than a step ever needs: the chance of an event is 0.45 per trial and three trials. */
const MUTATION_TRIES = 16;

const ENCODER = new TextEncoder();

/** A local stand-in for a beacon's randomness (real beacons arrive in M5): a hash of the page seed. */
export function labRandomness(seed: string): Uint8Array {
  return sha256(ENCODER.encode(`bs/lab/randomness/${seed}`));
}

/**
 * Eight children of `a` and `b`: child k uses the seed of commit `lab-<k >> 1` and slot `k & 1`,
 * like four matings that each give both parents a child.
 */
export function breedBatch(
  a: Genome,
  b: Genome,
  randomness: Uint8Array,
  options: MutationOptions = {},
): Genome[] {
  return Array.from({ length: BREED_COUNT }, (_, k) =>
    breed(a, b, offspringSeed(randomness, `lab-${k >> 1}`, k & 1), options),
  );
}

/**
 * One visible Mutate step: the first mutated copy of `g` with a new hash. A pass may fire no event
 * or hit an empty slot, so later tries use the next sub-seed.
 */
export function mutateStep(g: Genome, seed: string, step: number): Genome {
  const was = genomeHash(g);
  let next = g;
  for (let attempt = 0; attempt < MUTATION_TRIES; attempt++) {
    next = mutateGenome(g, seedFromString(`${seed}/mutate/${step}/${attempt}`), {
      mutation: LAB_MUTATION,
    });
    if (genomeHash(next) !== was) return next;
  }
  return next;
}
