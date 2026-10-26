// The reference cell (M3 T6): a single round cell with a whip, an all-round mouth and no plates.
// `computeStats` is normalised so that this genome reproduces `STARTER_PHYS`, the M1 cell.

import { decodeGenome, type Genome } from './codec';
import { GENOME_BYTES, HAPLOTYPE_BYTES, LOCI, MODULE_PARAMS } from './karyotype';

const offsetOf = (id: string): number =>
  (LOCI.find((l) => l.id === id) as { offset: number }).offset;

/** The whip of M1: a long, thin flagellum at the rear, beating hard. */
const WHIP: Partial<Record<(typeof MODULE_PARAMS)[number], number>> = {
  length: 120,
  thickness: 20,
  joints: 100,
  tipShape: 255,
  beat: 200,
  angle: 230,
  attachStart: 255,
};

export function starterGenome(): Genome {
  const bytes = new Uint8Array(GENOME_BYTES);
  for (let hap = 0; hap < 2; hap++) {
    const at = (id: string): number => hap * HAPLOTYPE_BYTES + offsetOf(id);
    bytes[at('aspect')] = 128;
    // The alleles of a trait sum, so 127 + 128 gives a mouth type of exactly 0.5.
    bytes[at('mouthType')] = hap === 0 ? 127 : 128;
    bytes[at('mouthSize')] = 255;
    bytes[at('digestion')] = 153;
    // Max size 400: the three size loci sum to 49 of 1530.
    bytes[at('size1')] = hap === 0 ? 24 : 25;
    const m1 = at('M1');
    bytes[m1] = 1;
    MODULE_PARAMS.forEach((name, k) => {
      bytes[m1 + 1 + k] = WHIP[name] ?? 0;
    });
  }
  return decodeGenome(bytes);
}
