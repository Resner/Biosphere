import { describe, expect, it } from 'vitest';
import { RULES, TICK_HZ } from '../sim/rules';
import { FRAME_MS, Referee } from './referee';

// M7 T9: the referee's frame clock. Frame f starts at `startAt + f × 100 ms`; an input for it is
// taken from 2 frames ahead until 120 ms after it starts, the first one wins, and a slot with none
// gets the fallback marker null.

const E = RULES.encounter;
const T = 1_000_000;
const start = (f: number) => T + f * FRAME_MS;

describe('Referee', () => {
  it('runs at the encounter’s frame rate', () => {
    expect(FRAME_MS).toBe((E.frameTicks * 1000) / TICK_HZ);
    expect(new Referee({ startAt: T, slots: 2 }).start(3)).toBe(T + 3 * FRAME_MS);
  });

  it('takes inputs inside the window, and names the late, early, repeated and malformed', () => {
    const r = new Referee({ startAt: T, slots: 2 });
    // Two frames ahead is inside the window, three is early.
    expect(r.input(0, 2, 7, start(0))).toBe('ok');
    expect(r.input(0, 3, 7, start(0))).toBe('early');
    expect(r.input(0, 3, 7, start(1))).toBe('ok');
    // The deadline: 120 ms after the frame starts is still in time, 121 ms is late.
    expect(r.input(0, 0, 1, start(0) + E.inputDeadlineMs)).toBe('ok');
    expect(r.input(1, 0, 1, start(0) + E.inputDeadlineMs + 1)).toBe('late');
    // The first input wins.
    expect(r.input(0, 0, 9, start(0))).toBe('dup');
    for (const [slot, f, code] of [
      [2, 0, 1],
      [-1, 0, 1],
      [0.5, 0, 1],
      [0, -1, 1],
      [0, 1.5, 1],
      [0, Number.NaN, 1],
      [0, 0, -1],
      [0, 0, 2 ** 32],
      [0, 0, 1.5],
    ] as const) {
      expect(r.input(slot, f, code, start(0))).toBe('bad');
    }
    expect(r.input(0, 0, 1, Number.NaN)).toBe('bad');
  });

  it('finalizes a frame at its deadline, with null for a slot that sent nothing', () => {
    const r = new Referee({ startAt: T, slots: 2 });
    expect(r.input(0, 0, 11, start(0) - 50)).toBe('ok');
    expect(r.nextDeadline()).toBe(start(0) + E.inputDeadlineMs + 1);
    expect(r.due(start(0) + E.inputDeadlineMs)).toEqual([]);
    expect(r.due(r.nextDeadline())).toEqual([{ f: 0, i: [11, null] }]);
    expect(r.nextDeadline()).toBe(start(1) + E.inputDeadlineMs + 1);
    // A finalized frame takes no more inputs.
    expect(r.input(1, 0, 3, start(0) + 10)).toBe('late');
  });

  it('finalizes every due frame in order when the timer fires late', () => {
    const r = new Referee({ startAt: T, slots: 2 });
    r.input(0, 0, 1, start(0));
    r.input(1, 1, 2, start(0));
    r.input(0, 2, 3, start(1));
    // The timer for frame 0 fires at 350 ms into the fight, frames 0 to 2 past their deadlines.
    const bundles = r.due(start(0) + 350);
    expect(bundles).toEqual([
      { f: 0, i: [1, null] },
      { f: 1, i: [null, 2] },
      { f: 2, i: [3, null] },
    ]);
    expect(r.next).toBe(3);
    expect(r.due(start(0) + 350)).toEqual([]);
  });

  it('finalizes a frame early once every living participant’s input is in', () => {
    const r = new Referee({ startAt: T, slots: 3 });
    r.input(0, 0, 5, start(0) + 10);
    r.input(1, 0, 6, start(0) + 10);
    expect(r.due(start(0) + 10)).toEqual([]);
    r.input(2, 0, 7, start(0) + 20);
    expect(r.due(start(0) + 20)).toEqual([{ f: 0, i: [5, 6, 7] }]);
    // A slot that is out no longer holds a frame back.
    r.retire(2);
    r.input(0, 1, 8, start(1));
    r.input(1, 1, 9, start(1));
    expect(r.due(start(1))).toEqual([{ f: 1, i: [8, 9, null] }]);
    // Early finalization stays in order: frame 3 waits for frame 2.
    r.input(0, 3, 1, start(2));
    r.input(1, 3, 1, start(2));
    expect(r.due(start(2))).toEqual([]);
    r.input(0, 2, 2, start(2));
    r.input(1, 2, 2, start(2));
    expect(r.due(start(2)).map((b) => b.f)).toEqual([2, 3]);
  });

  it('keeps the window bounded: inputs and finalized frames never pile up', () => {
    const r = new Referee({ startAt: T, slots: 2 });
    for (let f = 0; f < 50; f++) {
      // Slot 0 sends ahead as far as it may (and one further); slot 1 is silent.
      for (let ahead = 0; ahead < 4; ahead++) r.input(0, f + ahead, ahead, start(f));
      expect(r.due(start(f) + E.inputDeadlineMs + 1)).toHaveLength(1);
      expect(r.held()).toBeLessThanOrEqual(2);
    }
  });

  describe('join (M7 T15)', () => {
    it('adds a slot from its frame on: earlier bundles keep their width, later ones carry it', () => {
      const r = new Referee({ startAt: T, slots: 2 });
      expect(r.join(2)).toBe(2);
      // Before its frame the new slot sends nothing that counts.
      expect(r.input(2, 1, 5, start(0))).toBe('bad');
      expect(r.input(2, 2, 5, start(0))).toBe('ok');
      const bundles = r.due(start(3) + E.inputDeadlineMs + 1);
      expect(bundles.map((b) => b.i.length)).toEqual([2, 2, 3, 3]);
      expect(bundles[2]?.i).toEqual([null, null, 5]);
    });

    it('widens a frame already holding inputs, and waits for the joiner before finalizing early', () => {
      const r = new Referee({ startAt: T, slots: 2 });
      r.input(0, 1, 1, start(0));
      r.join(1);
      r.input(1, 1, 2, start(0));
      expect(r.due(start(0) + E.inputDeadlineMs + 1).map((b) => b.f)).toEqual([0]);
      r.input(2, 1, 3, start(1));
      expect(r.due(start(1))).toEqual([{ f: 1, i: [1, 2, 3] }]);
    });

    it('refuses a join before the next frame, or past the fourth slot', () => {
      const r = new Referee({ startAt: T, slots: 2 });
      r.due(start(2) + E.inputDeadlineMs + 1);
      expect(r.next).toBe(3);
      expect(() => r.join(2)).toThrow(RangeError);
      r.join(3);
      r.join(4);
      expect(() => r.join(5)).toThrow(RangeError);
    });
  });
});
