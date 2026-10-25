import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { atan2, clamp, cos, exp, length, lerp, log, PI, pow, sin, TAU, wrapAngle } from './math';
import { createRng, seedFromString } from './prng';

const SAMPLES = 100_000;
const GOLDEN = new URL('./__golden__/math.json', import.meta.url);

function rng(purpose: string) {
  return createRng(seedFromString('math-test'), purpose);
}

function relErr(actual: number, expected: number): number {
  return Math.abs(actual - expected) / Math.abs(expected);
}

const view = new DataView(new ArrayBuffer(8));
function bits(x: number): string {
  view.setFloat64(0, x);
  return view.getBigUint64(0).toString(16).padStart(16, '0');
}
function fromBits(hex: string): number {
  view.setBigUint64(0, BigInt(`0x${hex}`));
  return view.getFloat64(0);
}

describe('accuracy against Math.*', () => {
  it('sin and cos: absolute error <= 1e-12 for x in [-1e4, 1e4]', () => {
    const r = rng('trig');
    let worst = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const x = r.range(-1e4, 1e4);
      worst = Math.max(worst, Math.abs(sin(x) - Math.sin(x)), Math.abs(cos(x) - Math.cos(x)));
    }
    expect(worst).toBeLessThanOrEqual(1e-12);
  });

  it('atan2: absolute error <= 1e-12', () => {
    const r = rng('atan2');
    let worst = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const y = r.range(-100, 100);
      const x = r.range(-100, 100);
      worst = Math.max(worst, Math.abs(atan2(y, x) - Math.atan2(y, x)));
    }
    expect(worst).toBeLessThanOrEqual(1e-12);
  });

  it('exp: relative error <= 1e-12 for x in [-50, 50]', () => {
    const r = rng('exp');
    let worst = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const x = r.range(-50, 50);
      worst = Math.max(worst, relErr(exp(x), Math.exp(x)));
    }
    expect(worst).toBeLessThanOrEqual(1e-12);
  });

  it('log: relative error <= 1e-12 for x in [1e-6, 1e6]', () => {
    const r = rng('log');
    let worst = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const x = r.range(1e-6, 1e6);
      worst = Math.max(worst, relErr(log(x), Math.log(x)));
    }
    expect(worst).toBeLessThanOrEqual(1e-12);
  });

  it('pow: relative error <= 1e-11 for x in [1e-3, 1e6], y in [-3, 3]', () => {
    const r = rng('pow');
    let worst = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const x = r.range(1e-3, 1e6);
      const y = r.range(-3, 3);
      worst = Math.max(worst, relErr(pow(x, y), x ** y));
    }
    expect(worst).toBeLessThanOrEqual(1e-11);
  });

  it('handles the special points exactly', () => {
    expect(sin(0)).toBe(0);
    expect(cos(0)).toBe(1);
    expect(exp(0)).toBe(1);
    expect(log(1)).toBe(0);
    expect(pow(7, 0)).toBe(1);
    expect(atan2(0, 1)).toBe(0);
    expect(atan2(1, 0)).toBe(PI / 2);
    expect(atan2(0, -1)).toBe(PI);
    expect(exp(-800)).toBe(0);
    expect(() => log(0)).toThrow();
    expect(() => log(-1)).toThrow();
    expect(() => pow(-2, 2)).toThrow();
  });
});

describe('helpers', () => {
  it('wrapAngle maps into (-PI, PI]', () => {
    expect(wrapAngle(0)).toBe(0);
    expect(wrapAngle(PI)).toBe(PI);
    expect(wrapAngle(-PI)).toBe(PI);
    expect(wrapAngle(TAU + 0.5)).toBeCloseTo(0.5, 12);
    expect(wrapAngle(-TAU - 0.5)).toBeCloseTo(-0.5, 12);
    expect(wrapAngle(3 * PI + 0.25)).toBeCloseTo(-PI + 0.25, 12);
  });

  it('clamp, lerp and length', () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-5, 0, 3)).toBe(0);
    expect(clamp(2, 0, 3)).toBe(2);
    expect(lerp(10, 20, 0.25)).toBe(12.5);
    expect(length(3, 4)).toBe(5);
  });
});

describe('golden table', () => {
  type Table = Record<string, string[][]>;

  function build(): Table {
    const r = rng('golden');
    const t: Table = { sin: [], cos: [], atan2: [], exp: [], log: [], pow: [] };
    for (let i = 0; i < 64; i++) {
      const a = r.range(-1e4, 1e4);
      t.sin?.push([bits(a), bits(sin(a))]);
      const b = r.range(-1e4, 1e4);
      t.cos?.push([bits(b), bits(cos(b))]);
      const y = r.range(-100, 100);
      const x = r.range(-100, 100);
      t.atan2?.push([bits(y), bits(x), bits(atan2(y, x))]);
      const e = r.range(-50, 50);
      t.exp?.push([bits(e), bits(exp(e))]);
      const l = r.range(1e-6, 1e6);
      t.log?.push([bits(l), bits(log(l))]);
      const px = r.range(1e-3, 1e6);
      const py = r.range(-3, 3);
      t.pow?.push([bits(px), bits(py), bits(pow(px, py))]);
    }
    return t;
  }

  it('matches bit for bit', () => {
    if (process.env.UPDATE_GOLDENS) {
      writeFileSync(GOLDEN, `${JSON.stringify(build(), null, 1)}\n`);
    }
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Table;
    const fns: Record<string, (...a: number[]) => number> = {
      sin: (a) => sin(a as number),
      cos: (a) => cos(a as number),
      atan2: (y, x) => atan2(y as number, x as number),
      exp: (a) => exp(a as number),
      log: (a) => log(a as number),
      pow: (a, b) => pow(a as number, b as number),
    };
    for (const [name, rows] of Object.entries(golden)) {
      expect(rows).toHaveLength(64);
      const fn = fns[name];
      if (!fn) throw new Error(`unknown function ${name}`);
      for (const row of rows) {
        const out = row[row.length - 1] as string;
        const ins = row.slice(0, -1).map(fromBits);
        expect(bits(fn(...ins)), `${name}(${ins.join(', ')})`).toBe(out);
      }
    }
  });
});
