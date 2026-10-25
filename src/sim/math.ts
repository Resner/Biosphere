// Deterministic math (ADR 0005). Only + - * / and Math.sqrt/floor/round/abs/min/max are used, so every
// engine produces identical bits. Kernels follow the fdlibm reductions and minimax polynomials.

export const PI = Math.PI;
export const TAU = 2 * Math.PI;

const HALF_PI = 1.5707963267948966;
const TWO_OVER_PI = 0.6366197723675814;
// pi/2 split into three 33-bit parts, so k * part is exact for |k| < 2^20 (Cody-Waite reduction).
const PIO2_1 = 1.5707963267341256;
const PIO2_2 = 6.077100506303966e-11;
const PIO2_3 = 2.0222662487111665e-21;

const S1 = -1.6666666666666632e-1;
const S2 = 8.333333333322489e-3;
const S3 = -1.984126982985795e-4;
const S4 = 2.7557313707070068e-6;
const S5 = -2.5050760253406863e-8;
const S6 = 1.58969099521155e-10;
const C1 = 4.16666666666666e-2;
const C2 = -1.388888888887411e-3;
const C3 = 2.480158728947673e-5;
const C4 = -2.7557314351390663e-7;
const C5 = 2.087572321298175e-9;
const C6 = -1.1359647557788195e-11;

function kernelSin(x: number): number {
  const z = x * x;
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  return x + z * x * (S1 + z * r);
}

function kernelCos(x: number): number {
  const z = x * x;
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  return 1 - (0.5 * z - z * r);
}

/** Reduces x to r in [-pi/4, pi/4] and returns the quadrant in `quadrant` (0..3). */
let quadrant = 0;
function reduce(x: number): number {
  const k = Math.round(x * TWO_OVER_PI);
  quadrant = (((k % 4) + 4) % 4) as number;
  return x - k * PIO2_1 - k * PIO2_2 - k * PIO2_3;
}

/** Accurate for |x| up to about 1e6; the sim only passes wrapped or bounded angles. */
export function sin(x: number): number {
  const r = reduce(x);
  switch (quadrant) {
    case 0:
      return kernelSin(r);
    case 1:
      return kernelCos(r);
    case 2:
      return -kernelSin(r);
    default:
      return -kernelCos(r);
  }
}

export function cos(x: number): number {
  const r = reduce(x);
  switch (quadrant) {
    case 0:
      return kernelCos(r);
    case 1:
      return -kernelSin(r);
    case 2:
      return -kernelCos(r);
    default:
      return kernelSin(r);
  }
}

const ATAN_HI = [
  4.636476090008061e-1, 7.853981633974483e-1, 9.827937232473291e-1, 1.5707963267948966,
] as const;
const ATAN_LO = [
  2.2698777452961687e-17, 3.061616997868383e-17, 1.3903311031230998e-17, 6.123233995736766e-17,
];
const AT = [
  3.3333333333332932e-1, -1.9999999999876483e-1, 1.4285714272503466e-1, -1.111111040546235e-1,
  9.090887133436507e-2, -7.69187620504483e-2, 6.661073137387531e-2, -5.833570133790573e-2,
  4.976877994615932e-2, -3.653157274421692e-2, 1.628582011536578e-2,
] as const;

function atan(x: number): number {
  const neg = x < 0;
  let a = neg ? -x : x;
  if (a > 7.378697629483821e19) return neg ? -ATAN_HI[3] : ATAN_HI[3];
  let id = -1;
  if (a < 0.4375) {
    if (a < 3.725290298461914e-9) return x;
  } else if (a < 1.1875) {
    if (a < 0.6875) {
      id = 0;
      a = (2 * a - 1) / (2 + a);
    } else {
      id = 1;
      a = (a - 1) / (a + 1);
    }
  } else if (a < 2.4375) {
    id = 2;
    a = (a - 1.5) / (1 + 1.5 * a);
  } else {
    id = 3;
    a = -1 / a;
  }
  const z = a * a;
  const w = z * z;
  const s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))));
  const s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))));
  if (id < 0) {
    const r = a - a * (s1 + s2);
    return neg ? -r : r;
  }
  const r = (ATAN_HI[id] ?? 0) - (a * (s1 + s2) - (ATAN_LO[id] ?? 0) - a);
  return neg ? -r : r;
}

export function atan2(y: number, x: number): number {
  if (x === 0) {
    if (y === 0) return 0;
    return y > 0 ? HALF_PI : -HALF_PI;
  }
  if (y === 0) return x > 0 ? 0 : PI;
  const a = atan(y / x);
  if (x > 0) return a;
  return y > 0 ? a + PI : a - PI;
}

const LN2_HI = 6.931471803691238e-1;
const LN2_LO = 1.9082149292705877e-10;
const LOG2E = Math.LOG2E;
const P1 = 1.6666666666666019e-1;
const P2 = -2.7777777770155933e-3;
const P3 = 6.613756321437934e-5;
const P4 = -1.6533902205465252e-6;
const P5 = 4.1381367970572385e-8;

const bitsView = new DataView(new ArrayBuffer(8));

/** 2^k for k in [-1022, 1023], built from the exponent bits. */
function pow2(k: number): number {
  bitsView.setUint32(0, (k + 1023) << 20);
  bitsView.setUint32(4, 0);
  return bitsView.getFloat64(0);
}

/** Underflows to 0 below -745 and clamps to e^709 above. */
export function exp(x: number): number {
  if (x < -745) return 0;
  const xc = Math.min(x, 709);
  const k = Math.round(xc * LOG2E);
  const r = xc - k * LN2_HI - k * LN2_LO;
  const t = r * r;
  const c = r - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
  const y = 1 + (r + (r * c) / (2 - c));
  const half = Math.trunc(k / 2);
  return y * pow2(half) * pow2(k - half);
}

const SQRT2 = Math.SQRT2;
const LG1 = 6.666666666666735e-1;
const LG2 = 3.999999999940942e-1;
const LG3 = 2.857142874366239e-1;
const LG4 = 2.222219843214978e-1;
const LG5 = 1.818357216161805e-1;
const LG6 = 1.5313837699209373e-1;
const LG7 = 1.4798198605116586e-1;
const TWO_54 = 18014398509481984;

export function log(x: number): number {
  if (!(x > 0) || x === Number.POSITIVE_INFINITY) {
    throw new RangeError(`log needs a finite x > 0, got ${x}`);
  }
  let v = x;
  let e = 0;
  bitsView.setFloat64(0, v);
  if (((bitsView.getUint32(0) >>> 20) & 0x7ff) === 0) {
    v *= TWO_54; // subnormal
    e -= 54;
    bitsView.setFloat64(0, v);
  }
  const hi = bitsView.getUint32(0);
  e += ((hi >>> 20) & 0x7ff) - 1023;
  bitsView.setUint32(0, (hi & 0x000fffff) | 0x3ff00000);
  let m = bitsView.getFloat64(0);
  if (m > SQRT2) {
    m *= 0.5;
    e += 1;
  }
  const f = m - 1;
  const s = f / (2 + f);
  const z = s * s;
  const w = z * z;
  const t1 = w * (LG2 + w * (LG4 + w * LG6));
  const t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
  const rr = t2 + t1;
  const hfsq = 0.5 * f * f;
  return e * LN2_HI - (hfsq - (s * (hfsq + rr) + e * LN2_LO) - f);
}

/** x ** y for x > 0, as exp(y log x). */
export function pow(x: number, y: number): number {
  if (y === 0) return 1;
  return exp(y * log(x));
}

/** Wraps an angle into (-PI, PI]. */
export function wrapAngle(a: number): number {
  const w = a - TAU * Math.floor((a + PI) / TAU);
  return w <= -PI ? w + TAU : w;
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(Math.max(x, lo), hi);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function length(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}
