import { describe, expect, it } from 'vitest';
import { anchorTransform } from './labels';

// Labels sit on whole pixels (M6 T21): a percentage offset blurs text on odd-sized boxes.

describe('anchorTransform', () => {
  it('puts the bottom centre or the centre of a box at the point, on whole pixels', () => {
    expect(anchorTransform(100, 50, 40, 20, 'above')).toBe('translate(80px, 30px)');
    expect(anchorTransform(100, 50, 40, 20, 'centre')).toBe('translate(80px, 40px)');
    for (const [x, y, w, h] of [
      [100.4, 50.6, 57, 19],
      [33.5, 12.25, 3, 1],
      [0, 0, 101, 33],
    ] as const) {
      for (const anchor of ['above', 'centre'] as const) {
        const m = /translate\((-?\d+)px, (-?\d+)px\)/.exec(anchorTransform(x, y, w, h, anchor));
        expect(m).not.toBeNull();
        const left = Number(m?.[1]);
        const top = Number(m?.[2]);
        expect(Math.abs(left + w / 2 - x)).toBeLessThanOrEqual(1);
        expect(Math.abs(top + (anchor === 'above' ? h : h / 2) - y)).toBeLessThanOrEqual(1);
      }
    }
  });
});
