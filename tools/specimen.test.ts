import { describe, expect, it } from 'vitest';
import { genomeHash, genomeKaryotype } from '../src/genome/codec';
import { SILHOUETTES } from '../src/genome/silhouette';
import { parseSpecimen } from '../src/lab/gallery';
import { specimenOf } from '../src/lab/specimens';
import {
  findSpecimen,
  findTier,
  SPECIMEN_SILHOUETTES,
  SPECIMEN_TIERS,
  specimenFile,
} from './specimen';

describe('specimen search', () => {
  it('has the twelve silhouette classes except other, and the four rarity tiers', () => {
    expect(SPECIMEN_SILHOUETTES).toEqual(SILHOUETTES.filter((s) => s !== 'other'));
    expect(SPECIMEN_SILHOUETTES).toHaveLength(12);
    expect(SPECIMEN_TIERS).toEqual(['common', 'uncommon', 'rare', 'exotic']);
  });

  it('finds a valid v2 body of each class, verified by silhouetteOf', () => {
    for (const target of SPECIMEN_SILHOUETTES) {
      const found = findSpecimen(target, 'specimen-test');
      expect(found, target).not.toBeNull();
      const s = specimenOf(found?.genome as NonNullable<typeof found>['genome']);
      expect(s.silhouette, target).toBe(target);
      expect(s.violations, target).toEqual([]);
      expect(genomeKaryotype(found?.genome as NonNullable<typeof found>['genome'])).toBe(2);
    }
  });

  it('finds a body of each rarity tier', () => {
    for (const tier of SPECIMEN_TIERS) {
      const found = findTier(tier, 'specimen-test');
      expect(found, tier).not.toBeNull();
      const s = specimenOf(found?.genome as NonNullable<typeof found>['genome']);
      expect(s.rarity, tier).toBe(tier);
      expect(s.violations, tier).toEqual([]);
    }
  });

  it('is deterministic from the seed, and a new seed finds another body', () => {
    const a = findSpecimen('crab', 'one');
    const b = findSpecimen('crab', 'one');
    const c = findSpecimen('crab', 'two');
    expect(genomeHash(a?.genome as NonNullable<typeof a>['genome'])).toBe(
      genomeHash(b?.genome as NonNullable<typeof b>['genome']),
    );
    expect(genomeHash(a?.genome as NonNullable<typeof a>['genome'])).not.toBe(
      genomeHash(c?.genome as NonNullable<typeof c>['genome']),
    );
  });

  it('skips genomes that are taken, so the specimens differ', () => {
    const first = findSpecimen('cell', 'taken-test');
    const hash = genomeHash(first?.genome as NonNullable<typeof first>['genome']);
    const second = findSpecimen('cell', 'taken-test', new Set([hash]));
    expect(genomeHash(second?.genome as NonNullable<typeof second>['genome'])).not.toBe(hash);
  });

  it('writes a gallery file that reads back as the same genome', () => {
    const found = findSpecimen('shrimp', 'file-test');
    const { name, text } = specimenFile(
      21,
      'shrimp',
      found?.genome as NonNullable<typeof found>['genome'],
      'file-test',
    );
    expect(name).toMatch(/^21-specimen-shrimp-[a-z]+-[a-z]+\.hex$/);
    const back = parseSpecimen(name, text);
    expect(back?.comment).toMatch(/shrimp/);
    expect(genomeHash(back?.genome as NonNullable<typeof back>['genome'])).toBe(
      genomeHash(found?.genome as NonNullable<typeof found>['genome']),
    );
  });
});
