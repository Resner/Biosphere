// The most expensive body to draw (M3 T18): the genome with the most full-detail vertices among
// 1,500 random genomes, the archetypes and the extremes, and copies of it that differ only in tint.

import { decodeGenome, encodeGenome, type Genome } from '../src/genome/codec';
import { develop, estimateVertices } from '../src/genome/develop';
import { express } from '../src/genome/express';
import { GENOME_BYTES, LOCI, MODULE_PARAMS } from '../src/genome/karyotype';
import { createRng, seedFromString } from '../src/sim/prng';
import { ARCHETYPES, buildBytes, withLoci } from './archetypes';

const modules = (value: number) =>
  Object.fromEntries(
    LOCI.filter((l) => l.kind === 'module').map((l) => [
      l.id,
      Object.fromEntries(MODULE_PARAMS.map((p) => [p, value])),
    ]),
  );

export function worstBody(): { genome: Genome; vertices: number } {
  const rng = createRng(seedFromString('creature-budget'), 'bytes');
  const randoms = Array.from({ length: 1_500 }, () =>
    decodeGenome(Uint8Array.from({ length: GENOME_BYTES }, () => rng.nextU32() & 0xff)),
  );
  const extremes = [
    new Uint8Array(GENOME_BYTES).fill(0xff),
    buildBytes(modules(255)),
    buildBytes(modules(255), { segDrive1: 255, segDrive2: 255 }),
  ].map(decodeGenome);
  let best = { genome: extremes[0] as Genome, vertices: -1 };
  for (const genome of [...Object.values(ARCHETYPES), ...extremes, ...randoms]) {
    const vertices = estimateVertices(develop(express(genome)), 'full');
    if (vertices > best.vertices) best = { genome, vertices };
  }
  return best;
}

/** `n` copies of `genome` with different hue genes: the same geometry, `n` distinct hashes. */
export function tinted(genome: Genome, n: number): Genome[] {
  const bytes = encodeGenome(genome);
  return Array.from({ length: n }, (_, i) =>
    decodeGenome(withLoci(bytes, { hue1: (i * 11) % 256, hue2: (i * 29 + 5) % 256 })),
  );
}
