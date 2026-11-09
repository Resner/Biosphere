// Colour vision (M14 T9): how a colour looks under each colour-vision deficiency, and how far
// apart two colours look. The simulation is Machado, Oliveira and Fernandes (2009) at severity 1,
// applied in linear light (sRGB decoded, then encoded again); the distance is CIEDE2000 in CIELAB
// under D65. Pure, for the cue inventory's tests and for the E2E spec's screenshots.

import { clamp } from '../sim/math';

/** An sRGB colour, each channel 0..1. */
export type Rgb = readonly [number, number, number];

export type Deficiency = 'protanopia' | 'deuteranopia' | 'tritanopia';
export const DEFICIENCIES: readonly Deficiency[] = ['protanopia', 'deuteranopia', 'tritanopia'];

/** The paper's severity-1 matrices, rows applied to linear RGB. */
export const MACHADO: Readonly<Record<Deficiency, readonly number[]>> = {
  protanopia: [
    0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998,
  ],
  deuteranopia: [
    0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881,
  ],
  tritanopia: [
    1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.3039,
  ],
};

const clamp01 = (v: number): number => clamp(v, 0, 1);

/** sRGB's transfer function, encoded 0..1 to linear 0..1. */
export function toLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Linear 0..1 to sRGB-encoded 0..1. */
export function toSrgb(c: number): number {
  const v = clamp01(c);
  return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
}

/** `rgb` as someone with `deficiency` sees it. */
export function simulate(rgb: Rgb, deficiency: Deficiency): Rgb {
  const m = MACHADO[deficiency];
  const r = toLinear(rgb[0]);
  const g = toLinear(rgb[1]);
  const b = toLinear(rgb[2]);
  const at = (i: number) => m[i] as number;
  return [
    toSrgb(at(0) * r + at(1) * g + at(2) * b),
    toSrgb(at(3) * r + at(4) * g + at(5) * b),
    toSrgb(at(6) * r + at(7) * g + at(8) * b),
  ];
}

const ENCODE_STEPS = 4096;
let tables: { lin: Float64Array; enc: Uint8Array } | undefined;

/** The decode table (256 entries) and the encode table (4,096 linear steps), built once. */
function pixelTables(): { lin: Float64Array; enc: Uint8Array } {
  tables ??= {
    lin: Float64Array.from({ length: 256 }, (_, i) => toLinear(i / 255)),
    enc: Uint8Array.from({ length: ENCODE_STEPS + 1 }, (_, i) =>
      Math.round(toSrgb(i / ENCODE_STEPS) * 255),
    ),
  };
  return tables;
}

/**
 * A simulator for 8-bit RGBA pixels in place (a screenshot's): decoding through a table of 256 and
 * encoding through one of 4,096 linear steps, so a whole screen takes well under a second.
 */
export function pixelSimulator(deficiency: Deficiency): (px: Uint8Array) => void {
  const m = MACHADO[deficiency];
  const { lin, enc } = pixelTables();
  const out = (v: number) => enc[Math.round(clamp01(v) * ENCODE_STEPS)] as number;
  const at = (i: number) => m[i] as number;
  return (px) => {
    for (let i = 0; i + 3 < px.length; i += 4) {
      const r = lin[px[i] as number] as number;
      const g = lin[px[i + 1] as number] as number;
      const b = lin[px[i + 2] as number] as number;
      px[i] = out(at(0) * r + at(1) * g + at(2) * b);
      px[i + 1] = out(at(3) * r + at(4) * g + at(5) * b);
      px[i + 2] = out(at(6) * r + at(7) * g + at(8) * b);
    }
  };
}

/** CIELAB (D65) of an sRGB colour. */
export function lab(rgb: Rgb): Rgb {
  const r = toLinear(rgb[0]);
  const g = toLinear(rgb[1]);
  const b = toLinear(rgb[2]);
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const DEG = Math.PI / 180;

/** CIEDE2000 between two CIELAB colours (Sharma, Wu and Dalal 2005), with kL = kC = kH = 1. */
export function deltaE2000(p: Rgb, q: Rgb): number {
  const [l1, a1, b1] = p;
  const [l2, a2, b2] = q;
  const c1 = Math.hypot(a1, b1);
  const c2 = Math.hypot(a2, b2);
  const cBar7 = ((c1 + c2) / 2) ** 7;
  const g = 0.5 * (1 - Math.sqrt(cBar7 / (cBar7 + 25 ** 7)));
  const ap1 = (1 + g) * a1;
  const ap2 = (1 + g) * a2;
  const cp1 = Math.hypot(ap1, b1);
  const cp2 = Math.hypot(ap2, b2);
  const hue = (b: number, a: number) => {
    if (a === 0 && b === 0) return 0;
    const h = Math.atan2(b, a) / DEG;
    return h < 0 ? h + 360 : h;
  };
  const hp1 = hue(b1, ap1);
  const hp2 = hue(b2, ap2);
  const dL = l2 - l1;
  const dC = cp2 - cp1;
  let dh = 0;
  if (cp1 * cp2 !== 0) {
    dh = hp2 - hp1;
    if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
  }
  const dH = 2 * Math.sqrt(cp1 * cp2) * Math.sin((dh / 2) * DEG);
  const lBar = (l1 + l2) / 2;
  const cBar = (cp1 + cp2) / 2;
  let hBar = hp1 + hp2;
  if (cp1 * cp2 !== 0) {
    if (Math.abs(hp1 - hp2) <= 180) hBar /= 2;
    else hBar = hp1 + hp2 < 360 ? (hBar + 360) / 2 : (hBar - 360) / 2;
  }
  const t =
    1 -
    0.17 * Math.cos((hBar - 30) * DEG) +
    0.24 * Math.cos(2 * hBar * DEG) +
    0.32 * Math.cos((3 * hBar + 6) * DEG) -
    0.2 * Math.cos((4 * hBar - 63) * DEG);
  const dTheta = 30 * Math.exp(-(((hBar - 275) / 25) ** 2));
  const cBarP7 = cBar ** 7;
  const rC = 2 * Math.sqrt(cBarP7 / (cBarP7 + 25 ** 7));
  const sL = 1 + (0.015 * (lBar - 50) ** 2) / Math.sqrt(20 + (lBar - 50) ** 2);
  const sC = 1 + 0.045 * cBar;
  const sH = 1 + 0.015 * cBar * t;
  const rT = -Math.sin(2 * dTheta * DEG) * rC;
  const kl = dL / sL;
  const kc = dC / sC;
  const kh = dH / sH;
  return Math.sqrt(kl * kl + kc * kc + kh * kh + rT * kc * kh);
}

/** How far apart two sRGB colours look, as someone with `deficiency` (or full colour vision) sees them. */
export function distance(a: Rgb, b: Rgb, deficiency?: Deficiency): number {
  const p = deficiency ? simulate(a, deficiency) : a;
  const q = deficiency ? simulate(b, deficiency) : b;
  return deltaE2000(lab(p), lab(q));
}
