// Inheritance under rules versions 3 to 5 (M3 T8, ADR 0006): meiosis, bounded mutation and
// breeding over the karyotype v1 table. Frozen (ADR 0025): `checkBirth` recomputes every birth of
// rules 5 or older with it, so nothing here changes, the genetics numbers included (copied from rules
// v5 below). Every random draw comes from a seed through named streams.

import { createRng, type Rng, type Seed } from '../sim/prng';
import { decodeGenome, type Genome } from './codec';
import {
  HAPLOTYPE_BYTES_V1 as HAPLOTYPE_BYTES,
  LOCI_V1 as LOCI,
  type MendelLocus,
  MODULE_BYTES,
} from './karyotype-v1';

/** `RULES.genetics` as rules v5 had it. */
const G = {
  crossovers: [0.4, 0.4, 0.2],
  maxEvents: 3,
  eventChance: 0.15,
  kinds: {
    quantStep: 30,
    alleleChange: 14,
    loadFlip: 10,
    paramDrift: 20,
    moduleDuplicate: 8,
    moduleDelete: 8,
    novelAllele: 10,
  },
  maxStep: 24,
} as const;

const MUTATION_KINDS = [
  'quantStep',
  'alleleChange',
  'loadFlip',
  'paramDrift',
  'moduleDuplicate',
  'moduleDelete',
  'novelAllele',
] as const;
type MutationKind = (typeof MUTATION_KINDS)[number];

const MENDEL_LOCI = LOCI.filter((l): l is MendelLocus => l.kind === 'mendel');
const LOAD_LOCI = LOCI.filter((l) => l.kind === 'load');

// Loci grouped by chromosome, in karyotype order.
const CHROMOSOMES: readonly (readonly (typeof LOCI)[number][])[] = Array.from(
  { length: 6 },
  (_, c) => LOCI.filter((l) => l.chr === c + 1),
);

const QUANT = LOCI.filter((l) => l.kind === 'quant');
const MODULES = LOCI.filter((l) => l.kind === 'module');

/** How many crossovers one chromosome gets. */
function crossoverCount(rng: Rng): number {
  const u = rng.next();
  let acc = 0;
  for (let i = 0; i < G.crossovers.length; i++) {
    acc += G.crossovers[i] as number;
    if (u < acc) return i;
  }
  return G.crossovers.length - 1;
}

/**
 * One gamete by meiosis: per chromosome a random starting haplotype, then 0-2 crossovers at locus
 * boundaries, each flipping which of the parent's haplotypes is copied from there on.
 */
function meiosis(parent: Genome, rng: Rng): number[] {
  const out = new Array<number>(HAPLOTYPE_BYTES).fill(0);
  for (const loci of CHROMOSOMES) {
    const start = rng.next() < 0.5 ? 0 : 1;
    const cuts: number[] = [];
    // A chromosome with n loci has n - 1 boundaries; boundary b sits before locus b.
    for (let k = crossoverCount(rng); k > 0 && loci.length > 1; k--)
      cuts.push(rng.int(1, loci.length - 1));
    loci.forEach((locus, j) => {
      let flips = 0;
      for (const cut of cuts) if (cut <= j) flips++;
      const source = parent.haplotypes[(start + flips) & 1]?.alleles;
      for (let k = 0; k < locus.size; k++)
        out[locus.offset + k] = (source?.[locus.offset + k] as number | undefined) ?? 0;
    });
  }
  return out;
}

const pickOf = <T>(rng: Rng, items: readonly T[]): T => items[rng.int(0, items.length - 1)] as T;
const clampByte = (v: number): number => Math.min(255, Math.max(0, v));
const present = (h: number[], slot: (typeof LOCI)[number]): boolean => h[slot.offset] === 1;

function pickKind(rng: Rng): MutationKind {
  const weights = MUTATION_KINDS.map((k) => G.kinds[k]);
  let u = rng.next() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < weights.length; i++) {
    u -= weights[i] as number;
    if (u < 0) return MUTATION_KINDS[i] as MutationKind;
  }
  return MUTATION_KINDS[MUTATION_KINDS.length - 1] as MutationKind;
}

/** A step of 1..maxStep, either way. */
const step = (rng: Rng): number => (rng.next() < 0.5 ? -1 : 1) * rng.int(1, G.maxStep);

/**
 * Applies one mutation of `kind` to a haplotype in place. Returns false when the kind has nothing
 * to act on (no module to drift, no empty slot to duplicate into).
 */
function applyMutation(h: number[], kind: MutationKind, rng: Rng): boolean {
  switch (kind) {
    case 'quantStep': {
      const at = pickOf(rng, QUANT).offset;
      h[at] = clampByte((h[at] as number) + step(rng));
      return true;
    }
    case 'alleleChange': {
      const locus = pickOf(rng, MENDEL_LOCI);
      // Genesis-range alleles only; the novel ones come from `novelAllele`.
      const now = h[locus.offset] as number;
      const others = Array.from({ length: locus.novelFrom }, (_, i) => i).filter((i) => i !== now);
      h[locus.offset] = pickOf(rng, others);
      return true;
    }
    case 'loadFlip': {
      const at = pickOf(rng, LOAD_LOCI).offset;
      h[at] = (h[at] as number) ^ 1;
      return true;
    }
    case 'novelAllele': {
      const locus = pickOf(rng, MENDEL_LOCI);
      h[locus.offset] = rng.int(locus.novelFrom, locus.alleles.length - 1);
      return true;
    }
    case 'paramDrift': {
      const slots = MODULES.filter((m) => present(h, m));
      if (slots.length === 0) return false;
      const at = pickOf(rng, slots).offset + 1 + rng.int(0, MODULE_BYTES - 2);
      h[at] = clampByte((h[at] as number) + step(rng));
      return true;
    }
    case 'moduleDuplicate': {
      const from = pickOf(rng, MODULES);
      const to = pickOf(rng, MODULES);
      if (!present(h, from) || present(h, to)) return false;
      for (let k = 0; k < MODULE_BYTES; k++) h[to.offset + k] = h[from.offset + k] as number;
      return true;
    }
    case 'moduleDelete': {
      const slot = pickOf(rng, MODULES);
      if (!present(h, slot)) return false;
      h.fill(0, slot.offset, slot.offset + MODULE_BYTES);
      return true;
    }
  }
}

/** The mutation pass of one gamete, in place: up to three events at the default rate. */
function mutateHaplotype(h: number[], rng: Rng): void {
  for (let trial = 0; trial < G.maxEvents; trial++) {
    if (rng.next() >= G.eventChance) continue;
    applyMutation(h, pickKind(rng), rng);
  }
}

/** One gamete: meiosis on `meiosis-<tag>`, then mutation on `mutation-<tag>`. */
function gamete(parent: Genome, seed: Seed, tag: 'a' | 'b'): number[] {
  const h = meiosis(parent, createRng(seed, `meiosis-${tag}`));
  mutateHaplotype(h, createRng(seed, `mutation-${tag}`));
  return h;
}

/** The rules v5 child of `a` and `b` (karyotype v1): haplotype one is a gamete of `a`, haplotype two a gamete of `b`. */
export function breedV5(a: Genome, b: Genome, seed: Seed): Genome {
  return decodeGenome(Uint8Array.from([...gamete(a, seed, 'a'), ...gamete(b, seed, 'b')]));
}
