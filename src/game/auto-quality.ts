// Auto-detect and adaptive resolution (M6 T4). The benchmark runs behind the title screen, at
// medium, while `auto` waits for a result on this GPU; its answer is stored per GPU, so another
// machine benchmarks again. Outside the benchmark the render scale follows the frame times.
//
// Tests, `?quality=` and the gallery must stay stable: without `measure` there is no benchmark (a
// stored result still counts) and the scale stays at 1, until `setBench` forces a frame time.

import { AdaptiveScale } from '../render/post/adaptive';
import { Benchmark, pickPreset } from '../render/post/benchmark';
import type { PresetName } from '../render/presets';
import type { Store } from './online-config';
import { loadBench, saveBench } from './settings';

/**
 * `pending`: no result yet, the next title screen with `auto` runs it; `running`; `measured` this
 * visit; `stored` from an earlier visit on this GPU; `skipped`: not measured here (`auto` is medium).
 */
export type BenchStatus = 'pending' | 'running' | 'measured' | 'stored' | 'skipped';

export interface AutoQualityOptions {
  store: Store | null;
  /** The GPU's name, unmasked where the browser tells it. */
  gpu: string;
  /** False under test automation and with `?quality=`. */
  measure: boolean;
  /** A benchmark picked a preset (the app re-resolves `auto`). */
  onDetect(preset: PresetName): void;
  /** The render scale changed. */
  onScale(scale: number): void;
}

/** A frame this long is a pause (a hidden tab, a blocked thread), not a measurement. */
const PAUSE_MS = 1000;

export class AutoQuality {
  detected: PresetName;
  status: BenchStatus;
  private readonly bench = new Benchmark();
  private readonly adaptive = new AdaptiveScale();
  private forcedMs: number | null = null;
  private preset: PresetName | null = null;

  constructor(private readonly options: AutoQualityOptions) {
    const stored = loadBench(options.store, options.gpu);
    this.detected = stored ?? 'medium';
    this.status = stored ? 'stored' : options.measure ? 'pending' : 'skipped';
  }

  get scale(): number {
    return this.adaptive.scale;
  }

  /**
   * One display frame of `ms` that ended at `now`, with what the app shows: the title screen or
   * not, whether the setting is `auto`, and the preset drawn.
   */
  frame(ms: number, now: number, title: boolean, auto: boolean, preset: PresetName): void {
    if (ms > PAUSE_MS) {
      this.resume(now);
      return;
    }
    if (preset !== this.preset) {
      // A new preset is a new load: start the scale over.
      this.preset = preset;
      this.setScale(now, 1);
    }
    const frameMs = this.forcedMs ?? ms;
    if (this.status === 'pending' && title && auto) {
      this.status = 'running';
      this.bench.start(now);
      this.setScale(now, 1);
    }
    if (this.status === 'running') {
      if (!title || !auto) {
        this.abort();
      } else {
        const picked = this.bench.sample(frameMs, now);
        if (picked) this.detect(picked);
        return;
      }
    }
    if (!this.options.measure && this.forcedMs === null) return;
    const before = this.adaptive.scale;
    if (this.adaptive.sample(frameMs, now) !== before) this.options.onScale(this.adaptive.scale);
  }

  /** After a pause: an interrupted benchmark starts over and the frame window empties. */
  resume(now: number): void {
    if (this.status === 'running') this.abort();
    this.adaptive.reset(now);
  }

  /** `debug.setBench`: frames take `ms` from now on, and the benchmark re-runs on them at once. */
  setBench(ms: number, now: number): void {
    this.forcedMs = ms;
    this.bench.cancel();
    this.adaptive.reset(now);
    this.detect(pickPreset([ms]));
  }

  private abort(): void {
    this.bench.cancel();
    this.status = 'pending';
  }

  private detect(preset: PresetName): void {
    this.detected = preset;
    this.status = 'measured';
    saveBench(this.options.store, this.options.gpu, preset);
    this.options.onDetect(preset);
  }

  private setScale(now: number, scale: number): void {
    const before = this.adaptive.scale;
    this.adaptive.reset(now, scale);
    if (this.adaptive.scale !== before) this.options.onScale(this.adaptive.scale);
  }
}
