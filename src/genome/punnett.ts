// Punnett hints (M5 T5, ADR 0006): the exact chance of each outcome of a cross, for the Mendelian
// traits and the loss-of-function load loci. Each parent hands on one of its two alleles at a locus
// with equal chance (the start haplotype of meiosis is a coin flip and crossovers only flip it), so
// the four combinations are equally likely. Mutation can still surprise: `mutationChance` says how
// likely it is anywhere in the child. Pure; the numbers match enumeration, not the sim's draws.

import { RULES } from '../sim/rules';
import type { Genome } from './codec';
import { allele, blended, byte, dominant } from './express';
import { HAPLOTYPE_BYTES, LOAD_LOCI, MENDEL_LOCI, type MendelLocus } from './karyotype';

export interface PunnettOutcome {
  /** Allele names joined with `+` when both show; for a blended locus the rank in words. */
  value: string;
  chance: number;
}

export interface PunnettTrait {
  /** Locus id from the karyotype. */
  id: string;
  outcomes: PunnettOutcome[];
}

export interface PunnettLoad {
  /** Load locus id (`L1`-`L4`). */
  id: string;
  /** The chance that the child is homozygous for the loss of function. */
  chance: number;
}

export interface PunnettHints {
  traits: PunnettTrait[];
  load: PunnettLoad[];
  /** The chance that at least one mutation event fires while the child is made. */
  mutationChance: number;
}

/** A genome of zeros with one Mendelian locus set, so the shared expression code reads the pair. */
function probe(locus: MendelLocus, x: number, y: number): Genome {
  const zeros = (): { alleles: number[] } => ({
    alleles: new Array<number>(HAPLOTYPE_BYTES).fill(0),
  });
  const a = zeros();
  const b = zeros();
  a.alleles[locus.offset] = x;
  b.alleles[locus.offset] = y;
  return { haplotypes: [a, b] };
}

/** Rank halves are named by the two whole ranks around them. */
function blendWord(locus: MendelLocus, rank: number): string {
  const name = (r: number): string => locus.alleles[locus.rank.indexOf(r)] ?? String(r);
  return Number.isInteger(rank)
    ? name(rank)
    : `${name(Math.floor(rank))} to ${name(Math.ceil(rank))}`;
}

function traitOf(a: Genome, b: Genome, locus: MendelLocus): PunnettTrait {
  const chances = new Map<string, number>();
  for (const x of [0, 1] as const)
    for (const y of [0, 1] as const) {
      const pair = probe(locus, allele(a, locus, x), allele(b, locus, y));
      const value =
        locus.dominance === 'incomplete'
          ? blendWord(locus, blended(pair, locus.id))
          : dominant(pair, locus.id).join('+');
      chances.set(value, (chances.get(value) ?? 0) + 0.25);
    }
  return { id: locus.id, outcomes: [...chances].map(([value, chance]) => ({ value, chance })) };
}

/** The share of a parent's two haplotypes that carry the loss of function: its gamete carries it with this chance. */
function lofShare(g: Genome, offset: number): number {
  return g.haplotypes.reduce((n, h) => n + (byte(h, offset) & 1), 0) / 2;
}

export function punnett(a: Genome, b: Genome): PunnettHints {
  const { eventChance, maxEvents } = RULES.genetics;
  let none = 1;
  for (let i = 0; i < 2 * maxEvents; i++) none *= 1 - eventChance;
  return {
    traits: MENDEL_LOCI.map((l) => traitOf(a, b, l)),
    load: LOAD_LOCI.map((l) => ({
      id: l.id,
      chance: lofShare(a, l.offset) * lofShare(b, l.offset),
    })),
    mutationChance: 1 - none,
  };
}
