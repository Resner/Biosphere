import { describe, expect, it } from 'vitest';
import type { DeathCause } from '../sim/types';
import { SHAKE, Shake, shakeKind } from './shake';

const FRAME = 1 / 60;
const TICK = 1 / 30;

/** Runs `seconds` of frames, hitting with `cause` every sim tick while `hitting`; returns the samples. */
function run(
  shake: Shake,
  seconds: number,
  cause: DeathCause | null,
  reduced = false,
): { body: number[]; bx: number[]; camera: number[]; kinds: Set<string | null> } {
  const out = {
    body: [] as number[],
    bx: [] as number[],
    camera: [] as number[],
    kinds: new Set<string | null>(),
  };
  let sinceTick = TICK;
  for (let t = 0; t < seconds; t += FRAME) {
    sinceTick += FRAME;
    if (cause && sinceTick >= TICK) {
      sinceTick -= TICK;
      shake.hit(cause);
    }
    shake.update(FRAME, reduced);
    out.body.push(Math.hypot(shake.body.x, shake.body.y));
    out.bx.push(shake.body.x);
    out.camera.push(Math.hypot(shake.camera.x, shake.camera.y));
    out.kinds.add(shake.kind);
  }
  return out;
}

/** Sign changes per second of a sampled signal. */
const crossings = (values: readonly number[]): number => {
  let n = 0;
  for (let i = 1; i < values.length; i++) {
    if (Math.sign(values[i] as number) !== Math.sign(values[i - 1] as number)) n++;
  }
  return n / (values.length * FRAME);
};

describe('Shake (M6b T10)', () => {
  it('maps each damage over time to its shake', () => {
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
  });

  for (const cause of ['uv', 'pressure', 'toxin', 'starved'] as const) {
    it(`${cause}: the body moves at most 6% of its radius and the camera at most 1.5 px`, () => {
      const shake = new Shake();
      const s = run(shake, 3, cause);
      expect(Math.max(...s.body)).toBeLessThanOrEqual(SHAKE.bodyMax + 1e-9);
      expect(Math.max(...s.body)).toBeGreaterThan(SHAKE.bodyMax * 0.3);
      expect(Math.max(...s.camera)).toBeLessThanOrEqual(SHAKE.cameraMaxPx + 1e-9);
      expect(Math.max(...s.camera)).toBeGreaterThan(0.3);
      expect([...s.kinds].filter((k) => k !== null)).toEqual([shakeKind(cause)]);
    });
  }

  it('UV trembles fast and fine, pressure squeezes slowly', () => {
    const uv = run(new Shake(), 2, 'uv');
    const pressure = run(new Shake(), 2, 'pressure');
    expect(crossings(uv.bx)).toBeGreaterThanOrEqual(12);
    expect(crossings(pressure.bx)).toBeLessThanOrEqual(5);
    // Fine: the tremble stays smaller than the squeeze.
    expect(Math.max(...uv.body)).toBeLessThan(Math.max(...pressure.body));
  });

  it('toxin and starvation jolt briefly, not a steady wobble', () => {
    const shake = new Shake();
    shake.hit('toxin');
    const s = run(shake, 1.5, null);
    const peak = s.body.indexOf(Math.max(...s.body));
    expect(peak * FRAME).toBeLessThan(0.1);
    // Over within half a second.
    expect(Math.max(...s.body.slice(Math.ceil(0.5 / FRAME)))).toBe(0);
    // A steady trickle of damage jolts again now and then, never every tick.
    const steady = run(new Shake(), 3, 'starved');
    let jolts = 0;
    for (let i = 1; i < steady.body.length; i++) {
      if ((steady.body[i] as number) > 0 && steady.body[i - 1] === 0) jolts++;
    }
    expect(jolts).toBeGreaterThanOrEqual(2);
    expect(jolts).toBeLessThanOrEqual(5);
  });

  it('settles to exactly 0 soon after the damage stops', () => {
    const shake = new Shake();
    run(shake, 1, 'uv');
    const after = run(shake, 1, null);
    expect(after.body.at(-1)).toBe(0);
    expect(after.camera.at(-1)).toBe(0);
    expect(shake.kind).toBeNull();
  });

  it('never shakes under Reduce motion', () => {
    for (const cause of ['uv', 'pressure', 'toxin'] as const) {
      const s = run(new Shake(), 1, cause, true);
      expect(Math.max(...s.body), cause).toBe(0);
      expect(Math.max(...s.camera), cause).toBe(0);
    }
  });

  it('a long pause moves it on by at most a short step', () => {
    const shake = new Shake();
    shake.hit('pressure');
    shake.update(30, false);
    expect(Math.hypot(shake.body.x, shake.body.y)).toBeLessThanOrEqual(SHAKE.bodyMax);
  });

  it('reset stops it at once', () => {
    const shake = new Shake();
    run(shake, 0.5, 'uv');
    shake.reset();
    expect(shake.body).toEqual({ x: 0, y: 0 });
    expect(shake.camera).toEqual({ x: 0, y: 0 });
    expect(shake.kind).toBeNull();
  });
});
