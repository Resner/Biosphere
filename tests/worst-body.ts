// The most expensive body to draw (M3 T18, M6 T10): the genome with the most high-detail vertices
// among 1,500 random genomes, the archetypes and the extremes, and copies of it that differ only in tint.

import { decodeGenome, encodeGenome, type Genome, genomeHash } from '../src/genome/codec';
import { develop } from '../src/genome/develop';
import { express } from '../src/genome/express';
import { GENOME_BYTES, LOCI, MODULE_PARAMS } from '../src/genome/karyotype';
import { anatomyOf } from '../src/render/anatomy';
import { estimateVertices } from '../src/render/creature-mesh';
import { glintPlanOf } from '../src/render/surface';
import { createRng, seedFromString } from '../src/sim/prng';
import { ARCHETYPES, buildBytes, withLoci } from './archetypes';

const modules = (value: number) =>
  Object.fromEntries(
    LOCI.filter((l) => l.kind === 'module').map((l) => [
      l.id,
      Object.fromEntries(MODULE_PARAMS.map((p) => [p, value])),
    ]),
  );

let worst: { genome: Genome; vertices: number; lowVertices: number } | undefined;

/** The costliest genome, and the most low-detail vertices of any candidate. */
export function worstBody(): NonNullable<typeof worst> {
  worst ??= findWorst();
  return worst;
}

function findWorst(): NonNullable<typeof worst> {
  const rng = createRng(seedFromString('creature-budget'), 'bytes');
  const randoms = Array.from({ length: 1_500 }, () =>
    decodeGenome(Uint8Array.from({ length: GENOME_BYTES }, () => rng.nextU32() & 0xff)),
  );
  const extremes = [
    new Uint8Array(GENOME_BYTES).fill(0xff),
    buildBytes(modules(255)),
    buildBytes(modules(255), { segDrive1: 255, segDrive2: 255 }),
  ].map(decodeGenome);
  let best = { genome: extremes[0] as Genome, vertices: -1, lowVertices: 0 };
  for (const genome of [...Object.values(ARCHETYPES), ...extremes, ...randoms]) {
    const traits = express(genome);
    const plan = develop(traits);
    const hash = genomeHash(genome);
    const anatomy = anatomyOf(plan, traits, hash);
    const glints = glintPlanOf({ hash, plan, traits });
    const vertices = estimateVertices(plan, 'high', anatomy, glints);
    best.lowVertices = Math.max(best.lowVertices, estimateVertices(plan, 'low', anatomy, glints));
    if (vertices > best.vertices) best = { genome, vertices, lowVertices: best.lowVertices };
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
