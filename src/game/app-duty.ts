// Witness duty in the page (M10, ADR 0058). `DutyWiring` dispatches the hub's duties: a referee
// duty to `app-witness.ts` and an auditor duty to `app-audit.ts` (T8). `DutyProbes`
// measures the round trip on each duty link, for a fighter's lead. `Availability` decides the `avail` the hub hears: the
// page can witness only while the tab is visible, Settings' "Help referee fights" is on, the
// player is neither locked nor fighting, and its frame times' 90th percentile over the last 5 s
// is at most 50 ms. Off goes out at once; on only once all of that has held for 5 s and 6 s after
// the last message, so a flapping tab sends at most one message per 5 s and the hub (which counts
// an `on` at most once per 5 s from when it heard the last) never drops one it hears up to 1 s
// later than the message before: a dropped `on` would leave the page out of every pool while it
// shows itself available. `DutyWiring` also dispatches the hub's duties: an
// auditor duty to `app-audit.ts` (M10 T8), which loads with the first one.

import type { Beacon } from '../ledger/drand';
import type { PubKey } from '../ledger/record';
import type { AuditVerdict } from '../net/audit';
import type { DutyMsg } from '../net/hub-client';
import type { AuditCase, PeerEvent } from '../net/protocol';
import type { FighterInput } from '../net/witness-referee';
import { percentile } from '../render/post/benchmark';
import type { App } from './app';
import type { AuditDuties, AuditRunner } from './app-audit';
import type { EncFrameMsg, EncRefereeMsg, WitnessDuties, WitnessHost } from './app-witness';

/** The frame times judged, and how long everything must hold before an `on`. */
export const AVAIL_WINDOW_MS = 5000;
/** The hub counts an `on` at most this often, from when it heard the last message. */
export const AVAIL_EVERY_MS = 5000;
/** How much later the hub may hear a message than the page sent it: an `on` waits this long more. */
export const AVAIL_LATE_MS = 1000;
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
      now - this.toldAt >= AVAIL_EVERY_MS + AVAIL_LATE_MS
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

/** A probe goes out on each duty link this often. */
export const PROBE_EVERY_MS = 1000;
/** An unanswered probe is forgotten after this long. */
const PROBE_KEEP_MS = 5000;
/** Each new round trip moves the estimate this far. */
const RTT_WEIGHT = 0.25;

type Probe = Extract<PeerEvent, { t: 'probe' }>;

/** Round trips on the duty links (ADR 0058): a probe every second, answered at once. */
export class DutyProbes {
  private n = 0;
  private last = Number.NEGATIVE_INFINITY;
  private readonly out = new Map<number, { peer: string; at: number }>();
  private readonly rtt = new Map<string, number>();

  constructor(private readonly send: (peer: string, ev: Probe) => void) {}

  /** Each frame: a probe to every open duty link once a second. */
  tick(now: number, peers: () => readonly string[]): void {
    if (now - this.last < PROBE_EVERY_MS) return;
    this.last = now;
    for (const [n, o] of this.out) if (now - o.at > PROBE_KEEP_MS) this.out.delete(n);
    for (const peer of peers()) {
      this.n = (this.n + 1) % 1_000_000;
      this.out.set(this.n, { peer, at: now });
      this.send(peer, { t: 'probe', n: this.n, back: false });
    }
  }

  /** A peer's probe is answered; an answer to one of ours is a round trip. */
  receive(from: string, ev: Probe, now: number): void {
    if (!ev.back) {
      this.send(from, { t: 'probe', n: ev.n, back: true });
      return;
    }
    const sent = this.out.get(ev.n);
    if (!sent || sent.peer !== from) return;
    this.out.delete(ev.n);
    const sample = now - sent.at;
    const prev = this.rtt.get(from);
    this.rtt.set(from, prev === undefined ? sample : prev + (sample - prev) * RTT_WEIGHT);
  }

  /** Half the round trip to `peer`, or null before one came back. */
  oneWayMs(peer: string): number | null {
    const rtt = this.rtt.get(peer);
    return rtt === undefined ? null : rtt / 2;
  }
}

/**
 * The page's side of witness duty: its `avail`, the duties offered to it and its duty links'
 * probes. The referee duty's runner checks signatures, so it loads (with `@noble/curves`) at the
 * first offer, never with the app shell.
 */
export class DutyWiring {
  readonly avail: Availability;
  readonly probes: DutyProbes;
  /** The referee duty's runner, once the first offer has loaded it. */
  witness: WitnessDuties | null = null;
  private loading: Promise<WitnessDuties> | null = null;
  /** The auditor duty's runner (M10 T8), once the first offer has loaded it. */
  audits: AuditDuties | null = null;
  /** `debug.dutyFrameMs`: the frame time availability judges in place of the measured one, or null. */
  frameMs: number | null = null;
  private auditLoading: Promise<{ audits: AuditDuties; runner: AuditRunner }> | null = null;
  private readonly host: WitnessHost;

  constructor(private readonly app: App) {
    this.avail = new Availability((on) => app.keeper.current?.send({ t: 'avail', on }));
    const link = () => app.keeper.current;
    this.probes = new DutyProbes((peer, ev) => link()?.sendEvent(peer, ev));
    this.host = {
      identity: () => app.identity,
      hubNow: () => link()?.clock.hubNow(performance.now()) ?? performance.now(),
      perfNow: () => performance.now(),
      sendHub: (msg) => link()?.send(msg),
      sendPeer: (peer, ev) => link()?.sendEvent(peer, ev),
      dutyPeer: (enc, peer, on) => link()?.dutyPeer(enc, peer, on),
      linkOpen: (peer) =>
        link()
          ?.dutyLinks()
          .some((l) => l.peer === peer && l.open) === true,
      busy: () => app.fight.fighting || app.attack.waiting,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    };
  }

  /** The runner, loaded once. */
  private runner(): Promise<WitnessDuties> {
    this.loading ??= import('./app-witness').then((m) => {
      this.witness = new m.WitnessDuties(this.host);
      return this.witness;
    });
    return this.loading;
  }

  /** A duty message from the hub (the session has opened or closed its links already). */
  receive(msg: DutyMsg): void {
    if (msg.t === 'duty') {
      const decline = () => this.app.keeper.current?.send({ t: 'duty-no', event: msg.event });
      if (msg.role === 'referee') {
        this.runner().then(
          (w) => w.offer(msg),
          () => {
            // The runner could not load (a chunk lost offline): the duty goes to the next place.
            this.loading = null;
            decline();
          },
        );
      } else {
        this.auditor().then(
          ({ audits }) => audits.offer(msg),
          () => {
            this.auditLoading = null;
            decline();
          },
        );
      }
    } else if (msg.t === 'duty-end') {
      this.witness?.end(msg);
      this.audits?.end(msg);
    }
  }

  /** A fight message the page hears: a duty's frames before its handover, and the handover. */
  fight(msg: EncFrameMsg | EncRefereeMsg): void {
    this.witness?.hubMsg(msg);
  }

  /** A witness event on a duty link: a fighter's input to this witness, or a probe. */
  peerEvent(from: string, ev: FighterInput | Probe): void {
    if (ev.t === 'probe') this.probes.receive(from, ev, performance.now());
    else this.witness?.input(from, ev);
  }

  /** The auditor runner and its module worker, loaded once. */
  private auditor(): Promise<{ audits: AuditDuties; runner: AuditRunner }> {
    const { app } = this;
    this.auditLoading ??= import('./app-audit').then((m) => {
      const keys = app.authorityKeys;
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
    return this.auditLoading;
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
    this.avail.frame(now, this.frameMs ?? ms);
    this.update(now);
    this.probes.tick(now, () =>
      (this.app.keeper.current?.dutyLinks() ?? []).filter((l) => l.open).map((l) => l.peer),
    );
    this.app.hud.setWitness(this.witness?.onDuty === true);
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
    this.witness?.reset();
    this.audits?.reset();
  }
}
