import { describe, expect, it } from 'vitest';
import { RULES } from '../sim/rules';
import { AMBIENCE, type AmbienceParams, ambienceParams, fadeTimeConstant } from './ambience';

const ZONES = ['shallows', 'twilight', 'deep', 'abyss'] as const;
const mid = { shallows: 0.125, twilight: 0.4, deep: 0.675, abyss: 0.9 } as const;
const at = (zone: (typeof ZONES)[number]): AmbienceParams => ambienceParams(zone, mid[zone]);

describe('ambienceParams', () => {
  it('pins each zone at the middle of its depth band', () => {
    for (const zone of ZONES) {
      const p = at(zone);
      const row = AMBIENCE.rows[zone];
      expect(p.air).toBeCloseTo(row.air, 9);
      expect(p.airHz).toBeCloseTo(row.airHz, 6);
      expect(p.body).toBeCloseTo(row.body, 9);
      expect(p.bodyHz).toBeCloseTo(row.bodyHz, 6);
      expect(p.drone).toBeCloseTo(row.drone, 9);
      expect(p.droneHz).toBeCloseTo(row.droneHz, 6);
    }
  });

  it('anchors the rows inside their zones', () => {
    const { shallows, twilight, deep } = RULES.bathymetry.zones;
    expect(AMBIENCE.rows.shallows.depth).toBeLessThan(shallows);
    expect(AMBIENCE.rows.twilight.depth).toBeGreaterThan(shallows);
    expect(AMBIENCE.rows.twilight.depth).toBeLessThan(twilight);
    expect(AMBIENCE.rows.deep.depth).toBeGreaterThan(twilight);
    expect(AMBIENCE.rows.deep.depth).toBeLessThan(deep);
    expect(AMBIENCE.rows.abyss.depth).toBeGreaterThan(deep);
  });

  it('makes the shallows airy and the abyss low and pressured', () => {
    const shallows = at('shallows');
    const abyss = at('abyss');
    // Airy: the high hiss leads and the wash is bright.
    expect(shallows.air).toBeGreaterThan(shallows.body * 0.9);
    expect(shallows.air).toBeGreaterThan(abyss.air * 10);
    expect(shallows.bodyHz).toBeGreaterThan(abyss.bodyHz * 5);
    expect(shallows.shimmer).toBeGreaterThan(0);
    expect(shallows.pressure).toBe(0);
    // Low and pressured: a dark wash, a low drone and the pressure throb.
    expect(abyss.bodyHz).toBeLessThan(200);
    expect(abyss.droneHz).toBeLessThan(60);
    expect(abyss.drone).toBeGreaterThan(shallows.drone * 2);
    expect(abyss.pressure).toBeGreaterThan(0);
    expect(abyss.shimmer).toBe(0);
  });

  it('only the shallows shimmer and only the abyss presses', () => {
    for (const zone of ZONES) {
      expect(at(zone).shimmer > 0).toBe(zone === 'shallows');
      expect(at(zone).pressure > 0).toBe(zone === 'abyss');
    }
  });

  it('darkens and lowers steadily with depth', () => {
    let last = ambienceParams('shallows', 0);
    for (let d = 0.01; d <= 1.0001; d += 0.01) {
      const p = ambienceParams('twilight', Math.min(1, d));
      expect(p.airHz).toBeLessThanOrEqual(last.airHz + 1e-9);
      expect(p.bodyHz).toBeLessThanOrEqual(last.bodyHz + 1e-9);
      expect(p.droneHz).toBeLessThanOrEqual(last.droneHz + 1e-9);
      expect(p.air).toBeLessThanOrEqual(last.air + 1e-9);
      expect(p.drone).toBeGreaterThanOrEqual(last.drone - 1e-9);
      last = p;
    }
  });

  it('clamps depths outside 0..1 and keeps every value finite and positive', () => {
    expect(ambienceParams('shallows', -1)).toEqual(ambienceParams('shallows', 0));
    expect(ambienceParams('abyss', 2)).toEqual(ambienceParams('abyss', 1));
    for (const zone of ZONES) {
      for (const value of Object.values(at(zone))) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('cross-fades over 2 s: 98% of a change lands by then', () => {
    expect(AMBIENCE.fadeSeconds).toBe(2);
    expect(1 - Math.exp(-AMBIENCE.fadeSeconds / fadeTimeConstant())).toBeGreaterThan(0.98);
  });
});
