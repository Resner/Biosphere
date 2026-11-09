import { describe, expect, it } from 'vitest';
import {
  DEFICIENCIES,
  deltaE2000,
  distance,
  pixelSimulator,
  type Rgb,
  simulate,
} from './colour-vision';

const byte = (rgb: Rgb) => rgb.map((c) => c * 255);
const hex = (n: number): Rgb => [(n >> 16) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];

describe('the deficiency simulation (Machado et al. 2009, severity 1, in linear light)', () => {
  it('leaves greys as they are under all three', () => {
    for (const d of DEFICIENCIES)
      for (let v = 0; v <= 255; v += 5) {
        for (const c of byte(simulate([v / 255, v / 255, v / 255], d)))
          expect(Math.abs(c - v), `${d} grey ${v}`).toBeLessThanOrEqual(0.5);
      }
  });

  // Worked by hand: decode each channel (sRGB → linear), apply the paper's matrix row by row,
  // clamp to 0..1 and encode again.
  it.each([
    ['pure red', 0xff0000, 'protanopia', [108.79, 95.03, 0]],
    ['pure red', 0xff0000, 'deuteranopia', [163.22, 144.28, 0]],
    ['pure red', 0xff0000, 'tritanopia', [255, 0, 14.89]],
    ['the health bar’s amber', 0xe8b04a, 'protanopia', [198.18, 177.16, 61.9]],
    ['the health bar’s amber', 0xe8b04a, 'deuteranopia', [211.44, 191.04, 77.63]],
    ['the health bar’s amber', 0xe8b04a, 'tritanopia', [251.33, 159.88, 154.36]],
    ['the size bar’s green', 0x8de88a, 'protanopia', [235.89, 216.49, 131.14]],
    ['the size bar’s green', 0x8de88a, 'deuteranopia', [222.53, 207.79, 143.73]],
    ['the size bar’s green', 0x8de88a, 'tritanopia', [131.02, 226.95, 208.83]],
  ] as const)('%s (%s) under %s', (_, colour, d, want) => {
    const got = byte(simulate(hex(colour), d));
    for (const [i, c] of got.entries()) expect(c).toBeCloseTo(want[i] as number, 1);
  });

  it('simulates a screenshot’s pixels as it does one colour, alpha untouched', () => {
    const colours = [0xff0000, 0xe8b04a, 0x8de88a, 0x7ac8ff, 0x04090b, 0xffffff];
    for (const d of DEFICIENCIES) {
      const px = new Uint8Array(colours.flatMap((c) => [c >> 16, (c >> 8) & 0xff, c & 0xff, 200]));
      pixelSimulator(d)(px);
      for (const [k, c] of colours.entries()) {
        const want = byte(simulate(hex(c), d));
        for (let i = 0; i < 3; i++)
          expect(Math.abs((px[k * 4 + i] as number) - (want[i] as number))).toBeLessThanOrEqual(1);
        expect(px[k * 4 + 3]).toBe(200);
      }
    }
  });
});

describe('CIEDE2000', () => {
  // Sharma, Wu and Dalal (2005), table 1: pairs 1, 7, 17 and 34.
  it.each([
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 0, 0], [50, -1, 2], 2.3669],
    [[50, 2.5, 0], [73, 25, -18], 27.1492],
    [[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082],
  ] as const)('%j against %j is %d', (p, q, want) => {
    expect(deltaE2000(p, q)).toBeCloseTo(want, 4);
    expect(deltaE2000(q, p)).toBeCloseTo(want, 4);
  });

  it('is 0 for a colour and itself, and about 100 from black to white', () => {
    expect(distance(hex(0xe8b04a), hex(0xe8b04a))).toBe(0);
    expect(distance([0, 0, 0], [1, 1, 1])).toBeCloseTo(100, 0);
  });
});
