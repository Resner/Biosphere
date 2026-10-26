// How a creature's genes look (M3 T12): `materialParams` is the pure mapping from expressed traits
// to the creature shader's uniforms. One shader program serves every creature; only these values
// differ, and they are set once per genome (the cache keeps them with the geometry).

import type { Traits } from '../genome/express';
import { clamp } from '../sim/math';

export type Rgb = readonly [number, number, number];

/** The shader's `uPattern`, as a float: which marking the body carries. */
export const PATTERN = {
  none: 0,
  /** Narrow bands across the body. */
  rings: 1,
  spots: 2,
  /** Lines along the body. */
  stripes: 3,
  spotsStripes: 4,
  /** Wide bands across the body. */
  bands: 5,
} as const;

/** Every rim is at least this bright (relative luminance), so a dark body still has a readable edge on dark water. */
export const MIN_RIM_LUMINANCE = 0.5;
/** The body's deep colour is never darker than this. */
export const MIN_CORE_LUMINANCE = 0.1;

const ALBINO_HUE = 0.96;
const ALBINO_SATURATION = 0.08;
const PALE_SATURATION_SCALE = 0.4;
const IRIDESCENCE = { plain: 0, iridescent: 0.55, oil: 1 } as const;
const GLOW = 0.8;

export interface MaterialParams {
  /** The body's deep colour and its lit rim, 0..1 per channel. */
  core: Rgb;
  rim: Rgb;
  /** The gene colour after the albino rule (HSV saturation, 0..1). */
  saturation: number;
  translucency: number;
  membrane: number;
  pattern: number;
  /** Whole repeats, so the pattern closes around the body. */
  patternCount: number;
  iridescence: number;
  /** 0 when the glow is not expressed. */
  luminescence: number;
  /** 0 steady, 1 pulsing. */
  lumPulse: number;
  lumColor: Rgb;
  /** 0.5..1, how opaque the plates are. */
  plating: number;
  rimStrength: number;
}

export function hsv(h: number, s: number, v: number): Rgb {
  const k = (n: number): number => (n + h * 6) % 6;
  const f = (n: number): number => v * (1 - s * Math.max(0, Math.min(k(n), 4 - k(n), 1)));
  return [f(5), f(3), f(1)];
}

export const luminance = ([r, g, b]: Rgb): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;

const toward = (c: Rgb, to: number, t: number): Rgb => [
  c[0] + (to - c[0]) * t,
  c[1] + (to - c[1]) * t,
  c[2] + (to - c[2]) * t,
];

/** Lightens `c` toward white until it reaches `min` luminance; a bright colour is returned as it is. */
function liftTo(c: Rgb, min: number): Rgb {
  const l = luminance(c);
  return l >= min ? c : toward(c, 1, (min - l) / (1 - l));
}

function patternKind(alleles: readonly string[]): number {
  const has = (a: string): boolean => alleles.includes(a);
  if (has('spots') && has('stripes')) return PATTERN.spotsStripes;
  if (has('spots')) return PATTERN.spots;
  if (has('stripes')) return PATTERN.stripes;
  if (has('rings')) return PATTERN.rings;
  if (has('bands')) return PATTERN.bands;
  return PATTERN.none;
}

export function materialParams(t: Pick<Traits, 'colour' | 'skin'>): MaterialParams {
  const { colour, skin } = t;
  const albino = colour.albino === 'albino';
  const hue = albino ? ALBINO_HUE : colour.hue;
  const saturation = albino
    ? ALBINO_SATURATION
    : colour.albino === 'pale'
      ? colour.saturation * PALE_SATURATION_SCALE
      : colour.saturation;
  const value = albino ? Math.max(colour.value, 0.85) : colour.value;
  const body = hsv(hue, saturation, value);
  const glows = colour.luminescence !== 'off';

  return {
    core: liftTo(toward(body, 0, 0.5), MIN_CORE_LUMINANCE),
    rim: liftTo(toward(body, 1, 0.3), MIN_RIM_LUMINANCE),
    saturation,
    translucency: clamp(skin.translucency, 0, 1),
    membrane: clamp(skin.membrane, 0, 1),
    pattern: patternKind(colour.pattern),
    patternCount: 3 + Math.round(clamp(colour.patternScale, 0, 1) * 9),
    iridescence: IRIDESCENCE[skin.iridescence as keyof typeof IRIDESCENCE] ?? 0,
    luminescence: glows ? GLOW : 0,
    lumPulse: colour.luminescence === 'pulse' ? 1 : 0,
    lumColor: hsv(colour.lumHue, 0.85, 1),
    plating: 0.5 + 0.5 * clamp(skin.plating, 0, 1),
    rimStrength: 1.1 + 0.5 * clamp(skin.membrane, 0, 1) + 0.5 * (1 - clamp(value, 0, 1)),
  };
}
