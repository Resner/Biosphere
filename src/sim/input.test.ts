import { describe, expect, it } from 'vitest';
import { angleToSteer, decodeInput, encodeInput, IDLE, type Input, steerToAngle } from './input';
import { PI, TAU } from './math';

describe('input encoding', () => {
  it('round-trips all 256 × 16 × 2 inputs through a u16', () => {
    for (let steer = 0; steer < 256; steer++)
      for (let throttle = 0; throttle < 16; throttle++)
        for (const dash of [false, true]) {
          const input: Input = { steer, throttle, dash };
          const code = encodeInput(input);
          expect(code).toBeGreaterThanOrEqual(0);
          expect(code).toBeLessThan(65536);
          expect(decodeInput(code)).toEqual(input);
        }
  });

  it('has an idle input that encodes to zero', () => {
    expect(IDLE).toEqual({ steer: 0, throttle: 0, dash: false });
    expect(encodeInput(IDLE)).toBe(0);
  });

  it('rejects out-of-range fields', () => {
    expect(() => encodeInput({ steer: 256, throttle: 0, dash: false })).toThrow();
    expect(() => encodeInput({ steer: 0, throttle: 16, dash: false })).toThrow();
    expect(() => encodeInput({ steer: 1.5, throttle: 0, dash: false })).toThrow();
  });

  it('maps steer to angles with 0 east, counter-clockwise', () => {
    expect(steerToAngle(0)).toBe(0);
    expect(steerToAngle(64)).toBeCloseTo(PI / 2, 12);
    expect(steerToAngle(96)).toBeCloseTo((3 * PI) / 4, 12);
    expect(steerToAngle(128)).toBeCloseTo(PI, 12);
    expect(steerToAngle(192)).toBeCloseTo(-PI / 2, 12);
  });

  it('quantises angles back to steer values', () => {
    for (let steer = 0; steer < 256; steer++) expect(angleToSteer(steerToAngle(steer))).toBe(steer);
    expect(angleToSteer(-PI / 2)).toBe(192);
    expect(angleToSteer(TAU + 0.001)).toBe(0);
    expect(angleToSteer(-0.001)).toBe(0);
  });
});
