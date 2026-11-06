// Witness duty in the page (M10, ADR 0058). `Availability` decides the `avail` the hub hears: the
// page can witness only while the tab is visible, Settings' "Help referee fights" is on, the
// player is neither locked nor fighting, and its frame times' 90th percentile over the last 5 s
// is at most 50 ms. Off goes out at once; on only once all of that has held for 5 s and 5 s after
// the last message, so a flapping tab sends at most one message per 5 s and the hub (which counts
// an `on` at most once per 5 s) never drops one.

import type { App } from './app';

/** The frame times judged, and how long everything must hold before an `on`. */
export const AVAIL_WINDOW_MS = 5000;
/** The most an `on` waits after the last message. */
export const AVAIL_EVERY_MS = 5000;
/** The slowest 90th-percentile frame time that still witnesses. */
export const AVAIL_P90_MS = 50;

export interface AvailInputs {
  /** The tab is visible. */
  visible: boolean;
  /** Settings' "Help referee fights". */
  setting: boolean;
  /** Locked in a fight or fighting. */
  busy: boolean;
}

export class Availability {
  /** Frame times in the window, as `[at, ms]`, oldest first. */
  private readonly frames: [number, number][] = [];
  /** Since when everything has been right, or null. */
  private goodSince: number | null = null;
  /** What the hub was last told; null when this session told it nothing yet. */
  private told: boolean | null = null;
  private toldAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly send: (on: boolean) => void) {}

  /** Whether the hub was last told on. */
  get on(): boolean {
    return this.told === true;
  }

  /** A frame took `ms`, ending at `now`. */
  frame(now: number, ms: number): void {
    this.frames.push([now, ms]);
    this.prune(now);
  }

  /** The 90th percentile of the window's frame times, or null without any. */
  p90(now: number): number | null {
    this.prune(now);
    if (this.frames.length === 0) return null;
    const sorted = this.frames.map(([, ms]) => ms).sort((a, b) => a - b);
    return sorted[Math.ceil(0.9 * sorted.length) - 1] ?? null;
  }

  /** Judges the inputs now: off at once when one fails, on once all have held long enough. */
  update(now: number, inputs: AvailInputs): void {
    const p90 = this.p90(now);
    const good =
      inputs.visible && inputs.setting && !inputs.busy && p90 !== null && p90 <= AVAIL_P90_MS;
    if (!good) {
      this.goodSince = null;
      if (this.told === true) this.tell(now, false);
      return;
    }
    this.goodSince ??= now;
    if (
      this.told !== true &&
      now - this.goodSince >= AVAIL_WINDOW_MS &&
      now - this.toldAt >= AVAIL_EVERY_MS
    ) {
      this.tell(now, true);
    }
  }

  /** A new hub session knows nothing of this page: the next update tells it again. */
  reset(): void {
    this.told = null;
    this.toldAt = Number.NEGATIVE_INFINITY;
  }

  private tell(now: number, on: boolean): void {
    this.told = on;
    this.toldAt = now;
    this.send(on);
  }

  private prune(now: number): void {
    const from = now - AVAIL_WINDOW_MS;
    let drop = 0;
    while (drop < this.frames.length && (this.frames[drop]?.[0] ?? 0) <= from) drop++;
    if (drop > 0) this.frames.splice(0, drop);
  }
}

/** The page's side of witness duty: its `avail`, judged each frame and on the page's own events. */
export class DutyWiring {
  readonly avail: Availability;

  constructor(private readonly app: App) {
    this.avail = new Availability((on) => app.keeper.current?.send({ t: 'avail', on }));
  }

  /** A frame took `ms`. */
  frame(now: number, ms: number): void {
    this.avail.frame(now, ms);
    this.update(now);
  }

  /** Judges availability now: each frame, and at once when visibility or the settings change. */
  update(now = performance.now()): void {
    const { app } = this;
    this.avail.update(now, {
      visible: !document.hidden,
      setting: app.settings.helpReferee,
      busy: app.fight.fighting || app.attack.waiting,
    });
  }

  /** Every welcome is a new hub session, which has heard nothing yet. */
  welcome(): void {
    this.avail.reset();
  }
}
