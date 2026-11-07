import { describe, expect, it } from 'vitest';
import { speedTest } from '../../tests/heavy';
import { depthAt } from '../sim/bathymetry';
import { seedFromString } from '../sim/prng';
import { DepthWindow, REFILL_BUDGET, WINDOW_TEXELS } from './depth-window';

const SIZE = 262_144;
const seed = seedFromString('depth-window');
const N = WINDOW_TEXELS;
/** A view half-height whose window of 8 is exactly 1,024 wu: 4 wu texels. */
const HALF = 128;

interface Rect {
  i0: number;
  j0: number;
  i1: number;
  j1: number;
}

const rectOf = (w: DepthWindow): Rect => ({ i0: w.i0, j0: w.j0, i1: w.i0 + N, j1: w.j0 + N });
const area = (r: Rect): number => Math.max(0, r.i1 - r.i0) * Math.max(0, r.j1 - r.j0);
const overlap = (a: Rect, b: Rect): number =>
  area({
    i0: Math.max(a.i0, b.i0),
    j0: Math.max(a.j0, b.j0),
    i1: Math.min(a.i1, b.i1),
    j1: Math.min(a.j1, b.j1),
  });

/** Runs frames at a fixed point, at least one, until nothing is pending; returns how many it took. */
function drain(w: DepthWindow, x: number, y: number, half = HALF): number {
  let frames = 0;
  do {
    const before = w.samples;
    w.update(seed, SIZE, x, y, half);
    expect(w.samples - before).toBeLessThanOrEqual(REFILL_BUDGET);
    frames++;
    if (frames > 1000) throw new Error('the window never filled');
  } while (w.pending() > 0);
  return frames;
}

/** Every texel of the shown window is `depthAt` at its centre, as a byte. */
function expectFilled(w: DepthWindow, stride = 1): void {
  for (let j = w.j0; j < w.j0 + N; j += stride) {
    for (let i = w.i0; i < w.i0 + N; i += stride) {
      const want = Math.round(depthAt(seed, (i + 0.5) * w.cell, (j + 0.5) * w.cell, SIZE) * 255);
      const got = w.texel(i, j);
      if (got !== want) expect(got, `texel ${i}, ${j}`).toBe(want);
    }
  }
}

describe('DepthWindow over a 262,144 wu world', () => {
  it('covers at least its view half-heights, with a power-of-two texel, centred near the point', () => {
    const w = new DepthWindow(8);
    w.update(seed, SIZE, 250_000, 250_000, HALF);
    w.settle(seed, SIZE, 250_000, 250_000, HALF);
    expect(w.ready).toBe(true);
    expect(w.cell).toBe(4);
    expect(N * w.cell).toBeGreaterThanOrEqual(8 * HALF);
    const cx = (w.i0 + N / 2) * w.cell;
    const cy = (w.j0 + N / 2) * w.cell;
    expect(Math.abs(cx - 250_000)).toBeLessThanOrEqual(w.cell);
    expect(Math.abs(cy - 250_000)).toBeLessThanOrEqual(w.cell);
    expectFilled(w, 3);
  });

  it('moved 1,000 wu, it samples only the texels that scrolled in, never more than 4,096 a frame', () => {
    const w = new DepthWindow(8);
    let x = 250_000;
    let y = 249_000;
    w.settle(seed, SIZE, x, y, HALF);
    let shown = rectOf(w);
    const start = w.samples;
    let scrolled = 0;
    let moves = 0;
    // 1,000 wu east and 600 wu north over 400 frames, then until the last band is in.
    for (let frame = 0; frame < 400; frame++) {
      x += 2.5;
      y += 1.5;
      const before = w.samples;
      w.update(seed, SIZE, x, y, HALF);
      expect(w.samples - before).toBeLessThanOrEqual(REFILL_BUDGET);
      const now = rectOf(w);
      if (now.i0 !== shown.i0 || now.j0 !== shown.j0) {
        scrolled += area(now) - overlap(now, shown);
        moves++;
        shown = now;
      }
    }
    drain(w, x, y);
    expect(moves).toBeGreaterThanOrEqual(3);
    expect(w.samples - start).toBe(scrolled);
    // A re-centre happens once the point is a quarter of the side from the centre.
    expect(Math.abs((w.i0 + N / 2) * w.cell - x)).toBeLessThan((N * w.cell) / 4);
    expect(Math.abs((w.j0 + N / 2) * w.cell - y)).toBeLessThan((N * w.cell) / 4);
    expectFilled(w);
  });

  it('after a teleport the whole window refills within 16 frames, the stale texels shown meanwhile', () => {
    const w = new DepthWindow(8);
    w.settle(seed, SIZE, 131_072, 131_072, HALF);
    const stale = Uint8Array.from(w.data);
    const old = rectOf(w);
    let frames = 0;
    for (;;) {
      const before = w.samples;
      w.update(seed, SIZE, 250_000, 250_000, HALF);
      expect(w.samples - before).toBeLessThanOrEqual(REFILL_BUDGET);
      frames++;
      if (w.pending() === 0) break;
      // Until the new window is complete, the old one is what is shown, untouched.
      expect(rectOf(w)).toEqual(old);
      expect(w.data).toEqual(stale);
      if (frames > 16) throw new Error('the window took more than 16 frames');
    }
    expect(frames).toBeLessThanOrEqual(16);
    expect(Math.abs((w.i0 + N / 2) * w.cell - 250_000)).toBeLessThanOrEqual(w.cell);
    expectFilled(w, 2);
  });

  it('a zoom past its hysteresis rescales the texel by a whole refill; a small one keeps it', () => {
    const w = new DepthWindow(8);
    w.settle(seed, SIZE, 100_000, 100_000, HALF);
    // A little zoom in or out keeps the window: it still covers 8 half-heights.
    w.update(seed, SIZE, 100_000, 100_000, HALF * 0.8);
    w.update(seed, SIZE, 100_000, 100_000, HALF * 0.3);
    expect(w.cell).toBe(4);
    expect(w.pending()).toBe(0);
    // Growing past the window's side doubles the texel, refilled whole.
    drain(w, 100_000, 100_000, HALF * 1.5);
    expect(w.cell).toBe(8);
    expectFilled(w, 4);
    // Shrinking far below a quarter of it brings a finer texel.
    drain(w, 100_000, 100_000, HALF / 8);
    expect(w.cell).toBe(0.5);
    expectFilled(w, 4);
  });

  it('a new world refills it, and `texel` is null outside the window', () => {
    const w = new DepthWindow(12);
    w.settle(seed, SIZE, 4000, 4000, 10);
    expect(w.texel(w.i0 - 1, w.j0)).toBeNull();
    expect(w.texel(w.i0, w.j0 + N)).toBeNull();
    const other = seedFromString('another');
    w.update(other, 8192, 4000, 4000, 10);
    expect(w.pending()).toBeGreaterThan(0);
    w.settle(other, 8192, 4000, 4000, 10);
    const i = w.i0 + 17;
    const j = w.j0 + 200;
    expect(w.texel(i, j)).toBe(
      Math.round(depthAt(other, (i + 0.5) * w.cell, (j + 0.5) * w.cell, 8192) * 255),
    );
  });

  it('a smaller grid (the minimap chart of 128 texels) scrolls and fills the same way', () => {
    const w = new DepthWindow(24, 128);
    let x = 60_000;
    w.settle(seed, SIZE, x, 60_000, 20);
    const first = w.i0;
    for (let frame = 0; frame < 200; frame++) {
      x += 1;
      w.update(seed, SIZE, x, 60_000, 20);
    }
    while (w.pending() > 0) w.update(seed, SIZE, x, 60_000, 20);
    expect(w.i0).toBeGreaterThan(first);
    for (let j = w.j0; j < w.j0 + 128; j += 5) {
      for (let i = w.i0; i < w.i0 + 128; i += 3) {
        const want = Math.round(depthAt(seed, (i + 0.5) * w.cell, (j + 0.5) * w.cell, SIZE) * 255);
        if (w.texel(i, j) !== want) expect(w.texel(i, j), `${i}, ${j}`).toBe(want);
      }
    }
  });
});

speedTest("a frame's refill takes at most 1.5 ms in Node", () => {
  const w = new DepthWindow(8);
  // Warm up: a whole teleport's refill.
  w.settle(seed, SIZE, 131_072, 131_072, HALF);
  drain(w, 200_000, 200_000);
  const times: number[] = [];
  for (const [x, y] of [
    [250_000, 250_000],
    [10_000, 250_000],
    [131_072, 20_000],
  ] as const) {
    while (true) {
      const t = performance.now();
      w.update(seed, SIZE, x, y, HALF);
      times.push(performance.now() - t);
      if (w.pending() === 0) break;
    }
  }
  times.sort((a, b) => a - b);
  // The worst frame but one, so a single GC pause on a loaded runner does not decide it.
  expect(times[times.length - 2], `frames ${times.map((t) => t.toFixed(2))}`).toBeLessThanOrEqual(
    1.5,
  );
});

it('the budget fills a whole window in 16 frames', () => {
  expect((N * N) / REFILL_BUDGET).toBe(16);
});
