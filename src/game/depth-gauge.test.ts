import { describe, expect, it } from 'vitest';
import { RULES } from '../sim/rules';
import { DEPTH_GAUGE, depthMetres, gaugeBands, markerTop, metresText } from './depth-gauge';

describe('the depth gauge beside the minimap (M6c T12)', () => {
  it('reads the depth in whole metres on a fixed scale', () => {
    expect(DEPTH_GAUGE.metres).toBe(1000);
    expect(depthMetres(0)).toBe(0);
    expect(depthMetres(0.012)).toBe(12);
    expect(depthMetres(1)).toBe(1000);
    expect(depthMetres(-0.2)).toBe(0);
    expect(depthMetres(1.5)).toBe(1000);
    expect(metresText(12)).toBe('12 m');
    expect(metresText(0)).toBe('0 m');
    expect(metresText(1000)).toBe('1000 m');
    // Built once: the same string every time.
    expect(metresText(345)).toBe(metresText(345));
  });

  it('moves its marker down as the player dives, from the top to the bottom', () => {
    expect(markerTop(0)).toBe('0%');
    expect(markerTop(1000)).toBe('100%');
    let last = -1;
    for (let d = 0; d <= 1; d += 0.05) {
      const top = Number.parseFloat(markerTop(depthMetres(d)));
      expect(top).toBeGreaterThan(last);
      last = top;
    }
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
