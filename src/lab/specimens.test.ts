import { describe, expect, it } from 'vitest';
import { genomeFromBase64url, genomeHash, genomeToBase64url } from '../genome/codec';
import { genesisGenome } from '../genome/genesis';
import { VISIBLE_PAIRS, visibleCount } from '../genome/organism';
import { seedFromString } from '../sim/prng';
import {
  AIMS,
  EVOLVED,
  EVOLVED_CLASSES,
  EVOLVED_SEEDS,
  evolvedAims,
  evolvedGrid,
  LAB_COUNT,
  labGenomes,
  silhouetteClasses,
  specimenOf,
} from './specimens';

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

  it('breeds 4 lineages of 6 cells from genesis at the Lab rate (M6c T5)', () => {
    expect(EVOLVED).toEqual({ lineages: 4, size: 6, generations: 60, brood: 3 });
    expect(EVOLVED.lineages * EVOLVED.size).toBe(LAB_COUNT);
    // Every lineage of a grid has its own aim.
    for (const seed of ['a1', 'a2', 'a3']) {
      const aims = evolvedAims(seed);
      expect(aims).toHaveLength(EVOLVED.lineages);
      expect(new Set(aims).size).toBe(EVOLVED.lineages);
      for (const aim of aims) expect(Object.keys(AIMS)).toContain(aim);
    }
  });

  it('shows evolved lineages: 24 distinct, valid bodies within the part budget, the same each time', () => {
    const grid = evolvedGrid('e1');
    expect(grid).toHaveLength(LAB_COUNT);
    expect(labGenomes('e1', 'evolved').map(genomeHash)).toEqual(grid.map(genomeHash));
    const specimens = grid.map((g) => specimenOf(g));
    expect(new Set(specimens.map((s) => s.creature.hash)).size).toBe(LAB_COUNT);
    for (const s of specimens) {
      expect(s.violations).toEqual([]);
      expect(visibleCount(s.creature.plan)).toBeLessThanOrEqual(2 * VISIBLE_PAIRS);
    }
    expect(evolvedGrid('e2').map(genomeHash)).not.toEqual(grid.map(genomeHash));
  });

  it('reads each row from its founder, a genesis cell, to bred bodies that grow segments', () => {
    const grid = evolvedGrid('e1');
    const segments = grid.map((g) => specimenOf(g).creature.plan.segments.length);
    for (let k = 0; k < EVOLVED.lineages; k++) {
      const founder = genesisGenome(seedFromString(`e1/evolved/${k}/0`));
      expect(genomeHash(grid[k * EVOLVED.size] as typeof founder)).toBe(genomeHash(founder));
      expect(segments[k * EVOLVED.size]).toBe(1);
    }
    // Selection reaches chains: a lineage bred for 60 generations leaves the cell stage.
    expect(Math.max(...segments)).toBeGreaterThanOrEqual(4);
  });

  it('breeds a grid within 600 ms (best of 3)', () => {
    const times = [0, 1, 2].map((i) => {
      const start = performance.now();
      evolvedGrid(`budget-${i}`);
      return performance.now() - start;
    });
    expect(Math.min(...times)).toBeLessThanOrEqual(600);
  });

  it('shows at least five silhouette classes in the Evolved mode for 2 of the first 3 seeds', () => {
    // M6c T5: five classes in 9 of 10 seeds; three run here, all ten in `report:diversity`.
    const rich = EVOLVED_SEEDS.slice(0, 3).filter(
      (seed) => silhouetteClasses(labGenomes(seed, 'evolved')) >= EVOLVED_CLASSES,
    );
    expect(EVOLVED_CLASSES).toBe(5);
    expect(rich.length).toBeGreaterThanOrEqual(2);
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
    for (const g of labGenomes('rt', 'evolved')) {
      expect(genomeToBase64url(genomeFromBase64url(genomeToBase64url(g)) as typeof g)).toBe(
        genomeToBase64url(g),
      );
    }
  });
});
