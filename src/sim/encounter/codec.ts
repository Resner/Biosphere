// The per-frame input as one u32 (ADR 0050). Bits: steer 0-7, throttle 8-11, dash 12, stance
// 13-14 (0 balanced, 1 aggressive, 2 evasive; 3 reads as balanced), target 15-17, brace 18.

import type { FrameInput, Stance } from './types';

const STANCES: readonly Stance[] = ['balanced', 'aggressive', 'evasive'];

const inRange = (n: number, max: number): boolean => Number.isInteger(n) && n >= 0 && n <= max;

export function encodeFrameInput(input: FrameInput): number {
  const { steer, throttle, target } = input;
  if (!inRange(steer, 255)) throw new RangeError(`steer out of range: ${steer}`);
  if (!inRange(throttle, 15)) throw new RangeError(`throttle out of range: ${throttle}`);
  if (!inRange(target, 7)) throw new RangeError(`target out of range: ${target}`);
  const stance = STANCES.indexOf(input.stance);
  if (stance < 0) throw new RangeError(`unknown stance: ${String(input.stance)}`);
  return (
    (steer |
      (throttle << 8) |
      ((input.dash ? 1 : 0) << 12) |
      (stance << 13) |
      (target << 15) |
      ((input.brace ? 1 : 0) << 18)) >>>
    0
  );
}

/** Total: any number decodes (`>>> 0` takes NaN and infinities to 0), and bits above 18 are ignored. */
export function decodeFrameInput(code: number): FrameInput {
  const c = code >>> 0;
  return {
    steer: c & 0xff,
    throttle: (c >>> 8) & 0xf,
    dash: ((c >>> 12) & 1) === 1,
    stance: STANCES[(c >>> 13) & 3] ?? 'balanced',
    target: (c >>> 15) & 7,
    brace: ((c >>> 18) & 1) === 1,
  };
}
