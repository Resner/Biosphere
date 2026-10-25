import { TAU, wrapAngle } from './math';

/** One tick of player intent. Angle 0 points east (+x) and grows counter-clockwise; world y is up. */
export interface Input {
  /** Heading wanted, in 256 steps round the circle. */
  steer: number;
  /** 0 = coast, 15 = full thrust. */
  throttle: number;
  dash: boolean;
}

export const IDLE: Readonly<Input> = Object.freeze({ steer: 0, throttle: 0, dash: false });

const STEER_STEPS = 256;
const THROTTLE_STEPS = 16;

/** Packs an input into a u16: steer in bits 0-7, throttle in bits 8-11, dash in bit 12. */
export function encodeInput(input: Input): number {
  const { steer, throttle } = input;
  if (!Number.isInteger(steer) || steer < 0 || steer >= STEER_STEPS)
    throw new RangeError(`steer out of range: ${steer}`);
  if (!Number.isInteger(throttle) || throttle < 0 || throttle >= THROTTLE_STEPS)
    throw new RangeError(`throttle out of range: ${throttle}`);
  return steer | (throttle << 8) | (input.dash ? 1 << 12 : 0);
}

/** Total: any number decodes, and bits above the dash flag are ignored. */
export function decodeInput(code: number): Input {
  return { steer: code & 0xff, throttle: (code >> 8) & 0xf, dash: ((code >> 12) & 1) === 1 };
}

export function steerToAngle(steer: number): number {
  return wrapAngle((steer * TAU) / STEER_STEPS);
}

export function angleToSteer(angle: number): number {
  const steps = Math.round((wrapAngle(angle) * STEER_STEPS) / TAU);
  return ((steps % STEER_STEPS) + STEER_STEPS) % STEER_STEPS;
}
