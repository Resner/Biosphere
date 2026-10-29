// What the post chain does on each preset (M6 T2, ADR 0004), as plain data the chain and its tests
// read. The depth of field (T3) draws the off-plane layers with their circle of confusion (`dof.ts`).
// Refraction (T13) first draws the backdrop into a half-resolution copy the creatures' glass samples.

import * as THREE from 'three';
import { PRESETS, type PresetName } from '../presets';
import { DOF_LOOK } from './dof';

export type PostPass =
  | 'scene'
  | 'refraction'
  | 'dof'
  | 'bloom'
  | 'grade'
  | 'vignette'
  | 'grain'
  | 'chromatic';

export interface PostPlan {
  /** In order; empty means the scene renders straight to the canvas. */
  passes: PostPass[];
  /** The first bloom mip's size relative to the scene target, and how many halvings follow it. */
  bloom: { scale: number; levels: number } | null;
  /** The largest circle of confusion (pixels at a pixel ratio of 1) and whether discs get a fringe. */
  dof: { maxPx: number; fringe: boolean } | null;
  /** The backdrop copy the glass refracts (T13): its size relative to the scene target. */
  backdrop: { scale: number } | null;
}

/** Bloom levels per preset: each one doubles the reach of the glow. */
const BLOOM_LEVELS: Record<Exclude<PresetName, 'low'>, number> = { medium: 4, high: 5 };

/**
 * `lens: false` drops the vignette and the chromatic aberration, which depend on where in the frame a
 * thing is; `dof: false` (the `?dof=0` test switch) drops the depth of field.
 */
export function postPlan(
  preset: PresetName,
  options: { lens?: boolean; dof?: boolean } = {},
): PostPlan {
  const p = PRESETS[preset];
  const lens = options.lens ?? true;
  if (!p.bloom && !p.grade) return { passes: [], bloom: null, dof: null, backdrop: null };
  // Refraction needs the scene target: a pass cannot sample the canvas it draws into.
  const passes: PostPass[] = ['scene', 'refraction'];
  const dof = options.dof !== false && p.dof !== 'none';
  if (dof) passes.push('dof');
  if (p.bloom) passes.push('bloom');
  if (p.grade) passes.push('grade');
  if (p.grade && lens) passes.push('vignette');
  if (p.grain) passes.push('grain');
  if (p.chromaticAberration && lens) passes.push('chromatic');
  return {
    passes,
    bloom: p.bloom
      ? { scale: 0.5, levels: BLOOM_LEVELS[preset as keyof typeof BLOOM_LEVELS] }
      : null,
    dof: dof
      ? {
          maxPx: DOF_LOOK.maxPx[preset as keyof typeof DOF_LOOK.maxPx],
          fringe: p.chromaticAberration && lens,
        }
      : null,
    backdrop: { scale: 0.5 },
  };
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

/** The pixel sizes of the targets a plan needs for a drawing buffer of `width` × `height`. */
export interface TargetSizes {
  /** The scene target; null renders straight to the canvas. */
  scene: [number, number] | null;
  backdrop: [number, number] | null;
  mips: [number, number][];
}

export function targetSizes(plan: PostPlan, width: number, height: number): TargetSizes {
  if (plan.passes.length === 0) return { scene: null, backdrop: null, mips: [] };
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const { backdrop, bloom } = plan;
  return {
    scene: [w, h],
    backdrop: backdrop
      ? [Math.max(1, Math.round(w * backdrop.scale)), Math.max(1, Math.round(h * backdrop.scale))]
      : null,
    mips: bloom ? mipSizes(w, h, bloom.scale, bloom.levels) : [],
  };
}

/**
 * The colour memory of a plan's targets in bytes (M6 T26): `samples` multisample buffers of the
 * scene target count on top of its resolve target.
 */
export function targetBytes(
  plan: PostPlan,
  width: number,
  height: number,
  bytesPerPixel: number,
  samples = 0,
): number {
  const { scene, backdrop, mips } = targetSizes(plan, width, height);
  let pixels = scene ? scene[0] * scene[1] * (1 + samples) : 0;
  if (backdrop) pixels += backdrop[0] * backdrop[1];
  for (const [w, h] of mips) pixels += w * h;
  return pixels * bytesPerPixel;
}

/** Half float keeps highlights above 1 for bloom; without a float colour buffer, 8 bits must do. */
export const targetType = (has: (extension: string) => boolean): THREE.TextureDataType =>
  has('EXT_color_buffer_float') || has('EXT_color_buffer_half_float')
    ? THREE.HalfFloatType
    : THREE.UnsignedByteType;

/** RGBA: 2 bytes a channel in half float, 1 in bytes. */
export const bytesPerPixel = (type: THREE.TextureDataType): number =>
  type === THREE.HalfFloatType ? 8 : 4;
