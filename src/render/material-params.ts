// How a creature's genes look (M3 T12): `materialParams` is the pure mapping from expressed traits
// to the creature shader's uniforms. One shader program serves every creature; only these values
// differ, and they are set once per genome (the cache keeps them with the geometry).

import type { Traits } from '../genome/express';
import type { RarityTier } from '../genome/rarity';
import { clamp, lerp } from '../sim/math';

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
const MIN_CORE_LUMINANCE = 0.1;

/**
 * The shell is nearly clear (M6 T12): it takes this share of the gene's saturation, so no shell is
 * more saturated than this. The pigment lives in the organs, at the gene's own saturation.
 */
export const SHELL_SATURATION = 0.15;
/**
 * Every shell is silvery pale blue (M6 T13): this hue at this saturation, with the gene's tint
 * (`SHELL_SATURATION` of its saturation) added as a chroma vector and the sum capped there. An
 * albino has no pigment and no tint: its shell stays clear.
 */
const SILVER_HUE = 0.58;
const SILVER_SATURATION = 0.04;
/**
 * Organs are at least this bright, so their colour reads through the shell as a clean hue (M6c T7:
 * 0.9; at 0.75 a yellow organ read olive beside pass 1's, which its luminous light brightened).
 */
const ORGAN_VALUE = 0.9;
/**
 * The organs' second tone (ADR 0043): the main colour turned toward amber (lipid, as pass 1's oil
 * droplets were) by `SECOND_TURN` turns, from its first value at no saturation to its second at full
 * gene saturation, so a vivid body shows two clearly related tones and a pale one two close ones.
 * Never complementary: at most 0.10 turns away.
 */
const AMBER_HUE = 0.11;
export const SECOND_TURN = [0.04, 0.06] as const;
/**
 * The second tone lies at another value, so the two differ in value as well as hue: full brightness
 * over a main colour at the floor, or this much darker than a brighter one (a darker step read brown
 * beside a yellow).
 */
const SECOND_DARKER = 0.1;

/**
 * The organs by rarity tier (ADR 0043): rarity raises saturation, glints and glow, never the spread
 * of hues. `vivid` (0..1) is how far the organs' saturation rises toward full (rare glints
 * take the organ tones by it); `glow` is the faint inner glow's luminance gain on the glowing organs,
 * and `glowing` how many organs glow (the heart or the largest chamber, then the next largest).
 */
export const ORGAN_RARITY: Readonly<
  Record<RarityTier, { vivid: number; glow: number; glowing: 1 | 2 }>
> = {
  common: { vivid: 0, glow: 0.06, glowing: 1 },
  uncommon: { vivid: 0.2, glow: 0.08, glowing: 1 },
  rare: { vivid: 0.45, glow: 0.1, glowing: 2 },
  exotic: { vivid: 0.8, glow: 0.12, glowing: 2 },
};
/** The glow's ceilings (ADR 0043): +15% luminance, or +35% with the luminescence gene. */
export const ORGAN_GLOW_MAX = 0.15;
export const ORGAN_GLOW_LUMINOUS = 0.35;
/**
 * The luminescence gene multiplies the tier's gain by this, well short of its ceiling: the post
 * chain's bloom spreads a share of any organ's light round it, and at +35% (or ×2) that share lit a
 * faint halo 3 to 5 px outside the organ (M6c T7).
 */
const LUMINOUS_GLOW = 1.3;

const ALBINO_HUE = 0.96;
const ALBINO_SATURATION = 0.08;
/** An albino has no pigment of its own, so its organs show the pink of the blood through clear tissue. */
const ALBINO_ORGAN_SATURATION = 0.45;
const PALE_SATURATION_SCALE = 0.4;
const IRIDESCENCE = { plain: 0, iridescent: 0.55, oil: 1 } as const;
/** Glow strength and whether it pulses, per luminescence allele; an unknown allele does not glow. */
const GLOW = { off: [0, 0], on: [0.8, 0], pulse: [0.8, 1] } as const;

export interface MaterialParams {
  /** The body's deep colour and its lit rim, 0..1 per channel. */
  core: Rgb;
  rim: Rgb;
  /** The gene colour after the albino rule (HSV saturation, 0..1); the shell takes `SHELL_SATURATION` of it. */
  saturation: number;
  /**
   * The organs' two related tones (ADR 0043): the main colour, the hue gene at its saturation (an
   * albino's blood pink), and the second tone, `SECOND_TURN` turns toward amber at the same
   * saturation and another value. The heart and half the chambers take the main colour, the other
   * chambers and the oil droplets the second; glint rays take either.
   */
  organ: Rgb;
  second: Rgb;
  /** The eyes' iris: the main colour at full saturation. */
  iris: Rgb;
  /** 0..1 by rarity tier (`ORGAN_RARITY`): how far organ saturation rises; rare glints take organ colours by it. */
  vivid: number;
  /** The glowing organs' luminance gain (`ORGAN_RARITY`, at most `ORGAN_GLOW_MAX`, or `ORGAN_GLOW_LUMINOUS` with the gene). */
  organGlow: number;
  translucency: number;
  membrane: number;
  pattern: number;
  /** Whole repeats, so the pattern closes around the body. */
  patternCount: number;
  iridescence: number;
  /** 0 when the glow is not expressed; it lights the water round the body (`lightOf`) and raises `organGlow`. */
  luminescence: number;
  /** 0 steady, 1 pulsing. */
  lumPulse: number;
  lumColor: Rgb;
  /** 0.5..1, how opaque the plates are. */
  plating: number;
  rimStrength: number;
}

function hsv(h: number, s: number, v: number): Rgb {
  const k = (n: number): number => (n + h * 6) % 6;
  const f = (n: number): number => v * (1 - s * Math.max(0, Math.min(k(n), 4 - k(n), 1)));
  return [f(5), f(3), f(1)];
}

export const luminance = ([r, g, b]: Rgb): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;

const toward = (c: Rgb, to: number, t: number): Rgb => [
  lerp(c[0], to, t),
  lerp(c[1], to, t),
  lerp(c[2], to, t),
];

/** Lightens `c` toward `to` (white by default) until it reaches `min` luminance; a bright colour is returned as it is. */
function liftTo(c: Rgb, min: number, to: Rgb = [1, 1, 1]): Rgb {
  const l = luminance(c);
  const top = luminance(to);
  if (l >= min || top <= l) return c;
  const t = (min - l) / (top - l);
  return [lerp(c[0], to[0], t), lerp(c[1], to[1], t), lerp(c[2], to[2], t)];
}

/** The shell's hue and saturation: the silver's chroma plus the gene's, capped at `SHELL_SATURATION`. */
function shellTint(hue: number, saturation: number): [number, number] {
  const gene = saturation * SHELL_SATURATION;
  const x =
    SILVER_SATURATION * Math.cos(2 * Math.PI * SILVER_HUE) + gene * Math.cos(2 * Math.PI * hue);
  const y =
    SILVER_SATURATION * Math.sin(2 * Math.PI * SILVER_HUE) + gene * Math.sin(2 * Math.PI * hue);
  const s = Math.min(Math.hypot(x, y), SHELL_SATURATION);
  const h = s > 0 ? (((Math.atan2(y, x) / (2 * Math.PI)) % 1) + 1) % 1 : SILVER_HUE;
  return [h, s];
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

/** The second tone's hue: `hue` turned `SECOND_TURN` toward amber by the gene saturation, the short way. */
function secondHue(hue: number, saturation: number): number {
  const d = ((((AMBER_HUE - hue) % 1) + 1.5) % 1) - 0.5;
  const turn = lerp(SECOND_TURN[0], SECOND_TURN[1], clamp(saturation, 0, 1));
  return (((hue + (d < 0 ? -turn : turn)) % 1) + 1) % 1;
}

/** `tier` is the body's rarity tier (`rarityOfTraits`); it sets only the organs' saturation and glow. */
export function materialParams(
  t: Pick<Traits, 'colour' | 'skin'>,
  tier: RarityTier = 'common',
): MaterialParams {
  const { colour, skin } = t;
  const albino = colour.albino === 'albino';
  const hue = albino ? ALBINO_HUE : colour.hue;
  const saturation = albino
    ? ALBINO_SATURATION
    : colour.albino === 'pale'
      ? colour.saturation * PALE_SATURATION_SCALE
      : colour.saturation;
  const glow = GLOW[colour.luminescence as keyof typeof GLOW] ?? GLOW.off;
  const value = albino ? Math.max(colour.value, 0.85) : colour.value;
  const [shellHue, shellSaturation] = albino
    ? [hue, saturation * SHELL_SATURATION]
    : shellTint(hue, saturation);
  const body = hsv(shellHue, shellSaturation, value);
  // A dark shell lifts toward its own silver, not toward white.
  const light: Rgb = albino ? [1, 1, 1] : hsv(shellHue, shellSaturation, 1);
  const luminous = glow[0] > 0;
  const inside = Math.max(value, ORGAN_VALUE);
  const geneSaturation = albino ? ALBINO_ORGAN_SATURATION : saturation;
  // An albino has no pigment to vary: its organs stay the pink of blood whatever the tier.
  const vivid = albino ? 0 : ORGAN_RARITY[tier].vivid;
  const organSaturation = lerp(geneSaturation, 1, vivid);
  const organ = hsv(hue, organSaturation, inside);
  const secondValue = inside > ORGAN_VALUE ? inside - SECOND_DARKER : 1;
  const organGlow = ORGAN_RARITY[tier].glow * (luminous ? LUMINOUS_GLOW : 1);

  return {
    core: liftTo(toward(body, 0, 0.5), MIN_CORE_LUMINANCE, light),
    rim: liftTo(toward(body, 1, 0.3), MIN_RIM_LUMINANCE, light),
    saturation,
    organ,
    second: hsv(secondHue(hue, geneSaturation), organSaturation, secondValue),
    iris: hsv(hue, 1, inside),
    vivid,
    organGlow,
    translucency: clamp(skin.translucency, 0, 1),
    membrane: clamp(skin.membrane, 0, 1),
    pattern: patternKind(colour.pattern),
    patternCount: 3 + Math.round(clamp(colour.patternScale, 0, 1) * 9),
    iridescence: IRIDESCENCE[skin.iridescence as keyof typeof IRIDESCENCE] ?? 0,
    luminescence: glow[0],
    lumPulse: glow[1],
    lumColor: hsv(colour.lumHue, 0.85, 1),
    plating: 0.5 + 0.5 * clamp(skin.plating, 0, 1),
    // Up to 1.5, so a dark, membranous body's rim stays coloured instead of clipping to white.
    rimStrength: 1 + 0.25 * clamp(skin.membrane, 0, 1) + 0.25 * (1 - clamp(value, 0, 1)),
  };
}
