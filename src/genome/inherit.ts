// Inheritance (M3 T8, ADR 0006): meiosis, bounded mutation and breeding. Every random draw comes
// from a seed through named streams, so a child can be verified from the commitment alone.

import { sha256 } from '@noble/hashes/sha2.js';
import { createRng, type Rng, type Seed } from '../sim/prng';
import { RULES } from '../sim/rules';
import { decodeGenome, type Genome } from './codec';
import { HAPLOTYPE_BYTES, LOCI, type MendelLocus, MODULE_BYTES } from './karyotype';

const G = RULES.genetics;

const ENCODER = new TextEncoder();
const DOMAIN = ENCODER.encode('bs/offspring/v1');

/**
 * The seed of one child: SHA-256 of the domain tag, the beacon randomness, the commit id (UTF-8)
 * and the slot byte, read as four big-endian words. Slot 0 is player A's child, slot 1 player B's.
 */
export function offspringSeed(randomness: Uint8Array, commitId: string, slot: 0 | 1): Seed {
  const id = ENCODER.encode(commitId);
  const input = new Uint8Array(DOMAIN.length + randomness.length + id.length + 1);
  input.set(DOMAIN);
  input.set(randomness, DOMAIN.length);
  input.set(id, DOMAIN.length + randomness.length);
  input[input.length - 1] = slot;
  const d = sha256(input);
  const word = (i: number): number =>
    (((d[i] as number) << 24) |
      ((d[i + 1] as number) << 16) |
      ((d[i + 2] as number) << 8) |
      (d[i + 3] as number)) >>>
    0;
  return [word(0), word(4), word(8), word(12)];
}

// Loci grouped by chromosome, in karyotype order.
const CHROMOSOMES: readonly (readonly (typeof LOCI)[number][])[] = Array.from(
  { length: 6 },
  (_, c) => LOCI.filter((l) => l.chr === c + 1),
);

const QUANT = LOCI.filter((l) => l.kind === 'quant');
const MENDEL = LOCI.filter((l): l is MendelLocus => l.kind === 'mendel');
const LOAD = LOCI.filter((l) => l.kind === 'load');
const MODULES = LOCI.filter((l) => l.kind === 'module');

/** How many crossovers one chromosome gets, from the probabilities in `RULES.genetics`. */
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
export function meiosis(parent: Genome, rng: Rng): number[] {
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

export const MUTATION_KINDS = [
  'quantStep',
  'alleleChange',
  'loadFlip',
  'paramDrift',
  'moduleDuplicate',
  'moduleDelete',
  'novelAllele',
] as const;
export type MutationKind = (typeof MUTATION_KINDS)[number];

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
export function applyMutation(h: number[], kind: MutationKind, rng: Rng): boolean {
  switch (kind) {
    case 'quantStep': {
      const at = pickOf(rng, QUANT).offset;
      h[at] = clampByte((h[at] as number) + step(rng));
      return true;
    }
    case 'alleleChange': {
      const locus = pickOf(rng, MENDEL);
      // Genesis-range alleles only; the novel ones come from `novelAllele`.
      const now = h[locus.offset] as number;
      const others = Array.from({ length: locus.novelFrom }, (_, i) => i).filter((i) => i !== now);
      h[locus.offset] = pickOf(rng, others);
      return true;
    }
    case 'loadFlip': {
      const at = pickOf(rng, LOAD).offset;
      h[at] = (h[at] as number) ^ 1;
      return true;
    }
    case 'novelAllele': {
      const locus = pickOf(rng, MENDEL);
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

export interface MutationOptions {
  /** Scales the chance of each of the `RULES.genetics.maxEvents` trials; 0 turns mutation off, 1 is the default rate. */
  mutation?: number;
}

export interface MutationEvent {
  kind: MutationKind;
  /** False when the kind had nothing to act on. */
  applied: boolean;
}

/** The mutation pass of one gamete, in place: up to three events. Returns every event that fired. */
export function mutateHaplotype(h: number[], rng: Rng, mutation = 1): MutationEvent[] {
  const chance = Number.isFinite(mutation) ? Math.min(1, Math.max(0, G.eventChance * mutation)) : 0;
  const events: MutationEvent[] = [];
  for (let trial = 0; trial < G.maxEvents; trial++) {
    if (rng.next() >= chance) continue;
    const kind = pickKind(rng);
    events.push({ kind, applied: applyMutation(h, kind, rng) });
  }
  return events;
}

/** One gamete: meiosis on `meiosis-<tag>`, then mutation on `mutation-<tag>`. */
function gamete(parent: Genome, seed: Seed, tag: 'a' | 'b', mutation: number): number[] {
  const h = meiosis(parent, createRng(seed, `meiosis-${tag}`));
  mutateHaplotype(h, createRng(seed, `mutation-${tag}`), mutation);
  return h;
}

/** The child of `a` and `b`: haplotype one is a gamete of `a`, haplotype two a gamete of `b`. */
export function breed(a: Genome, b: Genome, seed: Seed, options: MutationOptions = {}): Genome {
  const mutation = options.mutation ?? 1;
  return fromHaplotypes(gamete(a, seed, 'a', mutation), gamete(b, seed, 'b', mutation));
}

/** The single-parent path for the Creature Lab: both haplotypes of `g` get a mutation pass, with no meiosis. */
export function mutateGenome(g: Genome, seed: Seed, options: MutationOptions = {}): Genome {
  const mutation = options.mutation ?? 1;
  const [x, y] = g.haplotypes.map((h) =>
    Array.from({ length: HAPLOTYPE_BYTES }, (_, k) => h.alleles[k] ?? 0),
  );
  mutateHaplotype(x as number[], createRng(seed, 'mutation-a'), mutation);
  mutateHaplotype(y as number[], createRng(seed, 'mutation-b'), mutation);
  return fromHaplotypes(x as number[], y as number[]);
}

function fromHaplotypes(x: number[], y: number[]): Genome {
  return decodeGenome(Uint8Array.from([...x, ...y]));
}
