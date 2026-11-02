// Wild genomes: random genome bytes with most of the v2 bytes off, from a seed. The Lab showed them
// until M6c T5 replaced its wild mode with evolved lineages; the specimen search (`tools/specimen.ts`)
// and the body tests still use them to reach the extremes no lineage reaches without selection.

import { decodeGenome, type Genome } from '../src/genome/codec';
import { BASE_BYTES, GENOME_BYTES, HAPLOTYPE_BYTES } from '../src/genome/karyotype';
import { createRng, type Seed } from '../src/sim/prng';

/** The chance that a wild genome leaves one v2 byte (a shape locus or a part detail) at 0. */
const WILD_V2_OFF = 0.6;

/** A wild genome: random bytes with most of the v2 bytes off, from a seed. */
export function wildGenome(at: Seed): Genome {
  const rng = createRng(at, 'lab-wild');
  const bytes = Uint8Array.from({ length: GENOME_BYTES }, () => rng.nextU32() & 0xff);
  // Each v2 byte (body shape and part detail) is off in most genomes, or half of them would be radial
  // bells and a third winged: wild genomes mix a few new axes into a plain body, the way breeding does.
  const extra = HAPLOTYPE_BYTES - BASE_BYTES;
  for (let i = 0; i < extra; i++) {
    if (rng.next() < WILD_V2_OFF) {
      bytes[BASE_BYTES + i] = 0;
      bytes[HAPLOTYPE_BYTES + BASE_BYTES + i] = 0;
    }
  }
  return decodeGenome(bytes);
}
