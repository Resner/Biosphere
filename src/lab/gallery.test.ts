import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { encodeGenome, genomeHash } from '../genome/codec';
import { GENOME_BYTES } from '../genome/karyotype';
import { VISIBLE_PAIRS, visibleCount } from '../genome/organism';
import { SILHOUETTES } from '../genome/silhouette';
import {
  GALLERY_FILL,
  GALLERY_SIZE,
  type GalleryGrid,
  galleryCell,
  galleryGrid,
  gallerySpecimens,
  LABEL_HEIGHT,
  parseSpecimen,
} from './gallery';
import { REACH } from './grid';
import { specimenOf } from './specimens';

const DIR = new URL('../../tests/fixtures/gallery/', import.meta.url);
const fixtures = (): Record<string, string> =>
  Object.fromEntries(
    readdirSync(DIR)
      .filter((f) => f.endsWith('.hex'))
      .map((f) => [`/tests/fixtures/gallery/${f}`, readFileSync(new URL(f, DIR), 'utf8')]),
  );

/**
 * The baseline set: 01-06, the genesis cells of pass 0 (ADR 0024), keep their names and genomes, so
 * their round cells stay comparable with pass 1; they were karyotype v1 files until rules 8, which
 * stores each as its v2 padding (ADR 0032, 0040). 07-20 are the Lab's Evolved picks (ADR 0043).
 */
const BASELINE: readonly (readonly [file: string, hash: string])[] = [
  [
    '01-genesis-mabogibacter-lucens.hex',
    '856fa00deb9d2fe20fc9c070c68069b55b1dd7ec06d1292267a143b430031c35',
  ],
  [
    '02-genesis-bivamiplax-lucens.hex',
    'af75a27fc8cd8e42a4f65e83c5915b231937a77aa6a917cc2c89faa8e7158d1a',
  ],
  [
    '03-genesis-zimaviium-lucens.hex',
    '26767827f76319d66592c80ddff11a1699b51d28d75785c69c9cdafbf8cfd3b0',
  ],
  [
    '04-genesis-bolegibacter-natans.hex',
    '30bc50fd6eaedbea4cac619003edfd8d5c5052b3dd18e6485088b663b17939ca',
  ],
  [
    '05-genesis-larenatrix-lucens.hex',
    '851e2d0d89839fbc3100f21e946687e74d2609cb6fe205fd23eade1b06ca0d68',
  ],
  [
    '06-genesis-nogoziium-lucens.hex',
    '0949dde11f52db2b6a3755797dacf5e8b015db76cf7aa6e0614a56eded25c50d',
  ],
  // 07-20: the Lab's Evolved picks (M6c T5, ADR 0043), the last body of each lineage of the Evolved
  // sets gallery-m6c-0 to -3, which replaced the wild and bred cells of pass 0.
  [
    '07-evolved-sitesonema-serpens.hex',
    'b96623b5e7a3f3c8805aa3e66901674c889904717458f195f775d55625b42885',
  ],
  [
    '08-evolved-letelomonas-serpens.hex',
    'fec53a0d6a7395031292ffb215e46ee29319aa45420819268ea31bb1110d5f8c',
  ],
  [
    '09-evolved-zasovabacter-iridescens.hex',
    '787892379e70d5cfe0fe5bc9a7d49fb6c2e145adde6782d104fb29c73ab7a932',
  ],
  [
    '10-evolved-sedavoplax-serpens.hex',
    'a4418f04409b3703766665ffe2cdb69df08b8e30bb9ef231880fe14841217bd6',
  ],
  [
    '11-evolved-nomaloplax-filtrans.hex',
    'ec3f8c50ffa3437b2620222a227c4334f0e532494b23c8011db5ae915a3d15db',
  ],
  [
    '12-evolved-zotanerhiza-serpens.hex',
    '325b697ce0353494032bb855319a0f363327c21a9d32691e799039945c9fa7cc',
  ],
  [
    '13-evolved-sesesirhiza-serpens.hex',
    'f091e0ed2d52dbd4efa562db5c84d926fbeb30306bd1d18d2bd94a1c6e7910ac',
  ],
  [
    '14-evolved-rebigimonas-serpens.hex',
    '75258ed6d86ed80b704bf4e8ad71242362f0d5f515c2f5e982b1ef5701a841b9',
  ],
  [
    '15-evolved-viridiocus-serpens.hex',
    '8872049216b63a24d6bb0cee16976e6a05d9485622642b264eb883f2b7a2a18c',
  ],
  [
    '16-evolved-riralacilia-iridescens.hex',
    '2c9e2c70898c3aae114e460c44d50c139f130de235f7b013a3b1a0df03663601',
  ],
  [
    '17-evolved-galinizoon-serpens.hex',
    '8594c036bc1ee04d5c030a9164021665c1152982c555fdaef21eedd7b2284bba',
  ],
  [
    '18-evolved-sebominema-serpens.hex',
    'cb9d53b7206232d81f4aa392516b8b2c5d1668be4e3e081e8cf50a72a789b3b0',
  ],
  [
    '19-evolved-belabiphora-radiatus.hex',
    '25211320e30e17776e5abbfc73b266d8b21e72179573129363794f5147b44c3b',
  ],
  [
    '20-evolved-totetothrix-serpens.hex',
    'ca6f091121ff3f78f1c0b3cc4f38b6bc3f2adafdeca37a0eb91d1403943d0678',
  ],
];

describe('gallery specimen files', () => {
  it('reads a one-line comment and the genome hex, ignoring blank lines and case', () => {
    const genome = parseSpecimen('a.hex', `# A test cell.\n\n${'0A'.repeat(GENOME_BYTES)}\n`);
    expect(genome?.comment).toBe('A test cell.');
    expect(genome?.bytes).toBe(GENOME_BYTES);
    expect(encodeGenome(genome?.genome as NonNullable<typeof genome>['genome'])).toHaveLength(
      GENOME_BYTES,
    );
  });

  it('rejects a file without a comment, without hex, or with broken hex', () => {
    const hex = '00'.repeat(GENOME_BYTES);
    expect(parseSpecimen('a.hex', hex)).toBeNull();
    expect(parseSpecimen('a.hex', '# no genome\n')).toBeNull();
    expect(parseSpecimen('a.hex', `# odd\n${hex}0\n`)).toBeNull();
    expect(parseSpecimen('a.hex', `# not hex\n${hex.slice(2)}zz\n`)).toBeNull();
    expect(parseSpecimen('a.hex', `#\n${hex}\n`)).toBeNull();
  });

  it('orders the specimens by file name and names the broken file', () => {
    const hex = '00'.repeat(GENOME_BYTES);
    const set = gallerySpecimens({
      '/x/02-b.hex': `# b\n${hex}`,
      '/x/01-a.hex': `# a\n${hex}`,
      '/x/10-c.hex': `# c\n${hex}`,
    });
    expect(set.map((s) => s.file)).toEqual(['01-a.hex', '02-b.hex', '10-c.hex']);
    expect(() => gallerySpecimens({ '/x/03-bad.hex': 'nothing' })).toThrow(/03-bad\.hex/);
  });

  it('keeps the 20 baseline specimens first, pinned, each a valid body', () => {
    const set = gallerySpecimens(fixtures());
    expect(set.length).toBeGreaterThanOrEqual(BASELINE.length);
    for (const [i, [file, hash]] of BASELINE.entries()) {
      const s = set[i];
      expect(s?.file).toBe(file);
      expect(s?.bytes).toBe(GENOME_BYTES);
      expect(genomeHash(s?.genome as NonNullable<typeof s>['genome'])).toBe(hash);
    }
    expect(new Set(set.map((s) => genomeHash(s.genome))).size).toBe(set.length);
    for (const s of set) {
      expect(s.comment.length).toBeGreaterThan(10);
      expect(specimenOf(s.genome).violations).toEqual([]);
    }
    // 6 genesis cells, then 14 picks from the Lab's Evolved mode (M6c T5).
    expect(BASELINE.filter(([f]) => f.includes('-genesis-'))).toHaveLength(6);
    expect(BASELINE.slice(6).every(([f]) => f.includes('-evolved-'))).toBe(true);
  });
});

describe('the baseline bodies (look pass 5, ADR 0032; M6c T5)', () => {
  it('gives the bilateral evolved chains the long proportions', () => {
    const baseline = gallerySpecimens(fixtures()).slice(0, BASELINE.length);
    const long = baseline.filter((s) => specimenOf(s.genome).creature.plan.form.slim < 1);
    // The evolved chains of 3 or more segments are drawn long; 11, 15 and 19 are radial and 16 a
    // single cell, so they stay round, and so do the genesis cells.
    expect(long.map((s) => s.file.slice(0, 2))).toEqual([
      '07',
      '08',
      '09',
      '10',
      '12',
      '13',
      '14',
      '17',
      '18',
      '20',
    ]);
  });

  it('shows evolved lineages that left the cell stage, within the part budget', () => {
    const evolved = gallerySpecimens(fixtures()).slice(6, BASELINE.length);
    const plans = evolved.map((s) => specimenOf(s.genome).creature.plan);
    expect(plans.filter((p) => p.segments.length >= 3).length).toBeGreaterThanOrEqual(10);
    for (const p of plans) expect(visibleCount(p)).toBeLessThanOrEqual(2 * VISIBLE_PAIRS);
  });
});

describe('gallery specimens added by M6 T9', () => {
  const set = gallerySpecimens(fixtures()).slice(BASELINE.length, BASELINE.length + 16);
  const classes = SILHOUETTES.filter((s) => s !== 'other');

  it('adds 16 karyotype v2 specimens after the baseline 20', () => {
    expect(set).toHaveLength(16);
    for (const s of set) {
      expect(s.file).toMatch(/^\d\d-specimen-/);
      expect(s.bytes).toBe(GENOME_BYTES);
    }
  });

  it('has one specimen per silhouette class except other, each verified by silhouetteOf', () => {
    const got = set.slice(0, classes.length);
    expect(got.map((s) => specimenOf(s.genome).silhouette)).toEqual(classes);
    for (const [i, s] of got.entries()) expect(s.file).toContain(`-specimen-${classes[i]}-`);
  });

  it('has one specimen per rarity tier, by rarity', () => {
    const tiers = set.slice(classes.length);
    expect(tiers.map((s) => specimenOf(s.genome).rarity)).toEqual([
      'common',
      'uncommon',
      'rare',
      'exotic',
    ]);
    for (const s of tiers) expect(s.file).toContain('-specimen-tier-');
  });
});

describe('gallery specimens added by look pass 5 (M6 T28c, ADR 0032) and M6b T6', () => {
  it('adds one karyotype v2 specimen per look feature after the 36, 40 in all', () => {
    const all = gallerySpecimens(fixtures());
    expect(all).toHaveLength(40);
    const added = all.slice(36);
    expect(
      added.map((s) => s.file.replace(/^(\d\d-specimen-[a-z-]+?)-[a-z]+-[a-z]+\.hex$/, '$1')),
    ).toEqual([
      '37-specimen-antennae',
      '38-specimen-big-eyes',
      '39-specimen-spiral',
      '40-specimen-s-worm',
    ]);
    for (const s of added) expect(s.bytes).toBe(GENOME_BYTES);
  });
});

describe('gallery grid', () => {
  const fits = (g: GalleryGrid, count: number) => {
    expect(g.cols * g.rows).toBeGreaterThanOrEqual(count);
    // The longest body reaches REACH core radii from its core in every direction and fits its cell.
    expect(2 * REACH * g.radius).toBeLessThanOrEqual(g.cellW);
    expect(2 * REACH * g.radius).toBeLessThanOrEqual(g.cellH - LABEL_HEIGHT);
  };

  it('lays the baseline 20 out 7 by 3, 36 out 9 by 4 and the 39 of pass 5 out 8 by 5', () => {
    const { width, height } = GALLERY_SIZE;
    expect(galleryGrid(20, width, height)).toMatchObject({ cols: 7, rows: 3 });
    expect(galleryGrid(36, width, height)).toMatchObject({ cols: 9, rows: 4 });
    expect(galleryGrid(39, width, height)).toMatchObject({ cols: 8, rows: 5 });
    for (const n of [1, 2, 7, 20, 24, 36, 37, 48, 60]) fits(galleryGrid(n, width, height), n);
  });

  it('chooses the layout that draws every body largest', () => {
    const { width, height } = GALLERY_SIZE;
    for (const n of [5, 20, 36, 50]) {
      const best = galleryGrid(n, width, height);
      for (let cols = 1; cols <= n; cols++) {
        const rows = Math.ceil(n / cols);
        const r = Math.min(width / cols, height / rows - LABEL_HEIGHT) / (2 * REACH);
        expect(r * GALLERY_FILL).toBeLessThanOrEqual(best.radius + 1e-9);
      }
    }
  });

  it('places cells row by row from the top left', () => {
    const g = galleryGrid(36, 1600, 1000);
    expect(galleryCell(0, g)).toEqual({ x: 0, y: 0, w: 1600 / 9, h: 250 });
    expect(galleryCell(10, g)).toEqual({ x: 1600 / 9, y: 250, w: 1600 / 9, h: 250 });
    expect(galleryCell(35, g)).toEqual({ x: (8 * 1600) / 9, y: 750, w: 1600 / 9, h: 250 });
  });
});
