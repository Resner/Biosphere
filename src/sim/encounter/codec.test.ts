import { describe, expect, it } from 'vitest';
import { createRng, seedFromString } from '../prng';
import { decodeFrameInput, encodeFrameInput } from './codec';
import type { FrameInput, Stance } from './types';

const STANCES: Stance[] = ['balanced', 'aggressive', 'evasive'];
const ok: FrameInput = {
  steer: 7,
  throttle: 9,
  dash: true,
  stance: 'aggressive',
  target: 5,
  brace: true,
};

describe('frame input codec', () => {
  it('round-trips every field combination over a seeded 10k sample', () => {
    const rng = createRng(seedFromString('frame-codec'), 'sample');
    for (let i = 0; i < 10_000; i++) {
      const u = rng.nextU32();
      const input: FrameInput = {
        steer: u & 0xff,
        throttle: (u >>> 8) & 0xf,
        dash: ((u >>> 12) & 1) === 1,
        stance: STANCES[(u >>> 13) % 3] as Stance,
        target: (u >>> 16) & 7,
        brace: ((u >>> 19) & 1) === 1,
      };
      expect(decodeFrameInput(encodeFrameInput(input))).toEqual(input);
    }
  });

  it('packs the documented bits', () => {
    expect(
      encodeFrameInput({
        ...ok,
        steer: 0,
        throttle: 0,
        dash: false,
        stance: 'balanced',
        target: 0,
        brace: false,
      }),
    ).toBe(0);
    expect(
      encodeFrameInput({
        ...ok,
        steer: 1,
        throttle: 0,
        dash: false,
        stance: 'balanced',
        target: 0,
        brace: false,
      }),
    ).toBe(1);
    expect(
      encodeFrameInput({
        ...ok,
        steer: 0,
        throttle: 1,
        dash: false,
        stance: 'balanced',
        target: 0,
        brace: false,
      }),
    ).toBe(1 << 8);
    expect(
      encodeFrameInput({
        ...ok,
        steer: 0,
        throttle: 0,
        dash: true,
        stance: 'balanced',
        target: 0,
        brace: false,
      }),
    ).toBe(1 << 12);
    expect(
      encodeFrameInput({
        ...ok,
        steer: 0,
        throttle: 0,
        dash: false,
        stance: 'evasive',
        target: 0,
        brace: false,
      }),
    ).toBe(2 << 13);
    expect(
      encodeFrameInput({
        ...ok,
        steer: 0,
        throttle: 0,
        dash: false,
        stance: 'balanced',
        target: 7,
        brace: false,
      }),
    ).toBe(7 << 15);
    expect(
      encodeFrameInput({
        ...ok,
        steer: 0,
        throttle: 0,
        dash: false,
        stance: 'balanced',
        target: 0,
        brace: true,
      }),
    ).toBe(1 << 18);
  });

  it('decodes any number without throwing', () => {
    const odd = [
      Number.NaN,
      -1,
      -0,
      0.5,
      2 ** 32,
      2 ** 32 + 5,
      2 ** 53,
      -(2 ** 40),
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.MAX_VALUE,
    ];
    for (const n of odd) {
      const d = decodeFrameInput(n);
      expect(d.steer).toBeGreaterThanOrEqual(0);
      expect(d.steer).toBeLessThanOrEqual(255);
      expect(STANCES).toContain(d.stance);
      expect(d.target).toBeLessThanOrEqual(7);
    }
    expect(decodeFrameInput(3 << 13).stance).toBe('balanced');
    expect(decodeFrameInput(0xfff80000)).toEqual(decodeFrameInput(0));
  });

  it('throws RangeError for each field out of range', () => {
    const bad: Partial<FrameInput>[] = [
      { steer: -1 },
      { steer: 256 },
      { steer: 1.5 },
      { steer: Number.NaN },
      { throttle: -1 },
      { throttle: 16 },
      { target: 8 },
      { target: -1 },
      { stance: 'wild' as Stance },
    ];
    for (const patch of bad) {
      expect(() => encodeFrameInput({ ...ok, ...patch })).toThrow(RangeError);
    }
  });
});
