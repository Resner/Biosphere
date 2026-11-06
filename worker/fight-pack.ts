// A fight's final frames packed for the `encounters` row (ADR 0056, M9 T10): each frame's inputs as
// 4-byte big-endian codes, `0xFFFFFFFF` for the fallback (the referee never takes it as a code), the
// whole log as one base64 text. A frame's width follows from the start's fighters and the joins
// (`Referee.width`), so the text holds no framing. A row written before packing holds JSON.

import type { EncJoin } from '../src/net/encounter-start';

export type Frames = (number | null)[][];

const FALLBACK = 0xffffffff;

/** The inputs of every frame, concatenated, as base64. */
export function packFrames(frames: Frames): string {
  const bytes = new Uint8Array(frames.reduce((n, f) => n + f.length, 0) * 4);
  const view = new DataView(bytes.buffer);
  let at = 0;
  for (const frame of frames) {
    for (const code of frame) {
      view.setUint32(at, code ?? FALLBACK);
      at += 4;
    }
  }
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(text);
}

/** Frame `f`'s width: the start's fighters plus the joins from frame `f` or earlier. */
const widthOf = (fighters: number, joins: readonly EncJoin[], f: number): number =>
  fighters + joins.reduce((n, j) => n + (j.f <= f ? 1 : 0), 0);

/**
 * The frames a row's text holds. `fighters` is the start's fighter count. Throws on text that is
 * neither JSON nor whole frames.
 */
export function unpackFrames(text: string, fighters: number, joins: readonly EncJoin[]): Frames {
  if (text.startsWith('[')) return JSON.parse(text) as Frames;
  const raw = atob(text);
  const view = new DataView(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) view.setUint8(i, raw.charCodeAt(i));
  const frames: Frames = [];
  let at = 0;
  while (at < view.byteLength) {
    const frame: (number | null)[] = [];
    for (let n = widthOf(fighters, joins, frames.length); n > 0; n--) {
      if (at + 4 > view.byteLength) throw new RangeError('a packed log ends inside a frame');
      const code = view.getUint32(at);
      frame.push(code === FALLBACK ? null : code);
      at += 4;
    }
    frames.push(frame);
  }
  return frames;
}
