// The swimming gait of a creature mesh (M3 T11). `gaitOffset` is the CPU reference of
// `creature.vert.glsl`: the same formulas in the same order, so unit tests can hold the shader to
// its guarantees (no detached parts, bounded motion, a body that only breathes at rest).
// All lengths are in core radii, the unit of the mesh.

import type { BodyPlan } from '../genome/develop';
import type { Traits } from '../genome/express';
import { partId } from './creature-mesh';

const TAU = Math.PI * 2;

/** Per-genome gait inputs, the shader's `uAmp`, `uFreq`, `uBend`; `phase` and `beat` change every frame. */
export interface GaitUniforms {
  /** 0..1, the genome's gait amplitude. */
  amp: number;
  /** The genome's gait frequency, 0.5-2; it sets how fast `phase` is integrated and is never an input of the pose. */
  freq: number;
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
  /** Position along the spine, 0 front to 1 rear. */
  spine: number;
  /** The spine position the part hangs from. */
  attach: number;
  /** 0 at a part's base, 1 at its tip. */
  weight: number;
  /** `aPart`: kind in the low two bits, appendage number above. */
  part: number;
}

/** Largest sway of the rear of the spine at full amplitude and flexibility. */
export const SPINE_SWAY = 0.16;
/** Largest extra swing of an appendage tip. */
export const PART_SWING = 0.3;
/** Waves along the spine and along a part. */
const SPINE_WAVES = 0.8;
const PART_WAVES = 1;
/** The share of the moving amplitude that remains at rest: the body only breathes. */
export const BREATH = 0.12;
/** The beat phase offset between neighbouring appendages (the golden angle). */
const PART_STAGGER = 2.399963;
/** The share of a sideways part's swing that rows fore and aft, per core radius off the axis, up to this much. */
const ROW = 0.6;

export const GAIT_REST: Readonly<GaitUniforms> = { amp: 0, freq: 1, phase: 0, beat: 0, bend: 0 };

/** How a creature's genes drive its gait. */
export function gaitOf(
  traits: Traits,
  plan: BodyPlan,
): Pick<GaitUniforms, 'amp' | 'freq' | 'bend'> {
  return {
    amp: traits.behaviour.gaitAmp,
    freq: traits.behaviour.gaitFreq,
    bend: plan.flexibility,
  };
}

const clamp01 = (v: number): number => Math.min(Math.max(v, 0), 1);

/** 1 at full beat, `BREATH` at rest. */
const effort = (beat: number): number => BREATH + (1 - BREATH) * clamp01(beat);

/** Sideways offset of the spine at `s`: a wave that grows from a steady head to a swaying tail. */
export function spineOffset(s: number, g: GaitUniforms): number {
  const sway = SPINE_SWAY * clamp01(g.amp) * (0.4 + 0.6 * clamp01(g.bend)) * effort(g.beat);
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
  const swing = PART_SWING * effort(g.beat) * clamp01(g.amp + 0.25) * v.weight;
  const wave = Math.sin(TAU * PART_WAVES * v.weight - g.phase + partId(v.part) * PART_STAGGER);
  const row = Math.min(Math.abs(v.y) * ROW, ROW);
  out.x = swing * wave * row;
  out.y = base + swing * wave * (1 - row);
}
