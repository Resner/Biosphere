// Relayed signaling (M11 T9, ADR 0062): a new link's offer and answer travel through a peer both
// sides already hold, so the hub carries a signal only when no peer can. To reach C, a page asks
// the linked peer whose gossip placed C in the last 10 s and that sits nearest C; the relay is
// signed by its sender over every field (`signalBytes`), so the peer in between can change nothing.
// A peer forwards a relay only from its own sender to a linked `to`, unchanged, at most 4 a second
// per link. The receiver takes one signed by `from`, addressed to it, dated within 30 s of its hub
// clock and new; the answer (or the callee's refusal) goes back the way the offer came, and an
// offer unanswered after 4 s goes once more through the hub. Every signal carries the link class its
// sender holds the receiver in (`cls`, ADR 0063), inside the signature. Pure: the signer, the check and every transport are injected,
// so it loads no `@noble/curves` and the harness (T10) runs it without sockets.

import type { Heard } from './gossip';
import type { PeerEvent, Pos, SignalKind, WireClass } from './protocol-defs';

export const RELAY_PER_S = 4;
export const RELAY_SKEW_MS = 30_000;
export const RELAY_REPLAY_MS = 120_000;
export const RELAY_ANSWER_MS = 4000;
/** Relays remembered against replays at most, the oldest dropped first. */
const SEEN_MAX = 4096;
/** Offers' return routes kept, the oldest dropped first. */
const OFFER_VIA_MAX = 256;
const RATE_WINDOW_MS = 1000;

export type RelayEvent = Extract<PeerEvent, { t: 'relay' }>;
type Kind = SignalKind;

export interface SignalRouteOptions {
  selfId: string;
  /** The hub clock, ms: a relay's `at`, and what an inbound one is checked against. */
  now: () => number;
  /** This page's own position for a relay's `pos`, within the wire's ranges. */
  pos: () => Pos;
  /** This page's signature on a signal (`signSignal` with its identity). */
  sign: (to: string, kind: Kind, cls: WireClass, at: number, pos: Pos, sdp: string) => string;
  /** Whether a relay carries its sender's signature (`signalSigned`). */
  verify: (m: RelayEvent) => boolean;
  /** Whether a peer is linked now (open, its hello passed). */
  linked: (id: string) => boolean;
  /** The linked peers whose gossip placed `id` in the last 10 s (`Gossip.heard`). */
  heard: (id: string) => Heard[];
  /** Where a linked peer is by its snapshots, or null. */
  placeOf: (id: string) => { x: number; y: number } | null;
  /** Sends a relay on a link; false when it was not sent. */
  sendPeer: (via: string, m: RelayEvent) => boolean;
  /** Sends a signal through the hub. */
  sendHub: (to: string, kind: Kind, sdp: string, cls: WireClass) => void;
  /**
   * An inbound signal for this page, with where its sender said it was and the class it holds this
   * page in (a hub signal without one counts as P4).
   */
  deliver: (from: string, kind: Kind, sdp: string, pos: Pos | null, cls: WireClass) => void;
}

export interface SignalStats {
  /** Signals this page sent through the hub (fallbacks included). */
  hub: number;
  /** This page's own signals that went, or came, through a peer. */
  relayed: number;
  /** Relays this page passed on between two of its peers. */
  forwarded: number;
  /** Offers resent through the hub after 4 s unanswered. */
  fallback: number;
  /** Dropped: not signed by `from` over these fields. */
  forged: number;
  /** Dropped: an `at` more than 30 s from this page's hub clock. */
  stale: number;
  /** Dropped: a (from, at) taken in the last 2 minutes. */
  replayed: number;
  /** Dropped: past 4 a second on its link. */
  limited: number;
  /** Dropped: to a peer not held, from someone other than its link, or from this page itself. */
  stray: number;
}

interface Pending {
  sdp: string;
  cls: WireClass;
  due: number;
}

export class SignalRoute {
  private readonly counts: SignalStats = {
    hub: 0,
    relayed: 0,
    forwarded: 0,
    fallback: 0,
    forged: 0,
    stale: 0,
    replayed: 0,
    limited: 0,
    stray: 0,
  };
  /** Offers sent through a peer and not yet answered, by target. */
  private readonly pending = new Map<string, Pending>();
  /** The link each peer's last offer came in on, so the answer goes back that way. */
  private readonly offerVia = new Map<string, string>();
  /** Relays taken, `from|kind|at` → when, oldest first. */
  private readonly seen = new Map<string, number>();
  /** Each link's relays passed in the last second, sent or received. */
  private readonly window = new Map<string, number[]>();

  constructor(private readonly o: SignalRouteOptions) {}

  stats(): SignalStats {
    return { ...this.counts };
  }

  /**
   * Sends an offer, answer or refusal to `to` (the mesh's `signal`), carrying `cls`: through a peer
   * when one can carry it, unless `viaHub` (ADR 0063: a P0 or P1 call). Says which way it went.
   */
  send(to: string, kind: Kind, sdp: string, cls: WireClass, viaHub = false): 'peer' | 'hub' {
    const now = this.o.now();
    if (kind !== 'offer') {
      const via = this.offerVia.get(to);
      this.offerVia.delete(to);
      if (via !== undefined && this.relay(via, to, kind, sdp, cls, now)) return 'peer';
      this.hub(to, kind, sdp, cls);
      return 'hub';
    }
    this.pending.delete(to);
    const via = viaHub ? null : this.viaFor(to);
    if (via !== null && this.relay(via, to, kind, sdp, cls, now)) {
      this.pending.set(to, { sdp, cls, due: now + RELAY_ANSWER_MS });
      return 'peer';
    }
    this.hub(to, kind, sdp, cls);
    return 'hub';
  }

  /** A signal the hub relayed, with the sender's directory position when the hub stamped one. */
  fromHub(from: string, kind: Kind, sdp: string, at?: Pos, cls?: WireClass): void {
    if (from === this.o.selfId) return;
    this.took(from, kind, null);
    this.o.deliver(from, kind, sdp, at ?? null, cls ?? 4);
  }

  /** A `relay` event that came in on the link to `via`: for this page, or to pass on. */
  fromPeer(via: string, m: RelayEvent): void {
    const now = this.o.now();
    if (m.to !== this.o.selfId) {
      this.forward(via, m, now);
      return;
    }
    if (m.from === this.o.selfId) {
      this.counts.stray += 1;
      return;
    }
    if (!this.room(via, now)) {
      this.counts.limited += 1;
      return;
    }
    // Every inbound relay counts against the link's second, whatever it turns out to be.
    this.pass(via, now);
    if (Math.abs(m.at - now) > RELAY_SKEW_MS) {
      this.counts.stale += 1;
      return;
    }
    const key = `${m.from}|${m.kind}|${m.at}`;
    this.forgetSeen(now);
    if (this.seen.has(key)) {
      this.counts.replayed += 1;
      return;
    }
    // Checked last, as it costs most; only a genuine relay is remembered against replays.
    if (!this.o.verify(m)) {
      this.counts.forged += 1;
      return;
    }
    this.seen.set(key, now);
    if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.keys().next().value as string);
    this.counts.relayed += 1;
    this.took(m.from, m.kind, via);
    this.o.deliver(m.from, m.kind, m.sdp, m.pos, m.cls);
  }

  /** Resends through the hub, once, each offer a peer carried that is unanswered after 4 s. */
  tick(): void {
    const now = this.o.now();
    for (const [to, p] of this.pending) {
      if (now < p.due) continue;
      this.pending.delete(to);
      if (this.o.linked(to)) continue;
      this.counts.fallback += 1;
      this.hub(to, 'offer', p.sdp, p.cls);
    }
  }

  /** Forgets a peer's signaling state (it left, or the link to it was given up). */
  forget(id: string): void {
    this.pending.delete(id);
    this.offerVia.delete(id);
    this.window.delete(id);
  }

  /** An inbound signal from `from` came through `via` (null: the hub). */
  private took(from: string, kind: Kind, via: string | null): void {
    if (kind !== 'offer') {
      this.pending.delete(from);
    } else if (via === null) {
      this.offerVia.delete(from);
    } else {
      // Bounded like `seen`: an offer nobody answers would otherwise stay for good.
      this.offerVia.delete(from);
      this.offerVia.set(from, via);
      if (this.offerVia.size > OFFER_VIA_MAX)
        this.offerVia.delete(this.offerVia.keys().next().value as string);
    }
  }

  /** The linked peer nearest `to` among those whose gossip placed it, or null. */
  private viaFor(to: string): string | null {
    let best: string | null = null;
    let bestD = Number.POSITIVE_INFINITY;
    for (const { via, fix } of this.o.heard(to)) {
      if (via === to || via === this.o.selfId || !this.o.linked(via)) continue;
      const at = this.o.placeOf(via);
      const d = at ? Math.hypot(at.x - fix.x, at.y - fix.y) : Number.MAX_VALUE;
      if (d < bestD) {
        best = via;
        bestD = d;
      }
    }
    return best;
  }

  /** Signs and sends a relay through `via`; false when it could not go. */
  private relay(
    via: string,
    to: string,
    kind: Kind,
    sdp: string,
    cls: WireClass,
    now: number,
  ): boolean {
    if (!this.o.linked(via)) return false;
    const at = Math.max(0, Math.round(now));
    const pos = this.o.pos();
    let m: RelayEvent;
    try {
      m = { t: 'relay', from: this.o.selfId, to, kind, sdp, cls, at, pos, sig: '' };
      m.sig = this.o.sign(to, kind, cls, at, pos, sdp);
    } catch {
      return false;
    }
    if (!this.o.sendPeer(via, m)) return false;
    this.counts.relayed += 1;
    return true;
  }

  private hub(to: string, kind: Kind, sdp: string, cls: WireClass): void {
    this.counts.hub += 1;
    this.o.sendHub(to, kind, sdp, cls);
  }

  /** Passes a relay on from its sender's link to a linked `to`, unchanged. */
  private forward(via: string, m: RelayEvent, now: number): void {
    if (m.from !== via || m.to === via || !this.o.linked(m.to)) {
      this.counts.stray += 1;
      return;
    }
    if (!this.room(via, now) || !this.room(m.to, now)) {
      this.counts.limited += 1;
      return;
    }
    if (!this.o.sendPeer(m.to, m)) {
      this.counts.stray += 1;
      return;
    }
    this.pass(via, now);
    this.pass(m.to, now);
    this.counts.forwarded += 1;
  }

  /** Whether the link to `id` has passed fewer than 4 relays in the last second. */
  private room(id: string, now: number): boolean {
    const times = this.window.get(id);
    if (!times) return true;
    while (times.length > 0 && (times[0] as number) <= now - RATE_WINDOW_MS) times.shift();
    return times.length < RELAY_PER_S;
  }

  private pass(id: string, now: number): void {
    const times = this.window.get(id);
    if (times) times.push(now);
    else this.window.set(id, [now]);
  }

  private forgetSeen(now: number): void {
    for (const [key, t] of this.seen) {
      if (now - t <= RELAY_REPLAY_MS) break;
      this.seen.delete(key);
    }
  }
}
