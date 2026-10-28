// Auto-detect (M6 T4): two seconds of frames at medium, behind the title screen, pick the preset that
// `auto` resolves to. `src/game/auto-quality.ts` decides when it runs and stores the answer per GPU.

import type { PresetName } from '../presets';

export const BENCH = {
  /** Frames right after the start are left out: shaders compile and caches fill. */
  warmupMs: 500,
  durationMs: 2000,
  /** The 75th-percentile frame time up to which each preset is picked; slower is low. */
  highMs: 11,
  mediumMs: 20,
} as const;

/**
 * The nearest-rank `p` quantile of the first `count` values; NaN without any. `scratch` holds the
 * copy it reorders, so the caller's values stay as they are and a frame loop allocates nothing.
 */
export function percentile(
  values: ArrayLike<number>,
  p: number,
  count = values.length,
  scratch: Float64Array = new Float64Array(count),
): number {
  if (count <= 0) return Number.NaN;
  for (let i = 0; i < count; i++) scratch[i] = values[i] ?? 0;
  const k = Math.min(count - 1, Math.max(0, Math.ceil(p * count) - 1));
  return select(scratch, count, k);
}

/** Quickselect: the `k`th smallest of `a[0..n)`, reordering `a`. */
function select(a: Float64Array, n: number, k: number): number {
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const pivot = a[(lo + hi) >> 1] ?? 0;
    let i = lo;
    let j = hi;
    while (i <= j) {
      while ((a[i] ?? 0) < pivot) i++;
      while ((a[j] ?? 0) > pivot) j--;
      if (i <= j) {
        const t = a[i] ?? 0;
        a[i] = a[j] ?? 0;
        a[j] = t;
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else break;
  }
  return a[k] ?? 0;
}

/** The preset for a benchmark's frame times (at medium): by their 75th percentile. */
export function pickPreset(
  frameTimesMs: ArrayLike<number>,
  count = frameTimesMs.length,
): PresetName {
  const p75 = percentile(frameTimesMs, 0.75, count);
  if (Number.isNaN(p75)) return 'medium';
  if (p75 <= BENCH.highMs) return 'high';
  if (p75 <= BENCH.mediumMs) return 'medium';
  return 'low';
}

/** Up to 2 s of frames at 500 Hz. */
const CAPACITY = 1024;

/** Collects the frames of one benchmark run; `sample` answers once it has 2 s after the warm-up. */
export class Benchmark {
  private readonly times = new Float64Array(CAPACITY);
  private count = 0;
  private startedAt = 0;
  private active = false;

  get running(): boolean {
    return this.active;
  }

  start(now: number): void {
    this.active = true;
    this.startedAt = now;
    this.count = 0;
  }

  cancel(): void {
    this.active = false;
    this.count = 0;
  }

  /** One frame of `ms` that ended at `now`; the preset once the run is complete, else null. */
  sample(ms: number, now: number): PresetName | null {
    if (!this.active) return null;
    const since = now - this.startedAt;
    if (since <= BENCH.warmupMs) return null;
    if (this.count < CAPACITY) this.times[this.count++] = ms;
    if (since < BENCH.warmupMs + BENCH.durationMs) return null;
    this.active = false;
    return pickPreset(this.times, this.count);
  }
}
