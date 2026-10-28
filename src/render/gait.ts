// The motion of a creature mesh (M3 T11, M6 T11 "flexible bodies"). `gaitPosition` is the CPU
// reference of `creature.vert.glsl`: the same formulas in the same order, so unit tests can hold the
// shader to its guarantees (no part detaches, bounded motion, a body that only breathes at rest).
// All lengths are in core radii, the unit of the mesh.
//
// A body vertex moves with the body: a travelling wave along the curved spine, across the spine's
// normal where the vertex hangs (so a worm undulates and a coil breathes), or, on a radial bell, a
// pulse that contracts it fast and lets it recover slowly. A part vertex first takes the body's
// motion at its part's root, then turns about that root by its own angle: rotation keeps every
// vertex at its rest distance from the root, so no part can stretch or come off. The angle depends
// on what the part is (the builder decides, `aMotion`): a beating part rows and whips, legs on
// successive segments in a metachronal wave; antennae sway and trail behind turns; wings flap and
// glide; a bell's tentacles fold after its pulse. Setae flutter on top of their part.

import type { BodyPlan } from '../genome/develop';
import type { Traits } from '../genome/express';
import { clamp, TAU, wrapAngle } from '../sim/math';
import {
  MOTION_ANTENNA,
  MOTION_BEAT,
  MOTION_BELL,
  MOTION_TENTACLE,
  MOTION_WING,
} from './creature-mesh';

/** The shader's `uAmp`, `uBend`, `uPhase`, `uBeat` and `uTurn`; `phase`, `beat` and `turn` change every frame. */
export interface GaitUniforms {
  /** 0..1, the genome's gait amplitude. */
  amp: number;
  /** Radians in [0, `GAIT_WRAP`), integrated per frame (`advanceBeatPhase`). */
  phase: number;
  /** 0..1, how hard the creature swims. */
  beat: number;
  /** 0..1, body flexibility. */
  bend: number;
  /** Radians, how far the antennae trail behind the heading (`turnLag`); 0 when not turning. */
  turn: number;
}

/** One vertex as the builder wrote it (`buildCreatureGeometry`'s attributes). */
export interface GaitVertex {
  /** Rest position, body frame (x forward, y left, z up). */
  x: number;
  y: number;
  z: number;
  /** The rest normal's x and y; a bristle flutters along it. */
  normalX: number;
  normalY: number;
  /** `aAttach`: the spine share the vertex (or its part) hangs from. */
  attach: number;
  /** `aWeight`: 0 at a part's base, 1 at its tip. */
  weight: number;
  /** `aFrame`: the spine's left normal at `attach`, then the part's root. */
  spineX: number;
  spineY: number;
  rootX: number;
  rootY: number;
  /** `aMotion`: the motion class, the part's phase offset, side × gain, and its rowing share. */
  motion: number;
  offset: number;
  gain: number;
  row: number;
  /** `aFlutter`: a bristle vertex's distance along its bristle, 0 elsewhere. */
  flutter: number;
}

/**
 * The tuning shared with `creature.vert.glsl`, which repeats these as `const float`s; a unit test
 * holds the two equal. Angles are in radians at full gain; the builder scales a long part's gain
 * down (`PART_REACH`), so no part sweeps further than a short one.
 */
export const GAIT_CONSTANTS = {
  /** Largest sway of the rear of the spine at full amplitude and flexibility. */
  SPINE_SWAY: 0.16,
  /** Waves along the spine and along a part. */
  SPINE_WAVES: 0.8,
  PART_WAVES: 1,
  /** The share of the moving amplitude that remains at rest: the body only breathes. */
  BREATH: 0.2,
  /** A beating part's sweep about its root, the lag of its tip behind its base, and its whip's bend. */
  ROW_SWEEP: 0.55,
  ROW_LAG: 0.8,
  WHIP_BEND: 0.6,
  /** An antenna's idle sway, and the largest turn it trails by. */
  ANTENNA_SWAY: 0.25,
  TURN_MAX: 0.35,
  /** A wing's stroke, and the share of its (half-rate) cycle the stroke takes; it glides for the rest. */
  WING_FLAP: 0.6,
  WING_STROKE: 0.4,
  /** A bell's contraction at full effort, the share of its (half-rate) cycle it contracts in, and its tentacles' fold and lag along their length. */
  PULSE: 0.1,
  PULSE_SQUEEZE: 0.3,
  TENTACLE_BEND: 0.55,
  TENTACLE_LAG: 2.2,
  /** A bristle's flutter per unit of its length, its rate in beats, and its phase shift along its part. */
  FLUTTER: 0.08,
  FLUTTER_RATE: 3,
  FLUTTER_SHIFT: 9,
} as const;
const {
  SPINE_SWAY,
  SPINE_WAVES,
  PART_WAVES,
  BREATH,
  ROW_SWEEP,
  ROW_LAG,
  WHIP_BEND,
  ANTENNA_SWAY,
  TURN_MAX,
  WING_FLAP,
  WING_STROKE,
  PULSE,
  PULSE_SQUEEZE,
  TENTACLE_BEND,
  TENTACLE_LAG,
  FLUTTER,
  FLUTTER_RATE,
  FLUTTER_SHIFT,
} = GAIT_CONSTANTS;

/** The phase wraps here: four beats, so the half- and quarter-rate cycles stay continuous. */
export const GAIT_WRAP = 4 * TAU;

/** How long the antennae take to catch up with a turn (the time constant, seconds). */
export const TURN_LAG_S = 0.3;

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

/**
 * The heading the antennae point along, `dt` seconds on: it follows `heading` with the time
 * constant `TURN_LAG_S`, the short way round. A long gap (a stalled tab) catches up fully.
 */
export function trailHeading(trail: number, heading: number, dt: number): number {
  const k = 1 - Math.exp(-Math.max(0, dt) / TURN_LAG_S);
  return wrapAngle(trail + wrapAngle(heading - trail) * k);
}

/** `uTurn`: how far the trailing heading lies behind the heading, in the body frame. */
export const turnLag = (trail: number, heading: number): number => wrapAngle(trail - heading);

/** 1 at full beat, `BREATH` at rest. */
export const effort = (beat: number): number => BREATH + (1 - BREATH) * clamp(beat, 0, 1);

const fract = (x: number): number => x - Math.floor(x);
const smooth = (t: number): number => {
  const c = clamp(t, 0, 1);
  return c * c * (3 - 2 * c);
};

/** A bell's contraction, 0..1, at cycle phase `x` (radians): fast in, slow out. */
export function bellPulse(x: number): number {
  const u = fract(x / TAU);
  return u < PULSE_SQUEEZE
    ? smooth(u / PULSE_SQUEEZE)
    : 1 - smooth((u - PULSE_SQUEEZE) / (1 - PULSE_SQUEEZE));
}

/** A wing's stroke, 0..1, at cycle phase `x`: one smooth stroke, then a glide at rest. */
export function wingFlap(x: number): number {
  const u = fract(x / TAU);
  return u < WING_STROKE ? 0.5 - 0.5 * Math.cos((TAU * u) / WING_STROKE) : 0;
}

const isRadial = (motion: number): boolean => motion === MOTION_BELL || motion === MOTION_TENTACLE;

/** Whether a vertex belongs to a part, which turns about its root. */
const turns = (motion: number): boolean =>
  motion === MOTION_BEAT ||
  motion === MOTION_ANTENNA ||
  motion === MOTION_WING ||
  motion === MOTION_TENTACLE;

/** How far a bell has contracted (a share of its size; 0 for any other body). */
function squeeze(v: GaitVertex, g: GaitUniforms): number {
  if (!isRadial(v.motion)) return 0;
  return PULSE * effort(g.beat) * clamp(g.amp + 0.25, 0, 1) * bellPulse(g.phase / 2);
}

/** Writes where the body carries the rest point (`px`, `py`) of a vertex hanging like `v`. */
function bodyAt(
  out: { x: number; y: number },
  v: GaitVertex,
  g: GaitUniforms,
  px: number,
  py: number,
) {
  if (isRadial(v.motion)) {
    const k = 1 - squeeze(v, g);
    out.x = px * k;
    out.y = py * k;
    return;
  }
  const sway = SPINE_SWAY * clamp(g.amp, 0, 1) * (0.4 + 0.6 * clamp(g.bend, 0, 1)) * effort(g.beat);
  const wave = sway * v.attach * Math.sin(TAU * SPINE_WAVES * v.attach - g.phase);
  out.x = px + v.spineX * wave;
  out.y = py + v.spineY * wave;
}

/** Where the vertex's part root has moved to: the attach point the part turns about. */
export function attachPoint(out: { x: number; y: number }, v: GaitVertex, g: GaitUniforms): void {
  bodyAt(out, v, g, v.rootX, v.rootY);
}

/** The angle a part vertex turns about its root (0 for a body vertex). */
export function partAngle(v: GaitVertex, g: GaitUniforms): number {
  const e = effort(g.beat);
  const drive = e * clamp(g.amp + 0.25, 0, 1);
  const w = v.weight;
  switch (v.motion) {
    case MOTION_BEAT: {
      const psi = g.phase - v.offset;
      const row = ROW_SWEEP * Math.sin(psi - ROW_LAG * w);
      const whip = WHIP_BEND * w * Math.sin(psi - TAU * PART_WAVES * w);
      return v.gain * drive * (v.row * row + (1 - v.row) * whip);
    }
    case MOTION_ANTENNA: {
      const sway = ANTENNA_SWAY * w * Math.sin(g.phase / 4 - v.offset);
      return v.gain * e * sway + Math.abs(v.gain) * w * clamp(g.turn, -TURN_MAX, TURN_MAX);
    }
    case MOTION_WING:
      return v.gain * drive * WING_FLAP * (0.6 + 0.4 * w) * wingFlap(g.phase / 2);
    case MOTION_TENTACLE:
      return v.gain * drive * TENTACLE_BEND * w * bellPulse(g.phase / 2 - TENTACLE_LAG * w);
    default:
      return 0;
  }
}

const root = { x: 0, y: 0 };

/** Writes the moved x and y of one vertex into `out` (z never moves). */
export function gaitPosition(out: { x: number; y: number }, v: GaitVertex, g: GaitUniforms): void {
  if (!turns(v.motion)) {
    bodyAt(out, v, g, v.x, v.y);
    return;
  }
  const f =
    FLUTTER *
    v.flutter *
    effort(g.beat) *
    Math.sin(FLUTTER_RATE * g.phase + FLUTTER_SHIFT * v.weight);
  const k = 1 - squeeze(v, g);
  const dx = (v.x + v.normalX * f - v.rootX) * k;
  const dy = (v.y + v.normalY * f - v.rootY) * k;
  const a = partAngle(v, g);
  const c = Math.cos(a);
  const s = Math.sin(a);
  attachPoint(root, v, g);
  out.x = root.x + c * dx - s * dy;
  out.y = root.y + s * dx + c * dy;
}
