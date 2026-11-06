// Referee spans and handover frames (ADR 0058, M10 T3). A fight is refereed by the authority from
// frame 0; a witness may take over from a later frame and hand it back. Who refereed which frames
// is a list of spans, each from its first frame to the next span's. Pure and shared by the
// authority, the witness and the fighters.

/** From frame `from` until the next span's, `by` referees: `'authority'` or the witness's player id, with its place in the order. */
export interface RefereeSpan {
  by: string;
  from: number;
  position?: number;
}

/** The authority's name in a span. */
export const AUTHORITY = 'authority';

/** A handover to a witness, and a planned take-back, start this many frames past the frame named. */
export const HANDOVER_AHEAD = 3;
/** A take-back after a failure starts this many frames past the later of the next frame and the one due now. */
export const TAKEBACK_AHEAD = 2;
/** A witness sends the authority a batch every this many frames. */
export const BATCH_FRAMES = 10;
/**
 * How many frames past the frame due on the hub's clock a batch may reach: a witness finalizes a
 * frame about when it falls due, so a batch further ahead lets it run the fight on autopilot
 * faster than real time. Such a batch is `witness-forged`.
 */
export const BATCH_LEAD_MAX = 10;
/** How long past the next batch's last frame the authority waits for it. */
export const BATCH_GRACE_MS = 1000;

/** The first frame a witness referees when the authority's referee has `next` next: `h = next + 3`. */
export const handoverFrame = (next: number): number => next + HANDOVER_AHEAD;
/** The first frame of a planned take-back (a join, everyone away, the witness's own lock), with frame `due` due now. */
export const plannedTakeBackFrame = (due: number): number => due + HANDOVER_AHEAD;
/** The first frame of a take-back after a failure: `h' = max(next, due) + 2`. */
export const takeBackFrame = (next: number, due: number): number =>
  Math.max(next, due) + TAKEBACK_AHEAD;

const frameOk = (f: number): boolean => Number.isInteger(f) && f >= 0;

export class RefereeSpans {
  private readonly spans: RefereeSpan[] = [];

  /** Throws a `RangeError` unless the spans start with the authority at frame 0 and strictly increase. */
  constructor(spans: readonly RefereeSpan[] = [{ by: AUTHORITY, from: 0 }]) {
    const [first, ...rest] = spans;
    if (!first || first.by !== AUTHORITY || first.from !== 0) {
      throw new RangeError('spans start with the authority at frame 0');
    }
    this.spans.push({ ...first });
    for (const s of rest) this.hand(s.by, s.from, s.position);
  }

  /** Who referees frame `f`. */
  refereeOf(f: number): string {
    return this.spanOf(f).by;
  }

  /** The span frame `f` falls in. */
  spanOf(f: number): RefereeSpan {
    let span = this.spans[0] as RefereeSpan;
    for (const s of this.spans) {
      if (s.from > f) break;
      span = s;
    }
    return span;
  }

  /** The current (last) span. */
  last(): RefereeSpan {
    return this.spans[this.spans.length - 1] as RefereeSpan;
  }

  /** `by` referees from frame `from`. Throws a `RangeError` unless `from` is past the last span's start. */
  hand(by: string, from: number, position?: number): void {
    if (!frameOk(from) || from <= this.last().from) {
      throw new RangeError(`a handover at frame ${from}, after one at ${this.last().from}`);
    }
    if (typeof by !== 'string' || by === '') throw new RangeError('a handover to no one');
    this.spans.push(position === undefined ? { by, from } : { by, from, position });
  }

  list(): RefereeSpan[] {
    return this.spans.map((s) => ({ ...s }));
  }
}
