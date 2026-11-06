// The referee duty in the page (M10 T7, ADR 0058). The hub offers this player a fight's referee
// duty; the page checks that the drand order really puts it at the offered position, opens a duty
// link to every fighter and answers `duty-ok` once all of them are open (or `duty-no`). From the
// hub's `enc-referee` naming it, it runs a `WitnessReferee` on the hub clock, one timer for the
// next deadline: signed `wframe`s go to the fighters, `batch`es to the hub. A planned take-back
// (`enc-referee` by the authority) stops it at that frame; `duty-end` stops it at once. Every
// handler is timed (`dutyMs`), because duty must never cost the witness's own game.

import { randomnessOf } from '../ledger/drand';
import { commitmentId } from '../ledger/genesis';
import type { Identity } from '../ledger/identity';
import {
  signWitnessFrame,
  type WitnessData,
  witnessDataProblems,
  witnessOrder,
} from '../ledger/witness';
import { AUTHORITY } from '../net/handover';
import type { ClientMsg, HubMsg, PeerEvent } from '../net/protocol';
import { type FighterInput, type RefereeDuty, WitnessReferee } from '../net/witness-referee';

/** How long the page waits for its duty links before it declines (the hub moves on after 5 s). */
export const ACCEPT_WAIT_MS = 4000;
/** How often the links are looked at while they come up. */
export const LINK_POLL_MS = 100;
/** Handler times kept for `dutyMs`. */
const KEEP_TIMES = 600;
/** Fighters' inputs kept while the hub's `enc-referee` is still on its way. */
const KEEP_EARLY = 80;

export type DutyEndMsg = Extract<HubMsg, { t: 'duty-end' }>;
export type EncRefereeMsg = Extract<HubMsg, { t: 'enc-referee' }>;
export type EncFrameMsg = Extract<HubMsg, { t: 'enc-frame' }>;

/**
 * `linking`: the duty links come up; `accepted`: `duty-ok` sent, the handover awaited;
 * `refereeing`: the witness referees; `stopped`: its span is over (the fight ended, or a take-back's
 * frame was reached), and the duty's end is awaited.
 */
export type DutyPhase = 'linking' | 'accepted' | 'refereeing' | 'stopped';

export interface WitnessHost {
  identity(): Identity | null;
  /** The hub clock now, in ms. */
  hubNow(): number;
  /** A monotonic clock for the handlers' times, in ms. */
  perfNow(): number;
  sendHub(msg: ClientMsg): void;
  sendPeer(peer: string, ev: PeerEvent): void;
  /** Opens (or closes) the duty link to a fighter (`OnlineSession.dutyPeer`). */
  dutyPeer(enc: string, peer: string, on: boolean): void;
  /** Both data channels to the peer are open. */
  linkOpen(peer: string): boolean;
  /** The player is locked in a fight or fighting: it referees no one. */
  busy(): boolean;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
}

/** The duty as `state().witness.duty` shows it. */
export interface WitnessDutyView {
  event: string;
  enc: string;
  position: number;
  phase: DutyPhase;
  /** The first frame it referees, once handed over. */
  from: number | null;
  /** Frames finalized and batches sent in this duty. */
  frames: number;
  batches: number;
  /** Fighters' inputs dropped, by verdict. */
  dropped: Record<string, number>;
}

/**
 * Whether the duty's commitment and beacon put `me` at its position: the commitment is the
 * event's witness commitment on the beacon's round, its pool well formed, and the drand order of
 * its pool names `me` there.
 */
export function selected(duty: Extract<HubMsg, { t: 'duty' }>, me: string): boolean {
  const { commitment } = duty.commit;
  const data = commitment.data as unknown;
  if (commitment.kind !== 'witness' || witnessDataProblems(data).length > 0) return false;
  const { event, pool } = data as WitnessData;
  if (event !== duty.event || commitment.round !== duty.beacon.round) return false;
  try {
    const order = witnessOrder(pool, randomnessOf(duty.beacon), commitmentId(commitment));
    return order[duty.position] === me;
  } catch {
    return false;
  }
}

interface Held {
  msg: RefereeDuty;
  enc: string;
  phase: DutyPhase;
  /** When the links began to come up (perf clock). */
  since: number;
}

export class WitnessDuties {
  /** Duties accepted, and batches sent, over this page's life. */
  duties = 0;
  batches = 0;
  /** Offers declined: a selection that did not check, links that never opened, or another duty held. */
  declined = 0;
  /** Each handler's time in ms, the last `KEEP_TIMES`. */
  readonly dutyMs: number[] = [];
  /** The witness's referee from the handover until the duty ends. */
  referee: WitnessReferee | null = null;

  private held: Held | null = null;
  private timer: unknown = null;
  private early: [string, FighterInput][] = [];

  constructor(private readonly host: WitnessHost) {}

  /** On a duty now (accepted and not yet ended): the HUD's chip. */
  get onDuty(): boolean {
    const phase = this.held?.phase;
    return phase === 'accepted' || phase === 'refereeing' || phase === 'stopped';
  }

  /** A referee duty offered to this player. */
  offer(msg: RefereeDuty): void {
    this.timed(() => {
      const me = this.host.identity()?.playerId;
      if (this.held || !me || this.host.busy() || !selected(msg, me)) {
        this.decline(msg.event);
        return;
      }
      const enc = msg.start.enc;
      this.held = { msg, enc, phase: 'linking', since: this.host.perfNow() };
      for (const p of msg.fighters) this.host.dutyPeer(enc, p, true);
      this.poll();
    });
  }

  /** The hub's `enc-frame` or `enc-referee` (the page hears every fight message it is sent). */
  hubMsg(msg: EncFrameMsg | EncRefereeMsg): void {
    const held = this.held;
    if (!held || msg.enc !== held.enc) return;
    this.timed(() => {
      if (msg.t === 'enc-referee') this.handover(held, msg);
      else this.referee?.hubFrame(msg);
      this.settle();
    });
  }

  /** A fighter's `finput` on its duty link. */
  input(from: string, ev: FighterInput): void {
    const held = this.held;
    if (!held || ev.enc !== held.enc) return;
    this.timed(() => {
      const r = this.referee;
      if (!r) {
        // The fighter heard the handover first: its input waits for this page's.
        if (held.phase === 'accepted' && this.early.length < KEEP_EARLY)
          this.early.push([from, ev]);
        return;
      }
      r.input(from, ev);
      this.settle();
    });
  }

  /** The hub's `duty-end`: the duty is over at once, whatever it was doing. */
  end(msg: DutyEndMsg): void {
    const held = this.held;
    if (!held || msg.event !== held.msg.event) return;
    this.timed(() => this.close(false));
  }

  /** A new hub session knows of no duty: whatever this page held is over. */
  reset(): void {
    if (this.held) this.close(true);
  }

  view(): WitnessDutyView | null {
    const { held, referee: r } = this;
    if (!held) return null;
    return {
      event: held.msg.event,
      enc: held.enc,
      position: held.msg.position,
      phase: held.phase,
      from: r?.from ?? null,
      frames: r?.frames ?? 0,
      batches: r?.batches ?? 0,
      dropped: { ...(r?.dropped ?? {}) },
    };
  }

  private decline(event: string): void {
    this.declined++;
    this.host.sendHub({ t: 'duty-no', event });
  }

  /** While the links come up: `duty-ok` once all are open, `duty-no` once the wait is over. */
  private poll(): void {
    const held = this.held;
    if (!held || held.phase !== 'linking') return;
    const { host } = this;
    if (held.msg.fighters.every((p) => host.linkOpen(p))) {
      held.phase = 'accepted';
      this.duties++;
      host.sendHub({ t: 'duty-ok', event: held.msg.event });
      return;
    }
    if (host.perfNow() - held.since >= ACCEPT_WAIT_MS) {
      this.close(true);
      this.decline(held.msg.event);
      return;
    }
    this.arm(LINK_POLL_MS, () => this.poll());
  }

  /** `enc-referee`: this page referees from its frame, or (by the authority) stops there. */
  private handover(held: Held, msg: EncRefereeMsg): void {
    const me = this.host.identity();
    if (msg.by === AUTHORITY) {
      this.referee?.stopAt(msg.from);
      return;
    }
    if (!me || msg.by !== me.playerId || held.phase !== 'accepted' || this.referee) return;
    const enc = held.enc;
    try {
      this.referee = new WitnessReferee({
        duty: held.msg,
        from: msg.from,
        now: () => this.host.hubNow(),
        signFrame: (f, i) => signWitnessFrame(me, enc, f, i),
        sendFrame: (ev) => {
          for (const p of held.msg.fighters) this.host.sendPeer(p, ev);
        },
        sendBatch: (b) => {
          this.batches++;
          this.host.sendHub(b);
        },
      });
    } catch {
      // A duty that does not build: nothing goes out, and the authority takes its fight back.
      held.phase = 'stopped';
      return;
    }
    held.phase = 'refereeing';
    const early = this.early;
    this.early = [];
    for (const [from, ev] of early) this.referee.input(from, ev);
  }

  /** Finalizes what is due, and arms the one timer for the next deadline. */
  private settle(): void {
    const held = this.held;
    const r = this.referee;
    if (!held || !r) return;
    r.tick();
    if (r.done) {
      held.phase = 'stopped';
      this.disarm();
      return;
    }
    const at = r.nextDeadline();
    if (!Number.isFinite(at)) {
      this.disarm();
      return;
    }
    this.arm(Math.max(0, at - this.host.hubNow()), () => this.timed(() => this.settle()));
  }

  /** The duty is over: the referee stops, and with `links` this page closes its duty links itself. */
  private close(links: boolean): void {
    const held = this.held;
    this.disarm();
    this.referee?.stop();
    this.referee = null;
    this.held = null;
    this.early = [];
    if (links && held) for (const p of held.msg.fighters) this.host.dutyPeer(held.enc, p, false);
  }

  private arm(ms: number, fn: () => void): void {
    this.disarm();
    this.timer = this.host.setTimer(() => {
      this.timer = null;
      fn();
    }, ms);
  }

  private disarm(): void {
    if (this.timer !== null) this.host.clearTimer(this.timer);
    this.timer = null;
  }

  private timed(fn: () => void): void {
    const t0 = this.host.perfNow();
    try {
      fn();
    } finally {
      this.dutyMs.push(this.host.perfNow() - t0);
      if (this.dutyMs.length > KEEP_TIMES) this.dutyMs.splice(0, this.dutyMs.length - KEEP_TIMES);
    }
  }
}
