// Which parent a child's simple-inheritance traits come from (M3 T14, ADR 0006), for the Lab
// inspector. Exact: it reads the two alleles of every locus, not a probability. Like `describe.ts`
// this is user-facing wording, so it says "shown", "hidden" and "mix", never how DNA is encoded.

import type { Genome } from './codec';
import { allele, blended, dominant, locusOf as locus } from './express';
import type { MendelLocus } from './karyotype';

/** The traits that follow simple inheritance (the karyotype's Mendel loci), in display order. */
export const EXPLAINED_TRAITS = [
  'iridescence',
  'texture',
  'targetPref',
  'pattern',
  'albino',
  'luminescence',
] as const;
export type ExplainedTrait = (typeof EXPLAINED_TRAITS)[number];

/**
 * `a` and `b`: the parent that shows it (both, when both do). `hidden`: neither parent shows it,
 * but a parent carries it. `blend`: a mix of what the parents show. `new`: neither parent had it.
 */
export type TraitSource = 'both' | 'a' | 'b' | 'hidden' | 'blend' | 'new';

export interface TraitExplanation {
  id: ExplainedTrait;
  /** What the child shows, in words. */
  value: string;
  source: TraitSource;
  /** The parents that show it, or carry it when it is hidden; empty for a blend and a new trait. */
  carriers: ('a' | 'b')[];
  text: string;
}

const LABELS: Readonly<Record<ExplainedTrait, string>> = {
  iridescence: 'Iridescence',
  texture: 'Skin',
  targetPref: 'Prey',
  pattern: 'Pattern',
  albino: 'Colouring',
  luminescence: 'Glow',
};

/** Plain words per allele name. */
const WORDS: Readonly<Record<ExplainedTrait, Readonly<Record<string, string>>>> = {
  iridescence: { plain: 'none', iridescent: 'an iridescent sheen', oil: 'an oil-slick sheen' },
  texture: { smooth: 'smooth', grainy: 'grainy', ridged: 'ridged' },
  targetPref: {
    nearest: 'the nearest',
    weakest: 'the weakest',
    largest: 'the largest',
    strongest: 'the strongest',
  },
  pattern: {
    none: 'no pattern',
    rings: 'rings',
    spots: 'spots',
    stripes: 'stripes',
    bands: 'bands',
  },
  albino: { normal: 'normal', albino: 'albino', pale: 'pale' },
  luminescence: { off: 'none', on: 'a steady glow', pulse: 'a pulsing glow' },
};

/** The texture blends two ranks; a half step reads as "between". */
const TEXTURE_BLENDS = [
  'smooth',
  'between smooth and grainy',
  'grainy',
  'between grainy and ridged',
  'ridged',
];

const locusOf = (id: ExplainedTrait): MendelLocus => locus(id) as MendelLocus;

/** The names of the two alleles a genome holds at this locus. */
function held(g: Genome, locus: MendelLocus): string[] {
  return ([0, 1] as const).map((hap) => locus.alleles[allele(g, locus, hap)] as string);
}

/** What a genome shows: allele names, or the blended rank for an incomplete locus. */
function shown(g: Genome, locus: MendelLocus): string[] {
  return locus.dominance === 'incomplete' ? [String(blended(g, locus.id))] : dominant(g, locus.id);
}

const same = (x: readonly string[], y: readonly string[]): boolean =>
  x.length === y.length && x.every((v, i) => v === y[i]);

function valueWords(id: ExplainedTrait, display: readonly string[]): string {
  if (id === 'texture') return TEXTURE_BLENDS[Math.round(Number(display[0]) * 2)] ?? 'smooth';
  return display.map((name) => WORDS[id][name] ?? name).join(' and ');
}

function how(source: TraitSource, carriers: readonly ('a' | 'b')[]): string {
  switch (source) {
    case 'both':
      return 'from both parents';
    case 'a':
      return 'from parent A';
    case 'b':
      return 'from parent B';
    case 'hidden':
      return carriers.length > 1
        ? 'from neither, hidden in both parents'
        : `from neither, hidden in parent ${(carriers[0] ?? 'a').toUpperCase()}`;
    case 'blend':
      return 'a mix of both parents';
    case 'new':
      return 'new, neither parent had it';
  }
}

/** Where the child's `id` trait comes from, given its two parents. */
export function explainTrait(
  child: Genome,
  a: Genome,
  b: Genome,
  id: ExplainedTrait,
): TraitExplanation {
  const locus = locusOf(id);
  const own = shown(child, locus);
  const parents = [
    { key: 'a', genome: a },
    { key: 'b', genome: b },
  ] as const;
  const showing = parents.filter((p) => same(shown(p.genome, locus), own)).map((p) => p.key);
  const everyHeld = new Set(parents.flatMap((p) => held(p.genome, locus)));
  const unseen =
    locus.dominance === 'incomplete'
      ? held(child, locus).some((name) => !everyHeld.has(name))
      : own.some((name) => !everyHeld.has(name));

  let source: TraitSource;
  let carriers: ('a' | 'b')[] = [];
  if (showing.length === 2) source = 'both';
  else if (showing.length === 1) source = showing[0] as 'a' | 'b';
  else if (unseen) source = 'new';
  else {
    carriers = parents
      .filter((p) => own.every((name) => held(p.genome, locus).includes(name)))
      .map((p) => p.key);
    source = carriers.length > 0 && locus.dominance !== 'incomplete' ? 'hidden' : 'blend';
    if (source === 'blend') carriers = [];
  }
  if (source === 'both') carriers = ['a', 'b'];
  else if (source === 'a' || source === 'b') carriers = [source];

  const value = valueWords(id, own);
  return {
    id,
    value,
    source,
    carriers,
    text: `${LABELS[id]}: ${value} (${how(source, carriers)}).`,
  };
}

/** Every simple-inheritance trait of a child, in display order. */
export function explainChild(child: Genome, a: Genome, b: Genome): TraitExplanation[] {
  return EXPLAINED_TRAITS.map((id) => explainTrait(child, a, b, id));
}
