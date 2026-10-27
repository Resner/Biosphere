import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { bytesPerPixel, mipSizes, postPlan, targetType } from './plan';

describe('postPlan', () => {
  it('renders low straight to the canvas', () => {
    expect(postPlan('low')).toEqual({ passes: [], bloom: null });
  });

  it('gives medium a half-resolution bloom of 4 levels, a grade and a vignette', () => {
    expect(postPlan('medium')).toEqual({
      passes: ['scene', 'bloom', 'grade', 'vignette'],
      bloom: { scale: 0.5, levels: 4 },
    });
  });

  it('adds grain and chromatic aberration on high, with a 5-level bloom', () => {
    expect(postPlan('high')).toEqual({
      passes: ['scene', 'bloom', 'grade', 'vignette', 'grain', 'chromatic'],
      bloom: { scale: 0.5, levels: 5 },
    });
  });

  it('drops the vignette and chromatic aberration without the lens', () => {
    expect(postPlan('high', { lens: false }).passes).toEqual(['scene', 'bloom', 'grade', 'grain']);
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
