import { describe, expect, it } from 'vitest';
import { RULES } from '../sim/rules';
import { DEPTH_GAUGE, depthMetres, gaugeBands } from './depth-gauge';

describe('the depth gauge beside the minimap (M6c T12)', () => {
  it('reads the depth in whole metres on a fixed scale', () => {
    expect(DEPTH_GAUGE.metres).toBe(1000);
    expect(depthMetres(0)).toBe(0);
    expect(depthMetres(0.012)).toBe(12);
    expect(depthMetres(1)).toBe(1000);
    expect(depthMetres(-0.2)).toBe(0);
    expect(depthMetres(1.5)).toBe(1000);
  });

  it('shows the four zones as bands from top to bottom, at their edges', () => {
    const bands = gaugeBands();
    expect(bands.startsWith('linear-gradient(to bottom,')).toBe(true);
    const z = RULES.bathymetry.zones;
    for (const edge of [z.shallows, z.twilight, z.deep])
      expect(bands).toContain(`${Math.round(edge * 1000) / 10}%`);
    // Four colours, each from its band's start to its end.
    expect(bands.match(/rgb\(/g)?.length).toBe(8);
  });
});
