import { describe, expect, it } from 'vitest';
import { genomeFromBase64url, genomeHash, genomeToBase64url } from '../genome/codec';
import { genesisGenome } from '../genome/genesis';
import { VISIBLE_PAIRS, visibleCount } from '../genome/organism';
import { seedFromString } from '../sim/prng';
import { EVOLVED, evolvedGrid, LAB_COUNT, labGenomes, specimenOf } from './specimens';

/** Seeds of the Evolved diversity test; `report:diversity` runs ten (`EVOLVED_SEEDS`). */
const VARIETY = ['evolved-variety-0', 'evolved-variety-1', 'evolved-variety-2'];

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

  it('breeds 4 lineages of 6 over 15 generations at the Lab rate (M6c T5)', () => {
    expect(EVOLVED).toEqual({ lineages: 4, size: 6, generations: 15, mutation: 4 });
    expect(EVOLVED.lineages * EVOLVED.size).toBe(LAB_COUNT);
  });

  it('shows evolved lineages: 24 distinct, valid bodies within the part budget, the same each time', () => {
    const grid = evolvedGrid('e1');
    expect(grid).toHaveLength(LAB_COUNT);
    expect(grid.map(genomeHash)).toEqual(evolvedGrid('e1').map(genomeHash));
    expect(labGenomes('e1', 'evolved').map(genomeHash)).toEqual(grid.map(genomeHash));
    const specimens = grid.map((g) => specimenOf(g));
    expect(new Set(specimens.map((s) => s.creature.hash)).size).toBe(LAB_COUNT);
    for (const s of specimens) {
      expect(s.violations).toEqual([]);
      expect(visibleCount(s.creature.plan)).toBeLessThanOrEqual(2 * VISIBLE_PAIRS);
    }
    // Bred, not drawn: no cell is one of its lineage's genesis cells, and another seed differs.
    const genesis = new Set(labGenomes('e1', 'genesis').map(genomeHash));
    for (const g of grid) expect(genesis.has(genomeHash(g))).toBe(false);
    expect(evolvedGrid('e2').map(genomeHash)).not.toEqual(grid.map(genomeHash));
  });

  it('starts each lineage from its own 6 genesis cells', () => {
    // A lineage's founders are genesis cells of `<seed>/evolved/<lineage>/<i>`: the grid differs when
    // a seed's founders do, and a founder is never a cell of the grid.
    const founder = genesisGenome(seedFromString('e1/evolved/0/0'));
    expect(evolvedGrid('e1').map(genomeHash)).not.toContain(genomeHash(founder));
  });

  it('breeds a grid within 600 ms (best of 3)', () => {
    const times = [0, 1, 2].map((i) => {
      const start = performance.now();
      evolvedGrid(`budget-${i}`);
      return performance.now() - start;
    });
    expect(Math.min(...times)).toBeLessThanOrEqual(600);
  });

  it('shows at least seven silhouette classes in the Evolved mode for every check seed', () => {
    // M6c T5: 7 classes in 9 of 10 seeds; three run here and all ten in `report:diversity`.
    for (const seed of VARIETY) {
      const classes = new Set(labGenomes(seed, 'evolved').map((g) => specimenOf(g).silhouette));
      expect(classes.size, seed).toBeGreaterThanOrEqual(7);
    }
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
