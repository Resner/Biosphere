import { describe, expect, it } from 'vitest';
import type { DeathCause } from '../sim/types';
import { SHAKE, Shake, shakeKind } from './shake';

const FRAME = 1 / 60;
const TICK_HZ = 30;

interface Run {
  /** Per frame: seconds since the run began, the offsets (body radii, camera px) and the kind. */
  t: number[];
  body: number[];
  camera: number[];
  kinds: Set<string | null>;
  /** The sim seconds at which a hit landed. */
  hits: number[];
}

/**
 * Runs `seconds` of 60 Hz frames over a 30 Hz sim that deals `amount` of `cause` every tick while
 * `cause` is set (ticks counted from `tick0`), the way the shell feeds the shake.
 */
function run(
  shake: Shake,
  seconds: number,
  cause: DeathCause | null,
  { amount = 0.07, reduced = false, tick0 = 0 } = {},
): Run {
  const out: Run = { t: [], body: [], camera: [], kinds: new Set(), hits: [] };
  const frames = Math.round(seconds / FRAME);
  let tick = 0;
  for (let f = 0; f < frames; f++) {
    // The ticks due by this frame's time run before it draws.
    while (tick / TICK_HZ <= f * FRAME + 1e-9) {
      if (cause && shake.hit(cause, amount, tick0 + tick)) out.hits.push(tick / TICK_HZ);
      tick++;
    }
    shake.update(FRAME, reduced);
    out.t.push(f * FRAME);
    out.body.push(Math.hypot(shake.body.x, shake.body.y));
    out.camera.push(Math.hypot(shake.camera.x, shake.camera.y));
    out.kinds.add(shake.kind);
  }
  return out;
}

/** The sample nearest `t` seconds into the run. */
const at = (values: readonly number[], t: number): number =>
  values[Math.round(t / FRAME)] as number;

describe('Shake: damage lands as hits, in intervals (M6c T9)', () => {
  it('maps each damage over time to the kind of hit it shows', () => {
    expect(shakeKind('uv')).toBe('uv');
    expect(shakeKind('pressure')).toBe('pressure');
    expect(shakeKind('toxin')).toBe('jolt');
    expect(shakeKind('starved')).toBe('jolt');
  });

  it('stands still with no damage', () => {
    const shake = new Shake();
    const s = run(shake, 1, null);
    expect(Math.max(...s.body)).toBe(0);
    expect(Math.max(...s.camera)).toBe(0);
    expect(shake.kind).toBeNull();
    expect(shake.hits).toBe(0);
  });

  it('3 s of steady UV gives 6 hits, every 0.5 s from the first tick, and stillness between', () => {
    // Ticks 0..89 are the 3.0 s; the tick at exactly 3.0 s lies outside it.
    const shake = new Shake();
    const s = run(shake, 3, 'uv');
    expect(s.hits).toEqual([0, 0.5, 1, 1.5, 2, 2.5]);
    expect(shake.hits).toBe(6);
    for (const h of s.hits) {
      expect(at(s.camera, h), `the kick at ${h} s`).toBeGreaterThanOrEqual(SHAKE.kickPx.min);
      expect(at(s.body, h), `the jolt at ${h} s`).toBeCloseTo(SHAKE.bodyRadii, 6);
      expect(at(s.camera, h + 0.45), `still 0.45 s after ${h} s`).toBe(0);
      expect(at(s.body, h + 0.45), `still 0.45 s after ${h} s`).toBe(0);
    }
    expect([...s.kinds]).toEqual(expect.arrayContaining(['uv', null]));
  });

  it('every cause shares the cadence, and a mix of causes still hits at most every 0.5 s', () => {
    for (const cause of ['uv', 'pressure', 'toxin', 'starved'] as const) {
      expect(run(new Shake(), 3, cause).hits, cause).toHaveLength(6);
    }
    const shake = new Shake();
    for (let tick = 0; tick < 90; tick++) {
      shake.hit('uv', 0.07, tick);
      shake.hit('pressure', 0.1, tick);
      shake.hit('toxin', 0.5, tick);
    }
    expect(shake.hits).toBe(6);
  });

  it('the first hit after a pause lands at once', () => {
    const shake = new Shake();
    expect(shake.hit('toxin', 0.5, 100)).toBe(true);
    expect(shake.hit('toxin', 0.5, 101)).toBe(false);
    expect(shake.hit('toxin', 0.5, 100 + SHAKE.everyTicks)).toBe(true);
    // Long after, the next damage hits on its first tick.
    expect(shake.hit('uv', 0.07, 1000)).toBe(true);
  });

  it('the kick scales with the damage since the last hit, from 5 px to a cap of 8', () => {
    const peak = (amount: number) => {
      const s = run(new Shake(), 0.6, 'toxin', { amount });
      // The second hit carries half a second of damage.
      return at(s.camera, 0.5);
    };
    const light = peak(0.01);
    const medium = peak(0.2);
    const heavy = peak(5);
    expect(light).toBeGreaterThanOrEqual(5);
    expect(light).toBeLessThan(medium);
    expect(medium).toBeLessThan(heavy);
    expect(heavy).toBeCloseTo(SHAKE.kickPx.max, 6);
    expect(peak(1000)).toBeLessThanOrEqual(8);
  });

  it('the kick turns by the golden angle from one hit to the next', () => {
    const shake = new Shake();
    const dirs: number[] = [];
    for (let i = 0; i < 3; i++) {
      shake.hit('uv', 0.07, i * SHAKE.everyTicks);
      shake.update(FRAME, false);
      dirs.push(Math.atan2(shake.camera.y, shake.camera.x));
      shake.update(0.5, false);
    }
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 1; i < dirs.length; i++) {
      const turn = ((dirs[i] as number) - (dirs[i - 1] as number) + 4 * Math.PI) % (2 * Math.PI);
      expect(turn).toBeCloseTo(golden, 6);
    }
  });

  it('decays over 0.25 s and settles to exactly 0', () => {
    const shake = new Shake();
    shake.hit('toxin', 1, 0);
    const s = run(shake, 0.5, null);
    expect(at(s.camera, 0)).toBeGreaterThan(at(s.camera, 0.1));
    expect(at(s.camera, 0.1)).toBeGreaterThan(at(s.camera, 0.2));
    expect(Math.max(...s.camera.slice(Math.ceil(SHAKE.decaySeconds / FRAME) + 1))).toBe(0);
    expect(Math.max(...s.body.slice(Math.ceil(SHAKE.decaySeconds / FRAME) + 1))).toBe(0);
    expect(shake.kind).toBeNull();
  });

  it('under Reduce motion the hits still count, with zero offset', () => {
    for (const cause of ['uv', 'pressure', 'toxin'] as const) {
      const shake = new Shake();
      const s = run(shake, 1.5, cause, { reduced: true });
      expect(Math.max(...s.body), cause).toBe(0);
      expect(Math.max(...s.camera), cause).toBe(0);
      expect(shake.hits, cause).toBe(3);
    }
  });

  it('a long pause moves it on by at most a short step', () => {
    const shake = new Shake();
    shake.hit('pressure', 0.1, 0);
    shake.update(30, false);
    shake.update(FRAME, false);
    expect(Math.hypot(shake.camera.x, shake.camera.y)).toBeGreaterThan(0);
    expect(Math.hypot(shake.camera.x, shake.camera.y)).toBeLessThanOrEqual(SHAKE.kickPx.max);
  });

  it('reset stops it at once and starts the count again', () => {
    const shake = new Shake();
    run(shake, 0.5, 'uv', { tick0: 500 });
    expect(shake.hits).toBeGreaterThan(0);
    shake.reset();
    expect(shake.body).toEqual({ x: 0, y: 0 });
    expect(shake.camera).toEqual({ x: 0, y: 0 });
    expect(shake.kind).toBeNull();
    expect(shake.hits).toBe(0);
    // A new life's tick starts over at 0, and its first damage hits at once.
    expect(shake.hit('uv', 0.07, 0)).toBe(true);
  });
});
