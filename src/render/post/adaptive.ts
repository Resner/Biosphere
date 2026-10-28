// Adaptive resolution (M6 T4): the render scale steps down when frames run over budget and back up
// once they have had room to spare for a while. Hysteresis between the two thresholds, a fresh
// 2 s window after every step and the 5 s wait to step up keep it from oscillating. The scale only
// shrinks what the scene draws into; the HUD and the rest of the DOM are never scaled.

import { percentile } from './benchmark';

export const ADAPTIVE = {
  min: 0.6,
  max: 1,
  step: 0.1,
  /** The 90th-percentile frame time is taken over this much of the latest frames. */
  windowMs: 2000,
  /** A 60 Hz frame. */
  budgetMs: 16.7,
  /** Over this share of the budget steps down. */
  down: 1.25,
  /** Below this share of the budget, for `upAfterMs`, steps up. */
  up: 0.8,
  upAfterMs: 5000,
} as const;

const DOWN_MS = ADAPTIVE.down * ADAPTIVE.budgetMs;
const UP_MS = ADAPTIVE.up * ADAPTIVE.budgetMs;
/** Steps below full resolution: 0 is 1.0, 4 is 0.6. */
const MAX_LEVEL = Math.round((ADAPTIVE.max - ADAPTIVE.min) / ADAPTIVE.step);
/** Room for 2 s of frames at 500 Hz; older ones are dropped first. */
const CAPACITY = 1024;

export class AdaptiveScale {
  private level = 0;
  private readonly times = new Float64Array(CAPACITY);
  private readonly frames = new Float64Array(CAPACITY);
  private readonly scratch = new Float64Array(CAPACITY);
  private head = 0;
  private count = 0;
  /** When the window started filling: judged only once it spans 2 s. */
  private since = 0;
  /** Since when the window has been fast without a break; null while it is not. */
  private fastSince: number | null = null;

  get scale(): number {
    return levelScale(this.level);
  }

  /** Empties the window, so the next step needs 2 s of new frames; optionally sets the scale. */
  reset(now: number, scale?: number): void {
    if (scale !== undefined) {
      const level = Math.round((ADAPTIVE.max - scale) / ADAPTIVE.step);
      this.level = Math.min(MAX_LEVEL, Math.max(0, level));
    }
    this.head = 0;
    this.count = 0;
    this.since = now;
    this.fastSince = null;
  }

  /** One frame of `ms` that ended at `now`; returns the render scale to use. */
  sample(ms: number, now: number): number {
    this.push(ms, now);
    if (now - this.since < ADAPTIVE.windowMs) return this.scale;
    const p90 = this.p90();
    if (p90 > DOWN_MS) {
      if (this.level < MAX_LEVEL) this.step(1, now);
      else this.fastSince = null;
    } else if (p90 < UP_MS) {
      this.fastSince ??= now;
      if (this.level > 0 && now - this.fastSince >= ADAPTIVE.upAfterMs) this.step(-1, now);
    } else {
      this.fastSince = null;
    }
    return this.scale;
  }

  private step(by: 1 | -1, now: number): void {
    this.level += by;
    this.reset(now);
  }

  /** Adds a frame and drops those older than the window. */
  private push(ms: number, now: number): void {
    if (this.count === CAPACITY) {
      this.head = (this.head + 1) % CAPACITY;
      this.count--;
    }
    const at = (this.head + this.count) % CAPACITY;
    this.times[at] = now;
    this.frames[at] = ms;
    this.count++;
    const cutoff = now - ADAPTIVE.windowMs;
    while (this.count > 1 && (this.times[this.head] ?? 0) <= cutoff) {
      this.head = (this.head + 1) % CAPACITY;
      this.count--;
    }
  }

  private p90(): number {
    const { count, head, frames, scratch } = this;
    for (let i = 0; i < count; i++) scratch[i] = frames[(head + i) % CAPACITY] ?? 0;
    return percentile(scratch, 0.9, count, scratch);
  }
}

const levelScale = (level: number): number =>
  Math.round((ADAPTIVE.max - level * ADAPTIVE.step) * 10) / 10;
