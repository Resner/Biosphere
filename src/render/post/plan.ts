// What the post chain does on each preset (M6 T2, ADR 0004), as plain data the chain and its tests
// read. DOF joins the list in T3.

import * as THREE from 'three';
import { PRESETS, type PresetName } from '../presets';

export type PostPass = 'scene' | 'bloom' | 'grade' | 'vignette' | 'grain' | 'chromatic';

export interface PostPlan {
  /** In order; empty means the scene renders straight to the canvas. */
  passes: PostPass[];
  /** The first bloom mip's size relative to the scene target, and how many halvings follow it. */
  bloom: { scale: number; levels: number } | null;
}

/** Bloom levels per preset: each one doubles the reach of the glow. */
const BLOOM_LEVELS: Record<PresetName, number> = { low: 0, medium: 4, high: 5 };

export function postPlan(preset: PresetName): PostPlan {
  const p = PRESETS[preset];
  if (!p.bloom && !p.grade) return { passes: [], bloom: null };
  const passes: PostPass[] = ['scene'];
  if (p.bloom) passes.push('bloom');
  if (p.grade) passes.push('grade', 'vignette');
  if (p.grain) passes.push('grain');
  if (p.chromaticAberration) passes.push('chromatic');
  return { passes, bloom: p.bloom ? { scale: 0.5, levels: BLOOM_LEVELS[preset] } : null };
}

/** Pixel sizes of the bloom mips: the first at `scale`, then each half the one before. */
export function mipSizes(
  width: number,
  height: number,
  scale: number,
  levels: number,
): [number, number][] {
  const sizes: [number, number][] = [];
  let w = Math.max(1, Math.round(width * scale));
  let h = Math.max(1, Math.round(height * scale));
  for (let i = 0; i < levels; i++) {
    sizes.push([w, h]);
    w = Math.max(1, Math.round(w / 2));
    h = Math.max(1, Math.round(h / 2));
  }
  return sizes;
}

/** Half float keeps highlights above 1 for bloom; without a float colour buffer, 8 bits must do. */
export const targetType = (has: (extension: string) => boolean): THREE.TextureDataType =>
  has('EXT_color_buffer_float') || has('EXT_color_buffer_half_float')
    ? THREE.HalfFloatType
    : THREE.UnsignedByteType;

/** RGBA: 2 bytes a channel in half float, 1 in bytes. */
export const bytesPerPixel = (type: THREE.TextureDataType): number =>
  type === THREE.HalfFloatType ? 8 : 4;
