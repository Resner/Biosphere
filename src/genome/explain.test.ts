import { describe, expect, it } from 'vitest';
import { withAlleles } from '../../tests/archetypes';
import type { Genome } from './codec';
import { EXPLAINED_TRAITS, explainChild, explainTrait, type TraitSource } from './explain';
import { LOCI, type MendelLocus } from './karyotype';
import { starterGenome } from './starter';

const base = starterGenome();
const index = (id: string, name: string): number =>
  (LOCI.find((l) => l.id === id) as MendelLocus).alleles.indexOf(name);
/** A genome whose two haplotypes carry these named alleles at one locus. */
const having = (id: string, first: string, second: string): Genome =>
  withAlleles(base, { [id]: [index(id, first), index(id, second)] });

interface Case {
  name: string;
  id: string;
  child: [string, string];
  a: [string, string];
  b: [string, string];
  source: TraitSource;
  carriers: ('a' | 'b')[];
  text: string;
}

const CASES: Case[] = [
  {
    name: 'plain iridescence shown by both parents',
    id: 'iridescence',
    child: ['plain', 'oil'],
    a: ['plain', 'plain'],
    b: ['plain', 'oil'],
    source: 'both',
    carriers: ['a', 'b'],
    text: 'Iridescence: none (from both parents).',
  },
  {
    name: 'iridescence hidden in both parents',
    id: 'iridescence',
    child: ['iridescent', 'iridescent'],
    a: ['iridescent', 'plain'],
    b: ['plain', 'iridescent'],
    source: 'hidden',
    carriers: ['a', 'b'],
    text: 'Iridescence: an iridescent sheen (from neither, hidden in both parents).',
  },
  {
    name: 'iridescence hidden in parent A only',
    id: 'iridescence',
    child: ['iridescent', 'oil'],
    a: ['iridescent', 'plain'],
    b: ['oil', 'oil'],
    source: 'hidden',
    carriers: ['a'],
    text: 'Iridescence: an iridescent sheen (from neither, hidden in parent A).',
  },
  {
    name: 'iridescence shown by parent A only',
    id: 'iridescence',
    child: ['plain', 'oil'],
    a: ['plain', 'plain'],
    b: ['oil', 'oil'],
    source: 'a',
    carriers: ['a'],
    text: 'Iridescence: none (from parent A).',
  },
  {
    name: 'iridescence shown by parent B only',
    id: 'iridescence',
    child: ['oil', 'oil'],
    a: ['plain', 'plain'],
    b: ['oil', 'oil'],
    source: 'b',
    carriers: ['b'],
    text: 'Iridescence: an oil-slick sheen (from parent B).',
  },
  {
    name: 'an allele neither parent had',
    id: 'iridescence',
    child: ['oil', 'oil'],
    a: ['plain', 'plain'],
    b: ['plain', 'iridescent'],
    source: 'new',
    carriers: [],
    text: 'Iridescence: an oil-slick sheen (new, neither parent had it).',
  },
  {
    name: 'blended texture shown by neither parent',
    id: 'texture',
    child: ['smooth', 'grainy'],
    a: ['smooth', 'smooth'],
    b: ['grainy', 'grainy'],
    source: 'blend',
    carriers: [],
    text: 'Skin: between smooth and grainy (a mix of both parents).',
  },
  {
    name: 'blended texture shown by both parents',
    id: 'texture',
    child: ['smooth', 'grainy'],
    a: ['grainy', 'smooth'],
    b: ['smooth', 'grainy'],
    source: 'both',
    carriers: ['a', 'b'],
    text: 'Skin: between smooth and grainy (from both parents).',
  },
  {
    name: 'texture shown by parent A only',
    id: 'texture',
    child: ['grainy', 'grainy'],
    a: ['grainy', 'grainy'],
    b: ['smooth', 'smooth'],
    source: 'a',
    carriers: ['a'],
    text: 'Skin: grainy (from parent A).',
  },
  {
    name: 'a texture neither parent had',
    id: 'texture',
    child: ['ridged', 'ridged'],
    a: ['smooth', 'grainy'],
    b: ['smooth', 'smooth'],
    source: 'new',
    carriers: [],
    text: 'Skin: ridged (new, neither parent had it).',
  },
  {
    name: 'spots shown by both parents',
    id: 'pattern',
    child: ['spots', 'none'],
    a: ['spots', 'none'],
    b: ['spots', 'rings'],
    source: 'both',
    carriers: ['a', 'b'],
    text: 'Pattern: spots (from both parents).',
  },
  {
    name: 'spots and stripes, one from each parent',
    id: 'pattern',
    child: ['spots', 'stripes'],
    a: ['spots', 'none'],
    b: ['stripes', 'none'],
    source: 'blend',
    carriers: [],
    text: 'Pattern: spots and stripes (a mix of both parents).',
  },
  {
    name: 'pattern shown by parent A only',
    id: 'pattern',
    child: ['spots', 'none'],
    a: ['spots', 'spots'],
    b: ['none', 'none'],
    source: 'a',
    carriers: ['a'],
    text: 'Pattern: spots (from parent A).',
  },
  {
    name: 'a pattern hidden in both parents',
    id: 'pattern',
    child: ['spots', 'spots'],
    a: ['bands', 'spots'],
    b: ['spots', 'bands'],
    source: 'hidden',
    carriers: ['a', 'b'],
    text: 'Pattern: spots (from neither, hidden in both parents).',
  },
  {
    name: 'albino colouring hidden in both parents',
    id: 'albino',
    child: ['albino', 'albino'],
    a: ['normal', 'albino'],
    b: ['normal', 'albino'],
    source: 'hidden',
    carriers: ['a', 'b'],
    text: 'Colouring: albino (from neither, hidden in both parents).',
  },
  {
    name: 'normal colouring shown by both parents',
    id: 'albino',
    child: ['normal', 'normal'],
    a: ['normal', 'albino'],
    b: ['normal', 'normal'],
    source: 'both',
    carriers: ['a', 'b'],
    text: 'Colouring: normal (from both parents).',
  },
  {
    name: 'a steady glow shown by parent A only',
    id: 'luminescence',
    child: ['on', 'off'],
    a: ['on', 'off'],
    b: ['off', 'off'],
    source: 'a',
    carriers: ['a'],
    text: 'Glow: a steady glow (from parent A).',
  },
  {
    name: 'a pulsing glow hidden in both parents',
    id: 'luminescence',
    child: ['pulse', 'pulse'],
    a: ['on', 'pulse'],
    b: ['pulse', 'on'],
    source: 'hidden',
    carriers: ['a', 'b'],
    text: 'Glow: a pulsing glow (from neither, hidden in both parents).',
  },
  {
    name: 'hunting preference shown by parent B only',
    id: 'targetPref',
    child: ['weakest', 'weakest'],
    a: ['nearest', 'weakest'],
    b: ['weakest', 'weakest'],
    source: 'b',
    carriers: ['b'],
    text: 'Prey: the weakest (from parent B).',
  },
  {
    name: 'a hunting preference that is new',
    id: 'targetPref',
    child: ['strongest', 'strongest'],
    a: ['nearest', 'nearest'],
    b: ['weakest', 'nearest'],
    source: 'new',
    carriers: [],
    text: 'Prey: the strongest (new, neither parent had it).',
  },
];

describe('explainTrait', () => {
  it.each(CASES)('$name', ({ id, child, a, b, source, carriers, text }) => {
    const explained = explainTrait(
      having(id, ...child),
      having(id, ...a),
      having(id, ...b),
      id as (typeof EXPLAINED_TRAITS)[number],
    );
    expect(explained.source).toBe(source);
    expect(explained.carriers).toEqual(carriers);
    expect(explained.text).toBe(text);
  });

  it('has at least 20 cases', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(20);
  });

  it('swapping the parents swaps A and B', () => {
    const swap = { a: 'b', b: 'a', both: 'both', hidden: 'hidden', blend: 'blend', new: 'new' };
    for (const { id, child, a, b } of CASES) {
      const key = id as (typeof EXPLAINED_TRAITS)[number];
      const one = explainTrait(having(id, ...child), having(id, ...a), having(id, ...b), key);
      const two = explainTrait(having(id, ...child), having(id, ...b), having(id, ...a), key);
      expect(two.source).toBe(swap[one.source]);
      expect(two.carriers).toEqual(one.carriers.map((c) => (c === 'a' ? 'b' : 'a')).sort());
    }
  });
});

describe('explainChild', () => {
  it('covers every trait that follows simple inheritance, in order, in plain words', () => {
    const lines = explainChild(starterGenome(), starterGenome(), starterGenome());
    expect(lines.map((l) => l.id)).toEqual([...EXPLAINED_TRAITS]);
    for (const line of lines) {
      expect(line.text).not.toMatch(/allele|locus|quant|haplotype|gene|dominan|recessiv/i);
      expect(line.text.endsWith('.')).toBe(true);
      expect(line.source).toBe('both');
    }
  });
});
