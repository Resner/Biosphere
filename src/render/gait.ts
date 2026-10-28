// The swimming gait of a creature mesh (M3 T11). `gaitOffset` is the CPU reference of
// `creature.vert.glsl`: the same formulas in the same order, so unit tests can hold the shader to
// its guarantees (no detached parts, bounded motion, a body that only breathes at rest).
// All lengths are in core radii, the unit of the mesh.

import type { BodyPlan } from '../genome/develop';
import type { Traits } from '../genome/express';
import { clamp, TAU } from '../sim/math';
import { partId } from './creature-mesh';

/** The shader's `uAmp`, `uBend`, `uPhase` and `uBeat`; `phase` and `beat` change every frame. */
export interface GaitUniforms {
  /** 0..1, the genome's gait amplitude. */
  amp: number;
  /** Radians, integrated per frame (`advanceBeatPhase`). */
  phase: number;
  /** 0..1, how hard the creature swims. */
  beat: number;
  /** 0..1, body flexibility. */
  bend: number;
}

export interface GaitVertex {
  /** Body frame, y left; the distance off the body axis decides how a part swings. */
  y: number;
  /** The spine position the part hangs from. */
  attach: number;
  /** 0 at a part's base, 1 at its tip. */
  weight: number;
  /** `aPart`: the appendage number × `PART_KINDS` plus the part kind (`creature-mesh.ts`). */
  part: number;
}

/**
 * The tuning shared with `creature.vert.glsl`, which repeats these as `const float`s; a unit test
 * holds the two equal.
 */
export const GAIT_CONSTANTS = {
  /** Largest sway of the rear of the spine at full amplitude and flexibility. */
  SPINE_SWAY: 0.16,
  /** Largest extra swing of an appendage tip. */
  PART_SWING: 0.3,
  /** Waves along the spine and along a part. */
  SPINE_WAVES: 0.8,
  PART_WAVES: 1,
  /** The share of the moving amplitude that remains at rest: the body only breathes. */
  BREATH: 0.12,
  /** The beat phase offset between neighbouring appendages (the golden angle). */
  PART_STAGGER: 2.399963,
  /** The share of a sideways part's swing that rows fore and aft, per core radius off the axis, up to this much. */
  ROW: 0.6,
} as const;
const { SPINE_SWAY, PART_SWING, SPINE_WAVES, PART_WAVES, BREATH, PART_STAGGER, ROW } =
  GAIT_CONSTANTS;

/** How a creature's genes drive its gait; `freq` (0.5-2) only sets how fast `phase` is integrated, never the pose. */
export function gaitOf(
  traits: Traits,
  plan: BodyPlan,
): Pick<GaitUniforms, 'amp' | 'bend'> & { freq: number } {
  return {
    amp: traits.behaviour.gaitAmp,
    freq: traits.behaviour.gaitFreq,
    bend: plan.flexibility,
  };
}

/** 1 at full beat, `BREATH` at rest. */
const effort = (beat: number): number => BREATH + (1 - BREATH) * clamp(beat, 0, 1);

/** Sideways offset of the spine at `s`: a wave that grows from a steady head to a swaying tail. */
export function spineOffset(s: number, g: GaitUniforms): number {
  const sway = SPINE_SWAY * clamp(g.amp, 0, 1) * (0.4 + 0.6 * clamp(g.bend, 0, 1)) * effort(g.beat);
  return sway * s * Math.sin(TAU * SPINE_WAVES * s - g.phase);
}

/**
 * Writes the offset of one vertex into `out`. A vertex first takes the spine offset at the position
 * its part hangs from (`attach`; a body vertex hangs from its own spine position), so a part cannot
 * detach; an appendage vertex then adds its own beat, weighted by `weight` (0 at the base). A part
 * on the body axis whips sideways; one standing out to the side rows fore and aft.
 */
export function gaitOffset(out: { x: number; y: number }, v: GaitVertex, g: GaitUniforms): void {
  const base = spineOffset(v.attach, g);
  const swing = PART_SWING * effort(g.beat) * clamp(g.amp + 0.25, 0, 1) * v.weight;
  const wave = Math.sin(TAU * PART_WAVES * v.weight - g.phase + partId(v.part) * PART_STAGGER);
  const row = Math.min(Math.abs(v.y) * ROW, ROW);
  out.x = swing * wave * row;
  out.y = base + swing * wave * (1 - row);
}
