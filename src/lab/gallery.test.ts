import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { encodeGenome, genomeHash } from '../genome/codec';
import { GENOME_BYTES } from '../genome/karyotype';
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
 * these files keep their names and their genomes for good.
 */
const BASELINE: readonly (readonly [file: string, hash: string])[] = [
  [
    '01-genesis-mabogibacter-lucens.hex',
    '4dece393e6860d77d66c9fbf0fa0c7cddd50acda7e4bc662e349c5e340236eb9',
  ],
  [
    '02-genesis-bivamiplax-lucens.hex',
    '5fbe9f4c027a6a7b5b093d70920c75c239b5bd96bc2e91ed63fc014a75f18564',
  ],
  [
    '03-genesis-zimaviium-lucens.hex',
    '1a76cda023621eab1e414ab3bed9b169390aabc10a6a4f21ada1fa63002c02a3',
  ],
  [
    '04-genesis-bolegibacter-natans.hex',
    '57ab7f3d5ff2b5a7ca51b17c55a42e540cafbc017d74aa16169e68c5a458ef9e',
  ],
  [
    '05-genesis-larenatrix-lucens.hex',
    '4658a1d53428d7093553511582f5f5bf387e998bf26bb6e35bedc96c9a4bd1cd',
  ],
  [
    '06-genesis-nogoziium-lucens.hex',
    '0ccf3c07756204537069405a04251fe19f979234f7b56a163179d5baef0b2d71',
  ],
  [
    '07-wild-mezamarhiza-serpens.hex',
    'ad7d7534ac48e95454cda9d333b49243851a51e572204146ca0ca2719db35931',
  ],
  [
    '08-wild-logamaocus-albus.hex',
    'ce238bf0bbec8a7cd0f429c85add5df14b2801c7ec6c7f0d5e607ca463db2d26',
  ],
  [
    '09-wild-retizespira-serpens.hex',
    'acd5d752a7390832582845af977fc09c5d53ccf950923a54270d94b880f97403',
  ],
  [
    '10-wild-zevalospora-spinosus.hex',
    'fdd967447c7fd07f62e09a5d6657a62742eae96f41d01afd54e78551d52bffa5',
  ],
  [
    '11-wild-rimazispira-ferox.hex',
    '946e32f00132de223933fdd04c6463ad262587ee9ce622c126535ec34d373e74',
  ],
  [
    '12-wild-nenazeula-serpens.hex',
    '1825a2ac65e9db06d116721f2a82484f34383c8d943cd9cfa3b7a4664dced83c',
  ],
  [
    '13-wild-gegorozoon-iridescens.hex',
    '0b61895fa4c3e995ec267eac5857a9061f53eac620b0fbcfb0f4738eff2b870e',
  ],
  [
    '14-bred-zironeina-lucens.hex',
    '322e01ff29ad0b152a3c056d326c657719f1e69955b8d3813f16a729c6fa74c3',
  ],
  [
    '15-bred-retadithrix-natans.hex',
    '39554010b7963798cbb4d9916427ee95a2e9e11f4e51db7c77ae32831f185bc4',
  ],
  [
    '16-bred-begaviella-lucens.hex',
    '6e85f8382a6edba997d4b8ec1a1403f9ef6b61822d431c5eb9530d2762fb5104',
  ],
  [
    '17-bred-tatirimonas-serpens.hex',
    '8c34cf3efc963cb3406e2ebab61fd845470966141790e05aede74960a35313f8',
  ],
  [
    '18-bred-daralafera-serpens.hex',
    '2524a9e86860641ad7b922eb41ea2a56bfd65b9f97f2814c8ea21b059094ebb4',
  ],
  [
    '19-bred-ronenoonas-serpens.hex',
    '8867888d3a03d622f913dff320b93cadc3a96f686d7c46c4e036b3a403302129',
  ],
  [
    '20-bred-bazerospira-lucens.hex',
    '2788b2bdb09f8ab2013e15d768b7cab4a30627f6d6c0f2828c8e9244e9ded930',
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

  it('keeps the 20 baseline specimens first, unchanged, each a valid v1 body', () => {
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

describe('gallery grid', () => {
  const fits = (g: GalleryGrid, count: number) => {
    expect(g.cols * g.rows).toBeGreaterThanOrEqual(count);
    // The longest body reaches REACH core radii from its core in every direction and fits its cell.
    expect(2 * REACH * g.radius).toBeLessThanOrEqual(g.cellW);
    expect(2 * REACH * g.radius).toBeLessThanOrEqual(g.cellH - LABEL_HEIGHT);
  };

  it('lays the baseline 20 out 7 by 3 and the full 36 out 9 by 4', () => {
    const { width, height } = GALLERY_SIZE;
    expect(galleryGrid(20, width, height)).toMatchObject({ cols: 7, rows: 3 });
    expect(galleryGrid(36, width, height)).toMatchObject({ cols: 9, rows: 4 });
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
