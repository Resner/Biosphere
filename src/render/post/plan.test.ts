import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { PRESET_NAMES, PRESETS } from '../presets';
import { bytesPerPixel, mipSizes, postPlan, targetBytes, targetSizes, targetType } from './plan';

describe('postPlan', () => {
  it('renders low straight to the canvas', () => {
    expect(postPlan('low')).toEqual({ passes: [], bloom: null, dof: null, backdrop: null });
  });

  it('gives medium a half-resolution backdrop for refraction, a half-strength depth of field, a half-resolution bloom of 4 levels, a grade and a vignette', () => {
    expect(postPlan('medium')).toEqual({
      passes: ['scene', 'refraction', 'dof', 'bloom', 'grade', 'vignette'],
      bloom: { scale: 0.5, levels: 4 },
      dof: { maxPx: 6, fringe: false },
      backdrop: { scale: 0.5 },
    });
  });

  it('adds a full-strength depth of field with a fringe, grain and chromatic aberration on high, with a 5-level bloom', () => {
    expect(postPlan('high')).toEqual({
      passes: ['scene', 'refraction', 'dof', 'bloom', 'grade', 'vignette', 'grain', 'chromatic'],
      bloom: { scale: 0.5, levels: 5 },
      dof: { maxPx: 12, fringe: true },
      backdrop: { scale: 0.5 },
    });
  });

  it('drops the vignette, the chromatic aberration and the fringe without the lens', () => {
    expect(postPlan('high', { lens: false }).dof).toEqual({ maxPx: 12, fringe: false });
    expect(postPlan('high', { lens: false }).passes).toEqual([
      'scene',
      'refraction',
      'dof',
      'bloom',
      'grade',
      'grain',
    ]);
  });

  it('drops the depth of field when it is switched off', () => {
    expect(postPlan('medium', { dof: false })).toEqual({
      passes: ['scene', 'refraction', 'bloom', 'grade', 'vignette'],
      bloom: { scale: 0.5, levels: 4 },
      dof: null,
      backdrop: { scale: 0.5 },
    });
    expect(postPlan('high', { dof: false }).passes).not.toContain('dof');
  });
});

describe('mipSizes', () => {
  it('halves each level from the first and never goes below one pixel', () => {
    expect(mipSizes(960, 540, 0.5, 4)).toEqual([
      [480, 270],
      [240, 135],
      [120, 68],
      [60, 34],
    ]);
    expect(mipSizes(3, 1, 0.5, 3)).toEqual([
      [2, 1],
      [1, 1],
      [1, 1],
    ]);
  });
});

describe('targetType', () => {
  it('renders to half float when a float colour buffer is available', () => {
    expect(targetType((name) => name === 'EXT_color_buffer_float')).toBe(THREE.HalfFloatType);
    expect(targetType((name) => name === 'EXT_color_buffer_half_float')).toBe(THREE.HalfFloatType);
  });

  it('falls back to 8 bits per channel when half float is not renderable', () => {
    expect(targetType(() => false)).toBe(THREE.UnsignedByteType);
  });

  it('counts 8 bytes a pixel for half float and 4 for bytes', () => {
    expect(bytesPerPixel(THREE.HalfFloatType)).toBe(8);
    expect(bytesPerPixel(THREE.UnsignedByteType)).toBe(4);
  });
});

describe('targetSizes', () => {
  it('gives low no target at all', () => {
    expect(targetSizes(postPlan('low'), 1920, 1080)).toEqual({
      scene: null,
      backdrop: null,
      mips: [],
    });
  });

  it('sizes the scene target, the half-resolution backdrop and the bloom mips from the drawing buffer', () => {
    expect(targetSizes(postPlan('medium'), 1920, 1080)).toEqual({
      scene: [1920, 1080],
      backdrop: [960, 540],
      mips: [
        [960, 540],
        [480, 270],
        [240, 135],
        [120, 68],
      ],
    });
    expect(targetSizes(postPlan('high'), 1920, 1080).mips).toHaveLength(5);
  });
});

describe('targetBytes (M6 T26)', () => {
  it('pins the render-target memory of a 1920×1080 drawing buffer in half float', () => {
    const bpp = bytesPerPixel(THREE.HalfFloatType);
    expect(targetBytes(postPlan('low'), 1920, 1080, bpp)).toBe(0);
    // Scene 1920×1080, backdrop 960×540 and the bloom mips, at 8 bytes a pixel.
    expect(targetBytes(postPlan('medium'), 1920, 1080, bpp)).toBe(26_244_480);
    expect(targetBytes(postPlan('high'), 1920, 1080, bpp)).toBe(26_260_800);
  });

  it('counts a multisampled scene target once per sample on top of its resolve target', () => {
    const plain = targetBytes(postPlan('high'), 100, 100, 8);
    expect(targetBytes(postPlan('high'), 100, 100, 8, 4)).toBe(plain + 4 * 100 * 100 * 8);
  });

  it('keeps every preset within its memory budget at 1920×1080, in half float or bytes', () => {
    for (const preset of PRESET_NAMES) {
      for (const type of [THREE.HalfFloatType, THREE.UnsignedByteType]) {
        const bytes = targetBytes(postPlan(preset), 1920, 1080, bytesPerPixel(type));
        expect(bytes, preset).toBeLessThanOrEqual(PRESETS[preset].budget.targetBytes);
      }
    }
  });
});
