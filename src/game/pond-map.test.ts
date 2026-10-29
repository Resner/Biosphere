import { describe, expect, it } from 'vitest';
import { RULES } from '../sim/rules';
import { MAP_COLOURS, mapSpot, zonePixels } from './pond-map';

const { zones } = RULES.bathymetry;

describe('pond map', () => {
  it('puts the world on the map with north up', () => {
    expect(mapSpot(0, 0, 8192)).toEqual({ u: 0, v: 1 });
    expect(mapSpot(8192, 8192, 8192)).toEqual({ u: 1, v: 0 });
    expect(mapSpot(2048, 6144, 8192)).toEqual({ u: 0.25, v: 0.25 });
    // A creature pushed against a wall stays on the map.
    expect(mapSpot(-10, 9000, 8192)).toEqual({ u: 0, v: 0 });
  });

  it('colours each zone so brightness alone tells shallows from abyss', () => {
    const luma = ([r, g, b]: readonly number[]) =>
      0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
    const order = ['shallows', 'twilight', 'deep', 'abyss'] as const;
    for (let i = 1; i < order.length; i++) {
      expect(luma(MAP_COLOURS[order[i - 1] as (typeof order)[number]])).toBeGreaterThan(
        luma(MAP_COLOURS[order[i] as (typeof order)[number]]) * 1.4,
      );
    }
  });

  it('paints texels by zone, row 0 at the north edge, and outlines the zone edges', () => {
    // A 4 × 4 grid (row = y, south first): the south half shallows, the north half abyss.
    const shallow = Math.round(zones.shallows * 0.5 * 255);
    const abyss = 255;
    const grid = new Uint8Array(16);
    for (let j = 0; j < 4; j++)
      for (let i = 0; i < 4; i++) grid[j * 4 + i] = j < 2 ? shallow : abyss;
    const px = zonePixels(grid, 4);
    expect(px.length).toBe(64);
    const rgb = (row: number, col: number) => [
      ...px.slice((row * 4 + col) * 4, (row * 4 + col) * 4 + 3),
    ];
    const colour = (zone: keyof typeof MAP_COLOURS) =>
      MAP_COLOURS[zone].map((c) => Math.round(c * 255));
    // Image row 0 is the north (abyss), row 3 the south (shallows).
    expect(rgb(0, 1)).toEqual(colour('abyss'));
    expect(rgb(3, 2)).toEqual(colour('shallows'));
    // Rows 1 and 2 touch the other zone: drawn lighter, as the edge line.
    expect(rgb(1, 1)).not.toEqual(colour('abyss'));
    expect(rgb(2, 1)).not.toEqual(colour('shallows'));
    for (let i = 3; i < px.length; i += 4) expect(px[i]).toBe(255);
  });
});
