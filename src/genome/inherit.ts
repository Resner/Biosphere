// Inheritance (M3 T8, ADR 0006, ADR 0025): meiosis, bounded mutation and breeding over karyotype v2.
// The shape loci sit on chromosome 1 after its base loci, and a module slot's extension moves,
// mutates and clears with its slot. Every random draw comes from a seed through named streams, so a
// child can be verified from the commitment alone. Unchanged since rules 6.

import { sha256 } from '@noble/hashes/sha2.js';
import { createRng, type Rng, type Seed } from '../sim/prng';
import { RULES } from '../sim/rules';
import { decodeGenome, type Genome } from './codec';
import {
  HAPLOTYPE_BYTES,
  LOAD_LOCI,
  LOCI,
  MENDEL_LOCI,
  MODULE_BYTES,
  MODULE_EXT_BYTES,
  MODULE_LOCI,
  type ModuleLocus,
} from './karyotype';

const G = RULES.genetics;

const ENCODER = new TextEncoder();
const OFFSPRING_DOMAIN = 'bs/offspring/v1';

/**
 * Shared by genesis and births: changing it is a rules change.
 * A seed from a domain tag, the beacon randomness, the commit id (UTF-8) and a slot byte:
 * SHA-256 of the four, read as four big-endian words. The domain keeps one commitment from
 * seeding two different things the same way.
 */
export function deriveSeed(
  domain: string,
  randomness: Uint8Array,
  commitId: string,
  slot: number,
): Seed {
  const tag = ENCODER.encode(domain);
  const id = ENCODER.encode(commitId);
  const input = new Uint8Array(tag.length + randomness.length + id.length + 1);
  input.set(tag);
  input.set(randomness, tag.length);
  input.set(id, tag.length + randomness.length);
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

/** The seed of one child; `slot` is a byte (see `offspringPair` for which slot each child uses). */
export function offspringSeed(randomness: Uint8Array, commitId: string, slot: number): Seed {
  return deriveSeed(OFFSPRING_DOMAIN, randomness, commitId, slot);
}

// Loci grouped by chromosome, in byte order: chromosome 1 ends with the shape loci.
const CHROMOSOMES: readonly (readonly (typeof LOCI)[number][])[] = Array.from(
  { length: 6 },
  (_, c) => LOCI.filter((l) => l.chr === c + 1),
);

const QUANT = LOCI.filter((l) => l.kind === 'quant');

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

/** Copies `size` bytes at `from` out of a parent haplotype; bytes past a short haplotype's end read 0. */
function copyBytes(
  out: number[],
  source: ArrayLike<number> | undefined,
  from: number,
  size: number,
): void {
  for (let k = 0; k < size; k++) out[from + k] = source?.[from + k] ?? 0;
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
      copyBytes(out, source, locus.offset, locus.size);
      if (locus.kind === 'module') copyBytes(out, source, locus.ext, MODULE_EXT_BYTES);
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
const present = (h: number[], slot: ModuleLocus): boolean => h[slot.offset] === 1;
/** The bytes a slot owns after its presence byte: its 14 parameters, then its extension. */
const slotBytes = (slot: ModuleLocus): number[] => [
  ...Array.from({ length: MODULE_BYTES - 1 }, (_, k) => slot.offset + 1 + k),
  ...Array.from({ length: MODULE_EXT_BYTES }, (_, k) => slot.ext + k),
];

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
      const slots = MODULE_LOCI.filter((m) => present(h, m));
      if (slots.length === 0) return false;
      const at = pickOf(rng, slotBytes(pickOf(rng, slots)));
      h[at] = clampByte((h[at] as number) + step(rng));
      return true;
    }
    case 'moduleDuplicate': {
      const from = pickOf(rng, MODULE_LOCI);
      const to = pickOf(rng, MODULE_LOCI);
      if (!present(h, from) || present(h, to)) return false;
      h[to.offset] = 1;
      const source = slotBytes(from);
      slotBytes(to).forEach((at, k) => {
        h[at] = h[source[k] as number] as number;
      });
      return true;
    }
    case 'moduleDelete': {
      const slot = pickOf(rng, MODULE_LOCI);
      if (!present(h, slot)) return false;
      h[slot.offset] = 0;
      for (const at of slotBytes(slot)) h[at] = 0;
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
