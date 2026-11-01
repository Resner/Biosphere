import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { encodeGenome, genomeHash } from '../genome/codec';
import { GENOME_BYTES } from '../genome/karyotype';
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
 * The baseline set of pass 0 (ADR 0024): later specimens extend the gallery, never replace one, so
 * these files keep their names and their genomes. They were karyotype v1 files until rules 8, which
 * stores each as its v2 padding, the body the sheet has drawn since look pass 5 (ADR 0032, 0040).
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
  [
    '07-wild-mezamarhiza-serpens.hex',
    '50c0dffdc8a9aea6ac775b90b52daf6e1c3c9e80de10256f4cff98b00ed16995',
  ],
  [
    '08-wild-logamaocus-albus.hex',
    '438ca190c1abdea6c17a835ea310a5eceb157f1a906af55ec4c1dc5be147787f',
  ],
  [
    '09-wild-retizespira-serpens.hex',
    '7acd1ee897e0da0cdea4c4e0cdca7942d6c34ffb97b382d5cbe6e7fb076ec672',
  ],
  [
    '10-wild-zevalospora-spinosus.hex',
    '643df369de471c11e2739422b936678c6988db2889449b9e76f15f024720ee9d',
  ],
  [
    '11-wild-rimazispira-ferox.hex',
    '58c42f0558372a0460afb357b0769aa194a13b772a04558331beb0b0af0ed800',
  ],
  [
    '12-wild-nenazeula-serpens.hex',
    '1adc7f66ad6b15974df1dc318d536a63ae29771b90f1057e1245c9aa3484927a',
  ],
  [
    '13-wild-gegorozoon-iridescens.hex',
    '602fdce6423d71fdae57593c021ef562d2bcfdd0bc4844eb4ddf37b00b3c4cad',
  ],
  [
    '14-bred-zironeina-lucens.hex',
    '5911a87de6bb46a91e76dd02c598905aee51898d75fb107f4bc765daab231f25',
  ],
  [
    '15-bred-retadithrix-natans.hex',
    '3e043b6bf6141503d5a23b528d45ff97fde242fcb84ded2ae0e0b7344c612e39',
  ],
  [
    '16-bred-begaviella-lucens.hex',
    '98e40254cf965fe180d73501f8ac374f35ba83d17cf296e7a07a46b415ab6d0b',
  ],
  [
    '17-bred-tatirimonas-serpens.hex',
    'a1cd34ec420ca91d68cd565744d648f785f400bea4e8afbcc636571cff04ead7',
  ],
  [
    '18-bred-daralafera-serpens.hex',
    'db87e523a40605973ff74e39a28bf363aaac10ad17c7753c3ee7ed286745cd31',
  ],
  [
    '19-bred-ronenoonas-serpens.hex',
    'd195553c93a6295792fa7d5330b1ea170ef8206e6b24df4b80c0ec0d7116bfe6',
  ],
  [
    '20-bred-bazerospira-lucens.hex',
    'e52d1fe6e9f95034a469523428b34bc36f814da389ca7a27df26834372bf9f62',
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

  it('keeps the 20 baseline specimens first, unchanged, each a valid body', () => {
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
    // 6 genesis cells, then 14 picks from the Lab's wild mode and bred children.
    expect(BASELINE.filter(([f]) => f.includes('-genesis-'))).toHaveLength(6);
  });
});

describe('the baseline bodies (look pass 5, ADR 0032)', () => {
  it('gives the baseline chains the long proportions', () => {
    const baseline = gallerySpecimens(fixtures()).slice(0, BASELINE.length);
    const long = baseline.filter((s) => specimenOf(s.genome).creature.plan.form.slim < 1);
    // 07, 09, 10, 11, 12, 18 and 19 are chains of 3 or more segments, drawn long.
    expect(long.map((s) => s.file.slice(0, 2))).toEqual(['07', '09', '10', '11', '12', '18', '19']);
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
