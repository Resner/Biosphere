// The fighter's side of a witnessed fight (ADR 0058, M10 T3): where each own input goes, how far
// ahead to play, and what to make of a witness's frames. Frame f's input goes to whoever referees
// f: the hub before a handover's frame `h`, the witness from it (signed), and the hub again from a
// take-back. At each handover the own inputs already sent for frames from its first frame on go
// once more, to the new referee. The fighter keeps the witness's last 50 signed frames; when the
// authority's frame differs from one of them, the authority's wins (the caller overrules its
// `EncounterSync`) and one `dispute` goes to the hub with the witness's signed frame. Pure: the
// sends, the signer, the frame check and the latencies are injected.

import { type EncFrameMsg, type InputMsg, type Inputs, sameInputs } from './encounter-sync';
import { AUTHORITY, RefereeSpans } from './handover';
import type { ClientMsg, HubMsg } from './protocol-defs';
import type { FighterInput, WitnessFrame } from './witness-referee';

/** Witness frames kept for a dispute. */
export const KEEP_WITNESS_FRAMES = 50;
/** Own inputs kept for a resend at a handover. */
const KEEP_SENT = 20;

export type DisputeMsg = Extract<ClientMsg, { t: 'dispute' }>;
export type EncRefereeMsg = Extract<HubMsg, { t: 'enc-referee' }>;

export interface RouteOptions {
  /** The fight's id. */
  enc: string;
  sendHub(msg: InputMsg | DisputeMsg): void;
  sendWitness(witness: string, ev: FighterInput): void;
  /** The own signature on frame `f`'s input (`signInput`). */
  signInput(f: number, code: number): string;
  /** Whether `witness` signed that frame (`witnessFrameSigned`). */
  frameSigned(witness: string, f: number, inputs: readonly (number | null)[], sig: string): boolean;
  /** The one-way latency to a referee in ms: the hub's for `'authority'`, else the witness's from its probes. */
  oneWayMs(by: string): number;
}

interface HeldFrame {
  i: Inputs;
  sig: string;
  by: string;
  /** Still the witness's to answer for: false once a take-back gives its frame to someone else. */
  disputable: boolean;
}

export class RefereeRoute {
  readonly spans = new RefereeSpans();
  /** Own inputs sent again at a handover. */
  resent = 0;
  /** Authority frames that overruled a witness's. */
  resyncs = 0;
  get disputes(): number {
    return this.disputed.size;
  }
  /** Witness frames dropped: another fight, not the frame's referee, or a signature that fails. */
  dropped = 0;

  private readonly opts: RouteOptions;
  /** The own code sent for each recent frame. */
  private readonly sent = new Map<number, number>();
  private readonly held = new Map<number, HeldFrame>();
  /** The authority's last 50 frames, to check a witness frame that comes after them. */
  private readonly hub = new Map<number, Inputs>();
  /** Witnesses already disputed: one dispute each proves the failure. */
  private readonly disputed = new Set<string>();

  constructor(opts: RouteOptions) {
    this.opts = opts;
  }

  /** Who referees frame `f`. */
  refereeOf(f: number): string {
    return this.spans.refereeOf(f);
  }

  /** The one-way latency to frame `f`'s referee, for the lead (`EncounterSync`'s `oneWayMs`). */
  oneWayMs(f: number): number {
    return this.opts.oneWayMs(this.refereeOf(f));
  }

  /** The own input for a frame (`EncounterSync`'s `send`), to that frame's referee. */
  send(msg: InputMsg): void {
    if (msg.enc !== this.opts.enc) return;
    this.sent.set(msg.f, msg.i);
    this.sent.delete(msg.f - KEEP_SENT);
    this.dispatch(msg.f, msg.i);
  }

  private dispatch(f: number, code: number): void {
    const by = this.refereeOf(f);
    const { enc } = this.opts;
    if (by === AUTHORITY) {
      this.opts.sendHub({ t: 'input', enc, f, i: code });
    } else {
      this.opts.sendWitness(by, {
        t: 'finput',
        enc,
        f,
        i: code,
        sig: this.opts.signInput(f, code),
      });
    }
  }

  /**
   * A handover (`enc-referee`): its referee takes frames from `from` on, and gets once more each
   * own input already sent for them. False (and nothing changes) for another fight, or a frame not
   * past the last handover's.
   */
  referee(msg: EncRefereeMsg): boolean {
    if (msg.enc !== this.opts.enc) return false;
    try {
      this.spans.hand(msg.by, msg.from);
    } catch {
      return false;
    }
    for (const [f, held] of this.held) {
      if (f >= msg.from && held.by !== msg.by) held.disputable = false;
    }
    const resend = [...this.sent].filter(([f]) => f >= msg.from).sort((a, b) => a[0] - b[0]);
    for (const [f, code] of resend) {
      this.dispatch(f, code);
      this.resent++;
    }
    return true;
  }

  /**
   * A witness's frame from peer `from`: kept, and returned as the `enc-frame` to feed the fight
   * with, when it is this fight's, `from` referees its frame and signed it. Null otherwise, or when
   * one is already held for that frame.
   */
  witnessFrame(from: string, ev: WitnessFrame): EncFrameMsg | null {
    if (
      ev.enc !== this.opts.enc ||
      from === AUTHORITY ||
      this.refereeOf(ev.f) !== from ||
      !this.opts.frameSigned(from, ev.f, ev.i, ev.sig)
    ) {
      this.dropped++;
      return null;
    }
    if (this.held.has(ev.f)) return null;
    this.held.set(ev.f, { i: [...ev.i], sig: ev.sig, by: from, disputable: true });
    this.held.delete(ev.f - KEEP_WITNESS_FRAMES);
    const authority = this.hub.get(ev.f);
    if (authority && !sameInputs(authority, ev.i)) {
      // The authority's frame came first and stands; the witness's proves it sent another.
      this.dispute(ev.f);
      return null;
    }
    return { t: 'enc-frame', enc: ev.enc, f: ev.f, i: [...ev.i] };
  }

  /**
   * The authority's frame. True when it differs from the witness's frame held for it: the caller
   * takes the authority's (`EncounterSync.overrule`), and the witness is disputed once.
   */
  hubFrame(msg: EncFrameMsg): boolean {
    if (msg.enc !== this.opts.enc) return false;
    this.hub.set(msg.f, [...msg.i]);
    this.hub.delete(msg.f - KEEP_WITNESS_FRAMES);
    const held = this.held.get(msg.f);
    if (!held || sameInputs(held.i, msg.i)) return false;
    this.resyncs++;
    this.dispute(msg.f);
    return true;
  }

  /** One dispute per witness, with its signed frame `f`, while the frame is still its own. */
  private dispute(f: number): void {
    const held = this.held.get(f);
    if (!held?.disputable || this.disputed.has(held.by)) return;
    this.disputed.add(held.by);
    this.opts.sendHub({ t: 'dispute', enc: this.opts.enc, f, i: held.i, sig: held.sig });
  }
}
