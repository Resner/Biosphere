// The referee's frame clock (ADR 0050, M7 T9): which inputs count for which frame, and when a frame
// is final. Pure: the caller passes the time in, and steps the encounter with the bundles it gets.

import { RULES, TICK_HZ } from '../sim/rules';

const E = RULES.encounter;

/** One frame lasts 3 ticks: 100 ms. */
export const FRAME_MS = (E.frameTicks * 1000) / TICK_HZ;
/** An input is taken from this many frames before its own. */
const AHEAD_FRAMES = 2;
const U32_MAX = 0xffffffff;

export type InputVerdict = 'ok' | 'late' | 'early' | 'dup' | 'bad';

/** A finalized frame: one input code per slot, or null (the fallback marker) for a slot with none. */
export interface Bundle {
  f: number;
  i: (number | null)[];
}

export interface RefereeOptions {
  /** The hub time at which frame 0 starts. */
  startAt: number;
  /** The fighters, one input slot each. */
  slots: number;
  /** A referee restored from a saved log (M8 T5): the first frame the log doesn't hold. */
  next?: number;
  /** ... and the frame each joined slot takes inputs from, in join order. */
  joins?: readonly number[];
}

export class Referee {
  /** The next frame to finalize; every frame before it is final. */
  next = 0;
  private readonly startAt: number;
  private readonly slots: number;
  /** The frame from which each joined slot (`slots`, `slots + 1`, …) takes inputs (M7 T15). */
  private readonly joins: number[] = [];
  /** Inputs taken for frames not yet final, by frame. */
  private readonly pending = new Map<number, (number | null)[]>();
  /** Slots whose fighter is out: their input no longer holds a frame back. */
  private readonly retired = new Set<number>();

  /** Throws a `RangeError` for a restore whose frame or joins could not have come from a referee. */
  constructor({ startAt, slots, next = 0, joins = [] }: RefereeOptions) {
    this.startAt = startAt;
    this.slots = slots;
    if (!Number.isInteger(next) || next < 0) throw new RangeError(`a restore at frame ${next}`);
    this.next = next;
    for (const f of joins) {
      const last = this.joins[this.joins.length - 1] ?? 0;
      if (!Number.isInteger(f) || f < last) throw new RangeError(`a restored join at frame ${f}`);
      if (slots + this.joins.length >= E.maxFighters) throw new RangeError('the fight is full');
      this.joins.push(f);
    }
  }

  /** Slots that take inputs for frame `f`: the first fighters' and those joined by then. */
  width(f: number): number {
    let n = this.slots;
    for (const from of this.joins) if (from <= f) n++;
    return n;
  }

  /**
   * A fighter joins from frame `f` (not yet final, and no earlier than the last join): its slot is
   * the next one, returned. Frames before `f` keep their width. Throws a `RangeError` otherwise,
   * or past the encounter's fighter limit.
   */
  join(f: number): number {
    const last = this.joins[this.joins.length - 1] ?? 0;
    if (!Number.isInteger(f) || f < this.next || f < last) {
      throw new RangeError(`a join at frame ${f}, with frame ${this.next} next`);
    }
    const slot = this.slots + this.joins.length;
    if (slot >= E.maxFighters) throw new RangeError('the fight is full');
    this.joins.push(f);
    for (const [frame, inputs] of this.pending) {
      while (inputs.length < this.width(frame)) inputs.push(null);
    }
    return slot;
  }

  /** The hub time at which frame `f` starts. */
  start(f: number): number {
    return this.startAt + f * FRAME_MS;
  }

  /** The first hub time at which frame `f` no longer takes inputs (120 ms after it starts is still in time). */
  private close(f: number): number {
    return this.start(f) + E.inputDeadlineMs + 1;
  }

  /** Takes `slot`'s input `code` for frame `f`, arriving at hub time `now`. The first input for a frame wins. */
  input(slot: number, f: number, code: number, now: number): InputVerdict {
    if (
      !Number.isInteger(slot) ||
      slot < 0 ||
      !Number.isInteger(f) ||
      f < 0 ||
      slot >= this.width(f) ||
      !Number.isInteger(code) ||
      code < 0 ||
      code > U32_MAX ||
      !Number.isFinite(now)
    ) {
      return 'bad';
    }
    if (f < this.next || now >= this.close(f)) return 'late';
    if (now < this.start(f - AHEAD_FRAMES)) return 'early';
    let frame = this.pending.get(f);
    if (!frame) {
      frame = this.blank(f);
      this.pending.set(f, frame);
    }
    if (frame[slot] !== null) return 'dup';
    frame[slot] = code;
    return 'ok';
  }

  private blank(f: number): (number | null)[] {
    return new Array<number | null>(this.width(f)).fill(null);
  }

  /** Marks a slot's fighter out, so the frames it sends nothing for are finalized without waiting. */
  retire(slot: number): void {
    this.retired.add(slot);
  }

  /** Finalizes, in order, every frame past its deadline or with every living slot's input in. */
  due(now: number): Bundle[] {
    const out: Bundle[] = [];
    for (;;) {
      const f = this.next;
      const frame = this.pending.get(f);
      if (now < this.close(f) && !(frame && this.complete(frame))) return out;
      this.pending.delete(f);
      out.push({ f, i: frame ?? this.blank(f) });
      this.next++;
    }
  }

  /** When the next frame is due at the latest (its deadline); `due` finalizes it from then. */
  nextDeadline(): number {
    return this.close(this.next);
  }

  /** Frames holding inputs that are not yet final (at most the window's three). */
  held(): number {
    return this.pending.size;
  }

  private complete(frame: (number | null)[]): boolean {
    return frame.every((code, slot) => code !== null || this.retired.has(slot));
  }
}
