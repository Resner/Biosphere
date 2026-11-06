// Witness duty in the page (M10, ADR 0058). `Availability` decides the `avail` the hub hears: the
// page can witness only while the tab is visible, Settings' "Help referee fights" is on, the
// player is neither locked nor fighting, and its frame times' 90th percentile over the last 5 s
// is at most 50 ms. Off goes out at once; on only once all of that has held for 5 s and 5 s after
// the last message, so a flapping tab sends at most one message per 5 s and the hub (which counts
// an `on` at most once per 5 s) never drops one. `DutyWiring` also dispatches the hub's duties: an
// auditor duty to `app-audit.ts` (M10 T8), which loads with the first one.

import type { Beacon } from '../ledger/drand';
import type { PubKey } from '../ledger/record';
import type { AuditVerdict } from '../net/audit';
import { type DutyMsg, fetchJson, hubHttpUrl } from '../net/hub-client';
import type { AuditCase } from '../net/protocol';
import { percentile } from '../render/post/benchmark';
import type { App } from './app';
import type { AuditDuties, AuditRunner } from './app-audit';
import { cachedKeys } from './fight-verify';

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
  /** Whether the hub was last told on. */
  on = false;
  private toldAt = Number.NEGATIVE_INFINITY;
  private scratch = new Float64Array(0);

  constructor(private readonly send: (on: boolean) => void) {}

  /** A frame took `ms`, ending at `now`. */
  frame(now: number, ms: number): void {
    this.frames.push([now, ms]);
    this.prune(now);
  }

  /** The 90th percentile of the window's frame times, or null without any. */
  p90(now: number): number | null {
    this.prune(now);
    const n = this.frames.length;
    if (n === 0) return null;
    if (this.scratch.length < n) this.scratch = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) this.scratch[i] = this.frames[i]?.[1] ?? 0;
    return percentile(this.scratch, 0.9, n, this.scratch);
  }

  /** Judges the inputs now: off at once when one fails, on once all have held long enough. */
  update(now: number, inputs: AvailInputs): void {
    // The cheap inputs first: the percentile is only worked out for a page that could witness.
    let good = inputs.visible && inputs.setting && !inputs.busy;
    if (good) {
      const p90 = this.p90(now);
      good = p90 !== null && p90 <= AVAIL_P90_MS;
    }
    if (!good) {
      this.goodSince = null;
      if (this.on) this.tell(now, false);
      return;
    }
    this.goodSince ??= now;
    if (
      !this.on &&
      now - this.goodSince >= AVAIL_WINDOW_MS &&
      now - this.toldAt >= AVAIL_EVERY_MS
    ) {
      this.tell(now, true);
    }
  }

  /** A new hub session knows nothing of this page: the next update tells it again. */
  reset(): void {
    this.on = false;
    this.toldAt = Number.NEGATIVE_INFINITY;
  }

  private tell(now: number, on: boolean): void {
    this.on = on;
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

/**
 * The page's side of witness duty: its `avail`, judged each frame and on the page's own events, and
 * the duties the hub offers it.
 */
export class DutyWiring {
  readonly avail: Availability;
  /** The auditor duty's runner, once the first offer has loaded it. */
  audits: AuditDuties | null = null;
  private loading: Promise<{ audits: AuditDuties; runner: AuditRunner }> | null = null;

  constructor(private readonly app: App) {
    this.avail = new Availability((on) => app.keeper.current?.send({ t: 'avail', on }));
  }

  /** The auditor runner and its module worker, loaded once. */
  private auditor(): Promise<{ audits: AuditDuties; runner: AuditRunner }> {
    const { app } = this;
    this.loading ??= import('./app-audit').then((m) => {
      const { hubUrl } = app;
      const keys = hubUrl ? cachedKeys(() => fetchJson(hubHttpUrl(hubUrl, '/v1/pubkeys'))) : null;
      const runner = m.workerRunner(
        () => new Worker(new URL('./audit-worker.ts', import.meta.url), { type: 'module' }),
      );
      this.audits = new m.AuditDuties({
        identity: () => app.identity,
        keys: () => keys?.() ?? Promise.resolve(null),
        sendHub: (msg) => app.keeper.current?.send(msg),
        runner,
        perfNow: () => performance.now(),
      });
      return { audits: this.audits, runner };
    });
    return this.loading;
  }

  /** A duty message from the hub (the session has opened or closed its links already). */
  receive(msg: DutyMsg): void {
    if (msg.t === 'duty') {
      const decline = () => this.app.keeper.current?.send({ t: 'duty-no', event: msg.event });
      if (msg.role === 'auditor') {
        this.auditor().then(
          ({ audits }) => audits.offer(msg),
          () => {
            // The runner could not load (a chunk lost offline): the duty goes to the next place.
            this.loading = null;
            decline();
          },
        );
      }
      // The referee duty comes with T7: until then it is declined.
      else decline();
    } else if (msg.t === 'duty-end') {
      this.audits?.end(msg);
    }
  }

  /** `debug.audit`: a verdict worked out in the audit worker, as an auditor duty would, and its time. */
  async audit(
    audit: AuditCase,
    beacon: Beacon,
    keys: PubKey[],
  ): Promise<{ verdict: AuditVerdict; ms: number }> {
    const { runner } = await this.auditor();
    const t0 = performance.now();
    const { verdict } = await runner.run({ t: 'verdict', audit, beacon, keys });
    return { verdict, ms: performance.now() - t0 };
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

  /** Every welcome is a new hub session, which has heard nothing yet and holds no duty of this page's. */
  welcome(): void {
    this.avail.reset();
    this.audits?.reset();
  }
}
