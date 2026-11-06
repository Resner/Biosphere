import { describe, expect, it } from 'vitest';
import type { EncJoin } from '../src/net/encounter-start';
import { type Frames, packFrames, unpackFrames } from './fight-pack';

// M9 T10 (ADR 0056): a fight's frames as 4-byte codes in one base64 text.

const join = (f: number) => ({ t: 'enc-join', f }) as unknown as EncJoin;

describe('packed fight frames', () => {
  it('round-trips frames, the fallback and the largest code, with a join widening later frames', () => {
    const frames: Frames = [
      [0, 1],
      [0x7ffff, null],
      [0xfffffffe, 5],
      [3, null, 9],
      [null, null, null],
    ];
    const text = packFrames(frames);
    expect(unpackFrames(text, 2, [join(3)])).toEqual(frames);
  });

  it('takes 4 bytes a code: 300 frames of a duel are 3200 base64 characters', () => {
    const frames: Frames = Array.from({ length: 300 }, (_, f) => [f, null]);
    expect(packFrames(frames)).toHaveLength(3200);
  });

  it('packs no frames as the empty text', () => {
    expect(packFrames([])).toBe('');
    expect(unpackFrames('', 2, [])).toEqual([]);
  });

  it('packs a long log without overflowing the stack', () => {
    const frames: Frames = Array.from({ length: 900 }, () => [1, 2, 3, 4]);
    expect(unpackFrames(packFrames(frames), 4, [])).toEqual(frames);
  });

  it('still reads a row written as JSON', () => {
    expect(unpackFrames('[[1,null],[2,3]]', 2, [])).toEqual([
      [1, null],
      [2, 3],
    ]);
    expect(unpackFrames('[]', 2, [])).toEqual([]);
  });

  it('refuses text that ends inside a frame', () => {
    const text = packFrames([[1, 2]]);
    expect(() => unpackFrames(text, 3, [])).toThrow(RangeError);
  });
});
