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

  it('paints texels by depth, row 0 at the north edge, blending the zones across their edges', () => {
    // A 4 × 4 grid (row = y, south first): the south half mid-shallows, the north half abyss.
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
    // Image row 0 is the north (abyss), row 3 the south (shallows); no outline in between.
    expect(rgb(0, 1)).toEqual(colour('abyss'));
    expect(rgb(1, 1)).toEqual(colour('abyss'));
    expect(rgb(3, 2)).toEqual(colour('shallows'));
    expect(rgb(2, 1)).toEqual(colour('shallows'));
    for (let i = 3; i < px.length; i += 4) expect(px[i]).toBe(255);
  });

  it('grades the colour smoothly across a zone edge: no step between neighbouring depths', () => {
    // A ramp of every depth byte, one texel each: the colour never jumps by more than a few levels.
    const grid = Uint8Array.from({ length: 256 }, (_, d) => d);
    const px = zonePixels(grid, 16);
    // Row 0 of the picture is the last grid row: texel (i, j) lands at ((15 - j) * 16 + i) * 4.
    const at = (d: number) => {
      const o = ((15 - Math.floor(d / 16)) * 16 + (d % 16)) * 4;
      return [px[o], px[o + 1], px[o + 2]] as number[];
    };
    let worst = 0;
    for (let d = 1; d < 256; d++) {
      const a = at(d - 1);
      const b = at(d);
      for (let k = 0; k < 3; k++)
        worst = Math.max(worst, Math.abs((a[k] as number) - (b[k] as number)));
    }
    expect(worst).toBeLessThanOrEqual(10);
    // An edge depth sits between its two zones' colours.
    const edge = at(Math.round(zones.shallows * 255));
    const lo = MAP_COLOURS.twilight.map((c) => c * 255);
    const hi = MAP_COLOURS.shallows.map((c) => c * 255);
    expect(edge[1]).toBeGreaterThan(lo[1] as number);
    expect(edge[1]).toBeLessThan(hi[1] as number);
  });
});
