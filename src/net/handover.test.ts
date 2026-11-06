import { describe, expect, it } from 'vitest';
import {
  AUTHORITY,
  BATCH_FRAMES,
  BATCH_GRACE_MS,
  HANDOVER_AHEAD,
  handoverFrame,
  plannedTakeBackFrame,
  RefereeSpans,
  TAKEBACK_AHEAD,
  takeBackFrame,
} from './handover';

const W = 'w'.repeat(43);

describe('referee spans (M10 T3)', () => {
  it('names the referee of every frame across a handover and a take-back', () => {
    const spans = new RefereeSpans();
    expect(spans.list()).toEqual([{ by: AUTHORITY, from: 0 }]);
    spans.hand(W, 33, 0);
    spans.hand(AUTHORITY, 120);
    const at = (f: number) => spans.refereeOf(f);
    expect([at(0), at(32), at(33), at(119), at(120), at(400)]).toEqual([
      AUTHORITY,
      AUTHORITY,
      W,
      W,
      AUTHORITY,
      AUTHORITY,
    ]);
    expect(spans.list()).toEqual([
      { by: AUTHORITY, from: 0 },
      { by: W, from: 33, position: 0 },
      { by: AUTHORITY, from: 120 },
    ]);
    expect(spans.spanOf(50)).toEqual({ by: W, from: 33, position: 0 });
  });

  it('refuses a hand at or before the last span’s start', () => {
    const spans = new RefereeSpans();
    expect(() => spans.hand(W, 0)).toThrow(RangeError);
    spans.hand(W, 33);
    expect(() => spans.hand(AUTHORITY, 33)).toThrow(RangeError);
    expect(() => spans.hand(AUTHORITY, 20)).toThrow(RangeError);
    expect(() => spans.hand(AUTHORITY, 33.5)).toThrow(RangeError);
    expect(() => spans.hand('', 40)).toThrow(RangeError);
    expect(spans.list()).toHaveLength(2);
  });

  it('restores spans from a list, and refuses one not from the authority at 0', () => {
    const list = [
      { by: AUTHORITY, from: 0 },
      { by: W, from: 40, position: 2 },
    ];
    expect(new RefereeSpans(list).list()).toEqual(list);
    expect(() => new RefereeSpans([])).toThrow(RangeError);
    expect(() => new RefereeSpans([{ by: W, from: 0 }])).toThrow(RangeError);
    expect(() => new RefereeSpans([{ by: AUTHORITY, from: 3 }])).toThrow(RangeError);
    expect(() => new RefereeSpans([...list, { by: AUTHORITY, from: 40 }])).toThrow(RangeError);
  });

  it('places handovers and take-backs as ADR 0058 says', () => {
    expect([HANDOVER_AHEAD, TAKEBACK_AHEAD, BATCH_FRAMES, BATCH_GRACE_MS]).toEqual([
      3, 2, 10, 1000,
    ]);
    expect(handoverFrame(30)).toBe(33);
    expect(plannedTakeBackFrame(117)).toBe(120);
    expect(takeBackFrame(50, 48)).toBe(52);
    expect(takeBackFrame(50, 55)).toBe(57);
  });
});
