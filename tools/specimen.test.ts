import { describe, expect, it } from 'vitest';
import { genomeHash } from '../src/genome/codec';
import { SILHOUETTES } from '../src/genome/silhouette';
import { parseSpecimen } from '../src/lab/gallery';
import { specimenOf } from '../src/lab/specimens';
import {
  FEATURES,
  findFeature,
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

  it('finds a body for each look feature (ADR 0032), each valid', () => {
    expect(Object.keys(FEATURES)).toEqual(['antennae', 'big-eyes', 'spiral', 's-worm']);
    for (const feature of Object.keys(FEATURES) as (keyof typeof FEATURES)[]) {
      const found = findFeature(feature, 'specimen-test');
      expect(found, feature).not.toBeNull();
      const genome = found?.genome as NonNullable<typeof found>['genome'];
      const s = specimenOf(genome);
      expect(s.violations, feature).toEqual([]);
      const plan = s.creature.plan;
      if (feature === 'antennae') {
        // A bilateral chain with a slender front pair reaching past 1.8 core radii (02's copepods).
        expect(plan.form.radial).toBe(0);
        expect(plan.segments.length).toBeGreaterThanOrEqual(3);
        const front = plan.appendages.filter((a) => a.segment === 0 && a.length >= 1.8);
        expect(front.length).toBeGreaterThanOrEqual(2);
      } else if (feature === 'big-eyes') {
        // Big eyes set into the head (05's larvae).
        expect(plan.eyes.count).toBe(2);
        expect(plan.eyes.size).toBeGreaterThanOrEqual(0.25);
        expect(plan.eyes.stalk).toBeLessThanOrEqual(0.05);
      } else if (feature === 'spiral') {
        // A coiled chain with only short parts round it (03's and 05's spirals).
        expect(plan.form.mode).toBe(2);
        expect(plan.form.radial).toBe(0);
        expect(plan.segments.length).toBeGreaterThanOrEqual(4);
        for (const a of plan.appendages) expect(a.length).toBeLessThanOrEqual(0.75);
      } else {
        // A worm bent into an S of two opposite arcs of 0.6π or more, with parts no longer than a core
        // radius (02's and 05's worms, M6b T6).
        expect(s.silhouette).toBe('worm');
        for (const a of plan.appendages) expect(a.length).toBeLessThanOrEqual(1);
        expect(plan.form.mode).toBe(1);
        expect(plan.segments.length).toBeGreaterThanOrEqual(5);
        const angles = plan.segments.map((x) => x.angle);
        const peak = Math.max(...angles);
        expect(peak - (angles[0] as number)).toBeGreaterThanOrEqual(0.6 * Math.PI - 1e-9);
        expect(peak - (angles[angles.length - 1] as number)).toBeGreaterThanOrEqual(
          0.6 * Math.PI - 1e-9,
        );
      }
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
