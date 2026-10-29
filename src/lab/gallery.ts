// The look-pass gallery (M6 T5, ADR 0024): a fixed set of specimens stored as hex under
// `tests/fixtures/gallery/`, never re-drawn from seeds, laid out on a fixed 1600×1000 sheet. Pure:
// the file format and the layout. `gallery-page.ts` draws it (`lab.html?gallery=1`).

import { hexToBytes } from '@noble/hashes/utils.js';
import { decodeGenome, type Genome, upgrade } from '../genome/codec';
import type { Rect } from './grid';
import { REACH } from './grid';

/** The sheet in CSS pixels, drawn at a pixel ratio of 1. */
export const GALLERY_SIZE = { width: 1600, height: 1000 } as const;
/** The caption band at the foot of each cell. */
export const LABEL_HEIGHT = 28;
/** Share of the room the longest body fills, so neighbours never touch. */
export const GALLERY_FILL = 0.94;

export interface GallerySpecimen {
  /** The file name; the sheet shows the specimens in this order. */
  file: string;
  /** What the specimen is and where it came from, in one line. */
  comment: string;
  /** Length of the stored genome in bytes. */
  bytes: number;
  genome: Genome;
}

const HEX = /^(?:[0-9a-f]{2})+$/;

/**
 * One specimen file: a `# comment` line and the genome as hex (one or more lines). Null when either
 * is missing or the hex is broken; the decoder itself is total (ADR 0018).
 */
export function parseSpecimen(file: string, text: string): GallerySpecimen | null {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const comment = lines[0]?.startsWith('#') ? lines[0].slice(1).trim() : '';
  const hex = lines
    .slice(1)
    .filter((line) => !line.startsWith('#'))
    .join('')
    .toLowerCase();
  if (comment.length === 0 || !HEX.test(hex)) return null;
  const bytes = hexToBytes(hex);
  return { file, comment, bytes: bytes.length, genome: decodeGenome(bytes) };
}

/**
 * The genome the sheet draws for a specimen (look pass 5, ADR 0032): rules 6 never develops a new
 * v1 body (every genesis and birth writes karyotype v2, and a v1 parent's child is padded first),
 * so a v1 file is shown as its v2 upgrade, the body its children start from. The file is unchanged.
 */
export function shownGenome(s: Pick<GallerySpecimen, 'genome'>): Genome {
  return upgrade(s.genome);
}

/** Every specimen of a `{ path: text }` map in file-name order; a broken file throws, naming it. */
export function gallerySpecimens(files: Readonly<Record<string, string>>): GallerySpecimen[] {
  return Object.entries(files)
    .map(([path, text]) => {
      const file = path.slice(path.lastIndexOf('/') + 1);
      const specimen = parseSpecimen(file, text);
      if (!specimen) throw new Error(`${file} is not a gallery specimen (# comment, then hex)`);
      return specimen;
    })
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

export interface GalleryGrid {
  cols: number;
  rows: number;
  cellW: number;
  cellH: number;
  /** One core radius for every specimen, in CSS pixels, so their sizes compare. */
  radius: number;
}

/** The grid that draws `count` bodies largest on a sheet, each with its caption band. */
export function galleryGrid(count: number, width: number, height: number): GalleryGrid {
  const n = Math.max(1, count);
  let best: GalleryGrid | null = null;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const cellW = width / cols;
    const cellH = height / rows;
    const room = Math.min(cellW, cellH - LABEL_HEIGHT);
    const radius = (Math.max(0, room) / (2 * REACH)) * GALLERY_FILL;
    // Strictly larger: of two equal layouts the one with fewer columns (and empty cells) wins.
    if (!best || radius > best.radius + 1e-9) best = { cols, rows, cellW, cellH, radius };
  }
  return best as GalleryGrid;
}

/** Cell `index`, row by row from the top left, in CSS pixels. */
export function galleryCell(index: number, grid: GalleryGrid): Rect {
  return {
    x: (index % grid.cols) * grid.cellW,
    y: Math.floor(index / grid.cols) * grid.cellH,
    w: grid.cellW,
    h: grid.cellH,
  };
}
