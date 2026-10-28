import { describe, expect, it } from 'vitest';
import { PRESET_NAMES, PRESETS, pixelRatio, resolvePreset } from './presets';

describe('PRESETS', () => {
  it('pins the DESIGN §12 table', () => {
    expect(PRESET_NAMES).toEqual(['low', 'medium', 'high']);
    expect(PRESETS).toEqual({
      low: {
        maxPixelRatio: 1,
        particles: 0.3,
        dof: 'none',
        bloom: false,
        grade: false,
        chromaticAberration: false,
        grain: false,
        sparkle: false,
        budget: { calls: 80, triangles: 150_000 },
      },
      medium: {
        maxPixelRatio: 1.5,
        particles: 1,
        dof: 'half',
        bloom: true,
        grade: true,
        chromaticAberration: false,
        grain: false,
        sparkle: false,
        budget: { calls: 150, triangles: 300_000 },
      },
      high: {
        maxPixelRatio: 2,
        particles: 1.5,
        dof: 'full',
        bloom: true,
        grade: true,
        chromaticAberration: true,
        grain: true,
        sparkle: true,
        budget: { calls: 250, triangles: 600_000 },
      },
    });
  });
});

describe('resolvePreset', () => {
  it('returns an explicit setting as it is', () => {
    expect(resolvePreset('low', 'high')).toBe('low');
    expect(resolvePreset('high', 'low')).toBe('high');
  });

  it('turns auto into the detected preset, medium by default', () => {
    expect(resolvePreset('auto', 'low')).toBe('low');
    expect(resolvePreset('auto')).toBe('medium');
  });
});

describe('pixelRatio', () => {
  it('is the device ratio up to the preset maximum', () => {
    expect(pixelRatio('low', 2)).toBe(1);
    expect(pixelRatio('medium', 2)).toBe(1.5);
    expect(pixelRatio('high', 3)).toBe(2);
    expect(pixelRatio('high', 1.25)).toBe(1.25);
  });

  it('is at least 1, whatever the device reports', () => {
    expect(pixelRatio('high', 0.5)).toBe(1);
    expect(pixelRatio('high', 0)).toBe(1);
    expect(pixelRatio('high', Number.NaN)).toBe(1);
  });
});
