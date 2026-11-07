// Depth windows (M11 T11): the bathymetry near a point, as a 256 × 256 grid of depth bytes. A
// world of 262,144 wu is far too big for one map, so the water's zones, the minimap's chart and the
// map each keep a window around the camera instead. The grid is a torus: world cell (i, j) lives in
// texel (i mod 256, j mod 256), so when the window re-centres only the cells that scroll in are
// sampled, the texels that scroll out make room for them, and a texture with repeat wrapping draws
// it as is. Pure: no DOM and no three.js.

import { depthSpan } from '../sim/bathymetry';
import type { Seed } from '../sim/prng';
import { wrapTo } from './origin';

/** Texels per side. */
export const WINDOW_TEXELS = 256;
/** Depth samples a frame at most: a whole window refills in 16 frames. */
export const REFILL_BUDGET = 4096;
/**
 * A re-centre by at most this share of the side scrolls; a longer jump fills a whole new window.
 * A swim re-centres at a quarter, and the view (16:9, within a window of 8 half-heights) stays
 * inside what was already sampled up to about 0.28 of a side.
 */
const SCROLL_MAX = 0.28;
/** The window keeps its texel while its side is at most this many times what it must cover. */
const SHRINK_AT = 4;

interface Rect {
  i0: number;
  j0: number;
  i1: number;
  j1: number;
}

/** A grid's window and the cells of it still to sample, row by row from `next` (`j`, `i`). */
interface Grid {
  data: Uint8Array;
  seed: Seed | null;
  size: number;
  cell: number;
  i0: number;
  j0: number;
  todo: (Rect & { j: number; i: number })[];
}

const blank = (n: number): Grid => ({
  data: new Uint8Array(n * n),
  seed: null,
  size: 0,
  cell: 0,
  i0: 0,
  j0: 0,
  todo: [],
});

/** One row of samples, reused by every window. */
const row = new Float64Array(WINDOW_TEXELS);

/**
 * A square window of depth bytes near a point, at least `views` view half-heights wide. It
 * re-centres when the point has moved a quarter of its side from its centre and then samples only
 * the cells that scrolled in. A teleport, a new world or a zoom past the window's texel fills a
 * second grid instead, while the first (stale) one stays shown until the new one is complete.
 * Every frame samples at most `REFILL_BUDGET` cells.
 */
export class DepthWindow {
  /** The grid shown; `data` holds its texels in the torus layout. */
  private shown: Grid;
  /** The grid being filled to replace it whole, or null. */
  private next: Grid | null = null;
  /** Depth samples taken since it was made (tests count them). */
  samples = 0;
  /** Bumped whenever the shown texels change, so a texture knows to upload them. */
  version = 0;

  constructor(
    readonly views: number,
    readonly texels = WINDOW_TEXELS,
  ) {
    this.shown = blank(texels);
  }

  /** The shown texels: world cell (i, j) at `(j mod n) · n + (i mod n)`. */
  get data(): Uint8Array {
    return this.shown.data;
  }

  /** The shown window's texel side, wu. */
  get cell(): number {
    return this.shown.cell;
  }

  /** The shown window's first cell on each axis: it covers cells `i0` to `i0 + n − 1`. */
  get i0(): number {
    return this.shown.i0;
  }

  get j0(): number {
    return this.shown.j0;
  }

  /** Whether any window has been filled yet. */
  get ready(): boolean {
    return this.shown.seed !== null;
  }

  /** The world the shown window samples, and its size. */
  get seed(): Seed | null {
    return this.shown.seed;
  }

  get size(): number {
    return this.shown.size;
  }

  /** Cells still to sample, for the shown window and the one replacing it. */
  pending(): number {
    return remaining(this.shown) + (this.next ? remaining(this.next) : 0);
  }

  /** The byte of world cell (i, j) once sampled; null outside the shown window or before it is. */
  texel(i: number, j: number): number | null {
    const g = this.shown;
    const n = this.texels;
    if (!g.seed || i < g.i0 || j < g.j0 || i >= g.i0 + n || j >= g.j0 + n) return null;
    for (const r of g.todo) {
      if (i >= r.i0 && i < r.i1 && j >= r.j0 && j < r.j1 && (j > r.j || (j === r.j && i >= r.i)))
        return null;
    }
    return g.data[wrapTo(j, n) * n + wrapTo(i, n)] as number;
  }

  /**
   * Follows the point (x, y) of a world, seen at `halfHeight` wu, and samples up to `budget`
   * cells. Returns whether the shown texels changed. It allocates only when it re-centres.
   */
  update(
    seed: Seed,
    size: number,
    x: number,
    y: number,
    halfHeight: number,
    budget = REFILL_BUDGET,
  ): boolean {
    const n = this.texels;
    const shown = this.shown;
    const cell = this.cellFor(halfHeight);
    const pi = Math.floor(x / cell);
    const pj = Math.floor(y / cell);
    const same = shown.seed === seed && shown.size === size && shown.cell === cell;
    if (same && this.next === null) {
      const di = Math.abs(pi - (shown.i0 + n / 2));
      const dj = Math.abs(pj - (shown.j0 + n / 2));
      // A swim scrolls the window; a jump fills a new one, so that what is on screen never shows
      // the texels of somewhere else.
      if (Math.max(di, dj) > SCROLL_MAX * n) this.restart(seed, size, cell, pi, pj);
      else if (di >= n / 4 || dj >= n / 4) scroll(shown, pi - n / 2, pj - n / 2, n);
    } else if (same && this.next && !this.near(this.next, pi, pj)) {
      // Back where the shown window is before the new one is in: keep what is shown.
      if (this.near(shown, pi, pj)) this.next = null;
      else this.restart(seed, size, cell, pi, pj);
    } else if (!same) {
      const next = this.next;
      const wanted =
        next &&
        next.seed === seed &&
        next.size === size &&
        next.cell === cell &&
        this.near(next, pi, pj);
      if (!wanted) this.restart(seed, size, cell, pi, pj);
    }
    let changed = false;
    let left = budget;
    if (shown.todo.length > 0) {
      const used = fill(shown, left, n);
      left -= used;
      this.samples += used;
      changed = used > 0;
    }
    const next = this.next;
    if (next && left > 0) {
      this.samples += fill(next, left, n);
      if (next.todo.length === 0) {
        this.shown = next;
        this.next = null;
        // The old grid's array is reused by the next whole refill.
        this.spare = shown.data;
        changed = true;
      }
    }
    if (changed) this.version++;
    return changed;
  }

  /** Brings the window to the point at once, with no budget (a new life, a debug teleport). */
  settle(seed: Seed, size: number, x: number, y: number, halfHeight: number): void {
    this.update(seed, size, x, y, halfHeight, Number.POSITIVE_INFINITY);
    if (this.pending() > 0) this.update(seed, size, x, y, halfHeight, Number.POSITIVE_INFINITY);
  }

  /** Forgets every window (a scene without a world). */
  reset(): void {
    this.shown = blank(this.texels);
    this.next = null;
    this.version++;
  }

  private spare: Uint8Array | null = null;

  /** The texel side for a view: kept while the window covers `views` half-heights and is not far too big. */
  private cellFor(halfHeight: number): number {
    const n = this.texels;
    const want = Math.max(this.views * halfHeight, 1e-3);
    const current = this.next?.cell || this.shown.cell;
    if (current > 0 && n * current >= want && n * current <= SHRINK_AT * want) return current;
    return 2 ** Math.ceil(Math.log2(want / n));
  }

  /** Whether a point's cell lies within a quarter side of a grid's centre. */
  private near(g: Grid, pi: number, pj: number): boolean {
    const n = this.texels;
    return Math.abs(pi - (g.i0 + n / 2)) < n / 4 && Math.abs(pj - (g.j0 + n / 2)) < n / 4;
  }

  /** Starts filling a whole new grid centred on cell (pi, pj). */
  private restart(seed: Seed, size: number, cell: number, pi: number, pj: number): void {
    const n = this.texels;
    const next = this.next ?? {
      ...blank(0),
      data: this.spare ?? new Uint8Array(n * n),
    };
    this.spare = null;
    next.seed = seed;
    next.size = size;
    next.cell = cell;
    next.i0 = pi - n / 2;
    next.j0 = pj - n / 2;
    next.todo = [
      { i0: next.i0, j0: next.j0, i1: next.i0 + n, j1: next.j0 + n, j: next.j0, i: next.i0 },
    ];
    this.next = next;
  }
}

function remaining(g: Grid): number {
  let left = 0;
  for (const r of g.todo) left += r.i1 - r.i + (r.j1 - r.j - 1) * (r.i1 - r.i0);
  return left;
}

/**
 * Moves a grid's window to start at cell (i0, j0): what stays in it keeps its texels, the cells
 * that scrolled in are queued, and queued cells that scrolled out are dropped. A move of a whole
 * side or more queues it all.
 */
function scroll(g: Grid, i0: number, j0: number, n: number): void {
  const old: Rect = { i0: g.i0, j0: g.j0, i1: g.i0 + n, j1: g.j0 + n };
  const now: Rect = { i0, j0, i1: i0 + n, j1: j0 + n };
  g.i0 = i0;
  g.j0 = j0;
  const kept: Grid['todo'] = [];
  for (const r of g.todo) {
    // The part not yet sampled: the rest of the current row, then the rows after it.
    const rest: Rect[] = [
      { i0: r.i, j0: r.j, i1: r.i1, j1: r.j + 1 },
      { i0: r.i0, j0: r.j + 1, i1: r.i1, j1: r.j1 },
    ];
    for (const part of rest) {
      const c = clip(part, now);
      if (c) kept.push({ ...c, j: c.j0, i: c.i0 });
    }
  }
  const inner = clip(old, now);
  if (!inner) {
    g.todo = [{ ...now, j: now.j0, i: now.i0 }];
    return;
  }
  // The columns that scrolled in (full height), then the rows that did between them.
  const bands: Rect[] = [];
  if (now.i0 < inner.i0) bands.push({ i0: now.i0, j0: now.j0, i1: inner.i0, j1: now.j1 });
  if (now.i1 > inner.i1) bands.push({ i0: inner.i1, j0: now.j0, i1: now.i1, j1: now.j1 });
  if (now.j0 < inner.j0) bands.push({ i0: inner.i0, j0: now.j0, i1: inner.i1, j1: inner.j0 });
  if (now.j1 > inner.j1) bands.push({ i0: inner.i0, j0: inner.j1, i1: inner.i1, j1: now.j1 });
  for (const b of bands) kept.push({ ...b, j: b.j0, i: b.i0 });
  g.todo = kept;
}

function clip(a: Rect, b: Rect): Rect | null {
  const r = {
    i0: Math.max(a.i0, b.i0),
    j0: Math.max(a.j0, b.j0),
    i1: Math.min(a.i1, b.i1),
    j1: Math.min(a.j1, b.j1),
  };
  return r.i1 > r.i0 && r.j1 > r.j0 ? r : null;
}

/** Samples up to `budget` queued cells of a grid, in queue then row order; returns how many. */
function fill(g: Grid, budget: number, n: number): number {
  const seed = g.seed as Seed;
  let used = 0;
  while (g.todo.length > 0 && used < budget) {
    const r = g.todo[0] as Grid['todo'][number];
    const count = Math.min(r.i1 - r.i, budget - used, row.length);
    depthSpan(seed, g.size, g.cell, r.i, r.j, count, row);
    const base = wrapTo(r.j, n) * n;
    for (let k = 0; k < count; k++) {
      g.data[base + wrapTo(r.i + k, n)] = Math.round((row[k] as number) * 255);
    }
    used += count;
    r.i += count;
    if (r.i >= r.i1) {
      r.i = r.i0;
      r.j++;
      if (r.j >= r.j1) g.todo.shift();
    }
  }
  return used;
}
