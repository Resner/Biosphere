import { describe, expect, it } from 'vitest';
import {
  BAND_TEXT,
  type InbreedingBand,
  inbreeding,
  inbreedingBand,
  kinship,
  type Pedigree,
} from './pedigree';

const BANNED = /allele|locus|quant|haplotype|gene|recessive|dominant|homozyg|coefficient|kinship/i;

/** Founders have no entry worth reading (null); every other creature names its two parents. */
function pedigree(entries: Record<string, [string, string] | null>): Pedigree {
  return new Map(Object.entries(entries));
}

const FAMILY = pedigree({
  f1: null,
  f2: null,
  f3: null,
  f4: null,
  // Full siblings.
  s1: ['f1', 'f2'],
  s2: ['f1', 'f2'],
  // A half-sibling of s1 and s2.
  h1: ['f1', 'f3'],
  // A niece of s1 (and of s2), and the child of two full siblings.
  n1: ['s1', 'f4'],
  inc: ['s1', 's2'],
  // First cousins.
  c1: ['s1', 'f3'],
  c2: ['s2', 'f4'],
});

describe('kinship', () => {
  it('is zero for unrelated founders', () => {
    expect(kinship(FAMILY, 'f1', 'f2')).toBe(0);
    expect(kinship(FAMILY, 'f3', 'f4')).toBe(0);
  });

  it('is a quarter for a parent and a child, and for full siblings', () => {
    expect(kinship(FAMILY, 's1', 'f1')).toBe(0.25);
    expect(kinship(FAMILY, 'f2', 's2')).toBe(0.25);
    expect(kinship(FAMILY, 's1', 's2')).toBe(0.25);
  });

  it('is an eighth for half-siblings and for an uncle and a niece', () => {
    expect(kinship(FAMILY, 's1', 'h1')).toBe(0.125);
    expect(kinship(FAMILY, 's2', 'n1')).toBe(0.125);
  });

  it('is a sixteenth for first cousins', () => {
    expect(kinship(FAMILY, 'c1', 'c2')).toBe(0.0625);
  });

  it('is symmetric', () => {
    const ids = [...FAMILY.keys()];
    for (const a of ids)
      for (const b of ids) expect(kinship(FAMILY, a, b)).toBe(kinship(FAMILY, b, a));
  });

  it('gives a creature with itself half of one plus its own inbreeding', () => {
    expect(kinship(FAMILY, 'f1', 'f1')).toBe(0.5);
    expect(kinship(FAMILY, 's1', 's1')).toBe(0.5);
    expect(kinship(FAMILY, 'inc', 'inc')).toBe(0.625);
  });

  it('gives the child of full siblings an inbreeding of a quarter and a kinship of 0.375 with a parent', () => {
    expect(inbreeding(FAMILY, 'inc')).toBe(0.25);
    expect(kinship(FAMILY, 'inc', 's1')).toBe(0.375);
    expect(inbreeding(FAMILY, 's1')).toBe(0);
    expect(inbreeding(FAMILY, 'f1')).toBe(0);
    expect(inbreeding(FAMILY, 'c1')).toBe(0);
  });

  it('treats a creature the pedigree does not know as an unrelated founder', () => {
    expect(kinship(FAMILY, 'ghost', 's1')).toBe(0);
    expect(inbreeding(FAMILY, 'ghost')).toBe(0);
  });

  it('ignores ancestors more than six generations up, deterministically', () => {
    const chain: Record<string, [string, string] | null> = { g0: null };
    for (let i = 1; i <= 9; i++) chain[`g${i}`] = [`g${i - 1}`, `x${i}`];
    const p = pedigree(chain);
    expect(kinship(p, 'g6', 'g0')).toBe(2 ** -7);
    expect(kinship(p, 'g0', 'g6')).toBe(2 ** -7);
    expect(kinship(p, 'g7', 'g0')).toBe(0);
    expect(kinship(p, 'g9', 'g0')).toBe(0);
    expect(kinship(p, 'g9', 'g3')).toBe(2 ** -7);
  });

  it('cuts inbreeding at the same depth', () => {
    // Two full siblings seven generations up: their shared parents are beyond the cut for the child.
    const chain: Record<string, [string, string] | null> = { a: null, b: null };
    chain.sa = ['a', 'b'];
    chain.sb = ['a', 'b'];
    let left = 'sa';
    let right = 'sb';
    for (let i = 1; i <= 7; i++) {
      chain[`l${i}`] = [left, `xl${i}`];
      chain[`r${i}`] = [right, `xr${i}`];
      left = `l${i}`;
      right = `r${i}`;
    }
    chain.kid = [left, right];
    // l7 and r7 each sit seven generations below the siblings, so the siblings are beyond the cut.
    expect(inbreeding(pedigree(chain), 'kid')).toBe(0);
    // Four links down the siblings are level 5 for the child and their parents are still inside.
    chain.kid4 = ['l4', 'r4'];
    expect(inbreeding(pedigree(chain), 'kid4')).toBe(2 ** -10);
    // One more link and the siblings' parents fall outside.
    chain.kid5 = ['l5', 'r5'];
    expect(inbreeding(pedigree(chain), 'kid5')).toBe(0);
  });

  it('terminates on a malformed cycle', () => {
    const p = pedigree({ a: ['b', 'b'], b: ['a', 'a'] });
    expect(Number.isFinite(kinship(p, 'a', 'b'))).toBe(true);
  });

  it('handles a long chain without recursing per generation', () => {
    const chain: Record<string, [string, string] | null> = { g0: null };
    for (let i = 1; i <= 20_000; i++) chain[`g${i}`] = [`g${i - 1}`, `f${i}`];
    expect(kinship(pedigree(chain), 'g20000', 'g19999')).toBe(0.25);
  });
});

describe('inbreedingBand', () => {
  const cases: [number, InbreedingBand][] = [
    [0, 'none'],
    [0.029, 'none'],
    [0.03, 'low'],
    [0.0625, 'low'],
    [0.099, 'low'],
    [0.1, 'moderate'],
    [0.125, 'moderate'],
    [0.199, 'moderate'],
    [0.2, 'high'],
    [0.25, 'high'],
    [0.5, 'high'],
  ];
  it.each(cases)('puts %d in the %s band', (f, band) => {
    expect(inbreedingBand(f)).toBe(band);
  });

  it('says each band in plain words', () => {
    for (const band of ['none', 'low', 'moderate', 'high'] as const) {
      const text = BAND_TEXT[band];
      expect(text.length).toBeGreaterThan(10);
      expect(text.endsWith('.')).toBe(true);
      expect(BANNED.test(text)).toBe(false);
    }
  });

  it('bands the family examples as the design says', () => {
    expect(inbreedingBand(kinship(FAMILY, 's1', 's2'))).toBe('high');
    expect(inbreedingBand(kinship(FAMILY, 'c1', 'c2'))).toBe('low');
    expect(inbreedingBand(kinship(FAMILY, 's1', 'h1'))).toBe('moderate');
    expect(inbreedingBand(kinship(FAMILY, 'f1', 'f2'))).toBe('none');
  });
});
