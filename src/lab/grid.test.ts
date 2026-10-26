import { describe, expect, it } from 'vitest';
import { COLS, cellAt, cellRect, coreRadius, HOVER_SCALE, REACH, ROWS } from './grid';

describe('Lab grid', () => {
  it('tiles the stage with no gap or overlap', () => {
    const w = 660;
    const h = 540;
    let area = 0;
    for (let i = 0; i < COLS * ROWS; i++) {
      const r = cellRect(i, w, h);
      area += r.w * r.h;
      expect(cellAt(r.x + r.w / 2, r.y + r.h / 2, w, h)).toBe(i);
    }
    expect(area).toBeCloseTo(w * h, 6);
  });

  it('finds no cell outside the stage', () => {
    expect(cellAt(-1, 10, 600, 400)).toBe(-1);
    expect(cellAt(10, 400, 600, 400)).toBe(-1);
    expect(cellAt(600, 10, 600, 400)).toBe(-1);
  });

  it('fits the longest body (2.5 core radii, a little more for the lift) in half a cell', () => {
    for (const [w, h] of [
      [660, 540],
      [1600, 900],
      [300, 800],
    ] as const) {
      const r = cellRect(0, w, h);
      const reach = coreRadius(r.w, r.h) * REACH * HOVER_SCALE;
      expect(reach).toBeLessThanOrEqual(Math.min(r.w, r.h) / 2);
    }
  });
});
