import { describe, expect, it } from 'vitest';
import { genomeFromBase64url, genomeToBase64url } from '../genome/codec';
import { LAB_COUNT, labGenomes, specimenOf } from './specimens';

describe('Lab specimens', () => {
  it('makes 24 distinct, valid genesis creatures from a seed, the same each time', () => {
    const a = labGenomes('lab-seed', 'genesis').map((g) => specimenOf(g));
    const b = labGenomes('lab-seed', 'genesis').map((g) => specimenOf(g));
    expect(a).toHaveLength(LAB_COUNT);
    expect(new Set(a.map((s) => s.creature.hash)).size).toBe(LAB_COUNT);
    expect(a.map((s) => s.creature.hash)).toEqual(b.map((s) => s.creature.hash));
    for (const s of a) expect(s.violations).toEqual([]);
    const other = labGenomes('another-seed', 'genesis').map((g) => specimenOf(g).creature.hash);
    expect(other).not.toEqual(a.map((s) => s.creature.hash));
  });

  it('makes wild creatures from random bytes, and every body is valid', () => {
    for (const seed of ['w1', 'w2', 'w3', 'w4', 'w5']) {
      const wild = labGenomes(seed, 'wild').map((g) => specimenOf(g));
      expect(new Set(wild.map((s) => s.creature.hash)).size).toBe(LAB_COUNT);
      for (const s of wild) expect(s.violations).toEqual([]);
    }
    const genesis = labGenomes('w1', 'genesis').map((g) => genomeToBase64url(g));
    const wild = labGenomes('w1', 'wild').map((g) => genomeToBase64url(g));
    expect(wild).not.toEqual(genesis);
  });

  it('shows at least eight silhouette classes in the wild mode for 9 of 10 seeds', () => {
    const rich = Array.from({ length: 10 }, (_, i) => `wild-variety-${i}`).filter(
      (seed) => new Set(labGenomes(seed, 'wild').map((g) => specimenOf(g).silhouette)).size >= 8,
    );
    expect(rich.length).toBeGreaterThanOrEqual(9);
  });

  it('describes a creature in plain words with a species name, rarity and vertex count', () => {
    const [genome] = labGenomes('plain', 'genesis');
    const s = specimenOf(genome as NonNullable<typeof genome>);
    expect(s.species).toMatch(/^[A-Z][a-z]+ [a-z]+$/);
    expect(['common', 'uncommon', 'rare', 'exotic']).toContain(s.rarity);
    expect(s.lines).toHaveLength(6);
    expect(s.vertices).toBeGreaterThan(0);
    expect(s.vertices).toBeLessThanOrEqual(12_000);
    expect(s.tier).toBeGreaterThanOrEqual(0);
  });

  it('keeps genomes round-trippable through their text form', () => {
    for (const g of labGenomes('rt', 'wild')) {
      expect(genomeToBase64url(genomeFromBase64url(genomeToBase64url(g)) as typeof g)).toBe(
        genomeToBase64url(g),
      );
    }
  });
});
