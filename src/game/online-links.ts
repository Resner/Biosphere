// Links by area of interest (M11 T13, ADRs 0062 and 0063): the page's plan loop. Every 500 ms, and
// at once when the directory answers or an offer comes in, it classifies the known set
// (`neighbours.ts`) through `AoiManager`, closes what the plan evicts (a held peer with no class
// after 3 s), and dials as the headless harness does: P0 and P1 at once through the hub; the rest
// through a gossip-placed peer, else one hub call at a time once 4 links are held; the lower id
// calls (the higher waits 1.5 s); a P4 only on a fix under 5 s old; at most 8 calls a plan. An offer
// carries its caller's class and is admitted by the better of that and this page's own; a refusal
// is answered and backs off a P3 or P4 (5 s, doubling to 60 s). Duty links are P0, through
// `ConnectionPolicy.duty`, under the same cap rule as every other link, and so are a fight's links
// to its other fighters (M11 T16) from its start until 3 s after its end, whatever the distance,
// leaf or tier; then they close at once unless another class holds them.

import { AoiManager, type AoiSelf } from '../net/aoi';
import { ConnectionPolicy, type LinkClass, NO_CLASS } from '../net/connection-policy';
import type { PeerMesh } from '../net/peer-mesh';
import type { Pos, SignalKind, WireClass } from '../net/protocol';
import type { Neighbours } from './neighbours';

export const PLAN_EVERY_MS = 500;
/** A creature this young dials freely: it has no links to carry its offers. */
export const YOUNG_MS = 8000;
/** A plan starts at most this many calls beyond P1. */
export const DIALS_PER_PLAN = 8;
/** A page holding fewer links than this dials through the hub freely. */
export const HUB_DIALS_FREE = 4;
/** Beyond P1 the lower id calls; the higher waits this long for it before calling itself. */
export const LOWER_CALLS_MS = 1500;
/** A P4 is called only on a fix of it under this old: a directory entry may be 30 s stale. */
export const FRESH_DIAL_MS = 5000;
/** An offer unanswered this long is dropped. */
export const OFFER_TIMEOUT_MS = 8000;
/** A refused P3 or P4 is not asked again for this long, doubling each time up to the max. */
export const REFUSED_BACKOFF_MS = 5000;
export const REFUSED_BACKOFF_MAX_MS = 60_000;
/** A fight's links stay P0 this long past its end (M11 T16). */
export const FIGHT_HOLD_MS = 3000;

/** The mesh as the plan drives it. */
export type LinkMesh = Pick<
  PeerMesh,
  'connect' | 'disconnect' | 'peers' | 'isOpen' | 'isUp' | 'handleSignal'
>;

/** A link as `state().net.links` shows it: `open` the connection up, `hello` the peer's ticket passed. */
export interface LinkInfo {
  id: string;
  class: LinkClass | null;
  open: boolean;
  hello: boolean;
  /** When its hello passed (page ms), or null before. */
  since: number | null;
}

/** A duty link (M10 T6) as `state().net.dutyLinks` shows it. */
export interface DutyLink {
  peer: string;
  open: boolean;
  /** The fights it serves. */
  encs: string[];
}

export interface LinksOptions {
  selfId: string;
  mesh: LinkMesh;
  neighbours: Neighbours;
  /** Sends a signal (`SignalRoute.send`): through the hub when `viaHub`, else a peer when one can carry it. */
  send(to: string, kind: SignalKind, sdp: string, cls: WireClass, viaHub: boolean): 'peer' | 'hub';
  /** The page clock, ms. */
  now(): number;
  /** The own creature, or null with none in this world (the title). */
  self(): AoiSelf | null;
  /** Whether the creature is younger than `YOUNG_MS` in the water. */
  young(): boolean;
  /** Whether this page may call and admit: it holds a ticket and can check its peers'. */
  ready(): boolean;
}

interface Attempt {
  at: number;
  cls: WireClass;
  answered: boolean;
  /** Whether the offer went through the hub; null until it went. */
  viaHub: boolean | null;
}

export class Links {
  /** P0 and P1 pass 32 by the last plan: only P0 and the nearest P1 are held. */
  crowded = false;
  /** Offers this page refused. */
  refused = 0;
  private mgr: AoiManager;
  /** The duty peers (P0) by `duty(id, on)`; `duties` keeps the fights each serves. */
  private readonly policy: ConnectionPolicy;
  private readonly duties = new Map<string, Set<string>>();
  /** This page's fights: the other fighters, P0 until `until` (page ms; Infinity while it runs). */
  private readonly fights = new Map<string, { peers: Set<string>; until: number }>();
  private readonly out = new Map<string, Attempt>();
  private readonly helloAt = new Map<string, number>();
  private readonly refusals = new Map<string, number>();
  private readonly refusedUntil = new Map<string, number>();
  /** When a lower-id peer first showed up in the plan: this page waits for its call. */
  private readonly waiting = new Map<string, number>();
  private classes = new Map<string, LinkClass>();
  /** Fighters whose fight's hold ran out in the last classification. */
  private readonly released = new Set<string>();
  private lastPlan = Number.NEGATIVE_INFINITY;

  constructor(private readonly o: LinksOptions) {
    this.mgr = new AoiManager({ selfId: o.selfId });
    this.policy = new ConnectionPolicy({ selfId: o.selfId });
  }

  /** A peer's planned class, P4 when the plan doesn't know it. */
  private classOrFar(id: string): WireClass {
    return (this.classes.get(id) ?? 4) as WireClass;
  }

  /** Sets the room for P2 to P4 (`debug.netCap`, 1 to 24); P0 and P1 may still reach 32. */
  setCap(cap: number): void {
    this.mgr = new AoiManager({ selfId: this.o.selfId, cap });
    this.plan();
  }

  /** A known creature's class by the last plan, or null. */
  classOf(id: string): LinkClass | null {
    return this.classes.get(id) ?? null;
  }

  /** Called often: drops offers past their time, and plans every 500 ms. */
  tick(): void {
    const now = this.o.now();
    const held = new Set(this.o.mesh.peers());
    for (const [id, a] of [...this.out]) {
      // The mesh gave the call up (it failed or timed out): the next plan may call again.
      if (!held.has(id)) this.out.delete(id);
      else if (!a.answered && now - a.at >= OFFER_TIMEOUT_MS) {
        this.close(id);
        this.backOff(id, now);
      }
    }
    if (now - this.lastPlan >= PLAN_EVERY_MS) this.plan();
  }

  /** Classifies, closes what the plan evicts, and dials what it wants. */
  plan(): void {
    const now = this.o.now();
    const plan = this.replan(now);
    for (const id of plan.evict) this.close(id);
    // A fight's links past their hold close at once unless another class holds them.
    for (const id of this.released) if (!this.classes.has(id)) this.close(id);
    this.released.clear();
    if (!this.o.ready()) return;
    const wanted = new Set(plan.connect);
    for (const id of this.waiting.keys()) if (!wanted.has(id)) this.waiting.delete(id);
    const young = this.o.young();
    const heldCount = this.o.mesh.peers().length;
    let hubDials = 0;
    let dials = 0;
    for (const id of plan.connect) {
      if (this.o.mesh.peers().includes(id)) continue;
      const cls = this.classOrFar(id);
      // A refusal holds off a P3 or P4 call; P0 to P2 are asked again at once.
      if (cls > 2 && (this.refusedUntil.get(id) ?? 0) > now) continue;
      const urgent = cls <= 1;
      if (!urgent && !young) {
        if (dials >= DIALS_PER_PLAN) continue;
        if (cls === 4 && this.o.neighbours.fixAge(id, now) > FRESH_DIAL_MS) continue;
        if (this.o.selfId > id) {
          const since = this.waiting.get(id) ?? now;
          this.waiting.set(id, since);
          if (now - since < LOWER_CALLS_MS) continue;
        }
        const relayable = this.o.neighbours.gossip
          .heard(id, now)
          .some((h) => this.o.mesh.isOpen(h.via));
        if (!relayable) {
          if (heldCount >= HUB_DIALS_FREE && (hubDials >= 1 || this.hubInFlight())) continue;
          hubDials++;
        }
        dials++;
      }
      this.out.set(id, { at: now, cls, answered: false, viaHub: null });
      this.o.mesh.connect(id);
    }
  }

  /** The mesh's own signal (an offer or answer it made): out by the route, with this page's class. */
  outgoing(to: string, kind: 'offer' | 'answer', sdp: string): void {
    const a = kind === 'offer' ? this.out.get(to) : undefined;
    const cls = a?.cls ?? this.classOrFar(to);
    // P0 and P1 go through the hub: a peer's relay that fails silently costs 4 s of a 3 s lead.
    const way = this.o.send(to, kind, sdp, cls, kind === 'offer' && cls <= 1);
    if (a) a.viaHub = way === 'hub';
  }

  /** An inbound signal from the route, with where its sender said it was and its class for this page. */
  signal(from: string, kind: SignalKind, sdp: string, pos: Pos | null, cls: WireClass): void {
    if (from === this.o.selfId) return;
    const now = this.o.now();
    if (pos) this.o.neighbours.signal(from, pos, now);
    if (kind === 'answer') {
      const a = this.out.get(from);
      if (a) a.answered = true;
      void this.o.mesh.handleSignal(from, 'answer', sdp);
    } else if (kind === 'refuse') {
      // Only an unanswered call of this page is refused; a stale or replayed refusal is ignored.
      const call = this.out.get(from);
      if (!call || call.answered) return;
      this.close(from);
      this.backOff(from, now);
    } else {
      this.offer(from, sdp, cls, now);
    }
  }

  /** A link's hello passed. */
  opened(id: string): void {
    this.helloAt.set(id, this.o.now());
    this.out.delete(id);
    this.refusals.delete(id);
    this.refusedUntil.delete(id);
  }

  /** A joined link closed. */
  left(id: string): void {
    this.helloAt.delete(id);
    this.o.neighbours.forget(id);
  }

  /**
   * Opens (or closes) a duty link to `peer` for fight `enc` (M10 T6, ADR 0058): P0, so it is held
   * up to `MAX_CAP` and takes the place of the worst P2 to P4 past the cap. It closes like any
   * other link once nothing classes it, 3 s after its last fight ends.
   */
  duty(enc: string, peer: string, on: boolean): void {
    if (peer === this.o.selfId) return;
    const encs = this.duties.get(peer);
    if (!on) {
      if (!encs?.delete(enc) || encs.size > 0) return;
      this.duties.delete(peer);
      this.policy.duty(peer, false);
      return;
    }
    if (encs) {
      encs.add(enc);
      return;
    }
    this.duties.set(peer, new Set([enc]));
    this.policy.duty(peer, true);
    this.plan();
  }

  /**
   * This page fights in `enc` (its `enc-start`, also a joiner's catch-up, and each `enc-join`): every
   * other fighter in `players` is P0 until 3 s after the fight's end.
   */
  fight(enc: string, players: readonly string[]): void {
    const f = this.fights.get(enc) ?? { peers: new Set<string>(), until: Infinity };
    f.until = Infinity;
    for (const p of players) if (p !== this.o.selfId) f.peers.add(p);
    this.fights.set(enc, f);
    this.plan();
  }

  /** A fighter joined one of this page's fights (a witness's frames name fights it doesn't fight in). */
  joined(enc: string, player: string): void {
    if (this.fights.has(enc)) this.fight(enc, [player]);
  }

  /**
   * A fight ended: the duty links it held lose their class, and its fighters' links 3 s from now.
   */
  endFight(enc: string): void {
    this.endDuty(enc);
    this.holdFight(enc);
  }

  /** A duty for fight `enc` ended: the duty links it held lose their class. */
  endDuty(enc: string): void {
    for (const [peer, encs] of [...this.duties]) if (encs.has(enc)) this.duty(enc, peer, false);
  }

  /** A welcome: every fight's links end in 3 s, unless the hub resends the fight (it does at once for a running one). */
  endFights(): void {
    for (const enc of this.fights.keys()) this.holdFight(enc);
  }

  private holdFight(enc: string): void {
    const f = this.fights.get(enc);
    if (f && f.until === Infinity) f.until = this.o.now() + FIGHT_HOLD_MS;
  }

  /** The creatures wanted as P0 or P1 by the last plan: a witness takes a duty only at 28 or fewer. */
  protectedCount(): number {
    let n = 0;
    for (const c of this.classes.values()) if (c <= 1) n++;
    return n;
  }

  dutyLinks(): DutyLink[] {
    return [...this.duties]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([peer, encs]) => ({ peer, open: this.o.mesh.isOpen(peer), encs: [...encs].sort() }));
  }

  /** Every link, open or coming up, by id. */
  info(): LinkInfo[] {
    return [...this.o.mesh.peers()].sort().map((id) => ({
      id,
      class: this.classes.get(id) ?? null,
      open: this.o.mesh.isUp(id),
      hello: this.o.mesh.isOpen(id),
      since: this.helloAt.get(id) ?? null,
    }));
  }

  /** Classifies the known set (P0 alone with no creature) and plans against the links held. */
  private replan(now: number) {
    const self = this.o.self();
    const p0 = new Set([...this.duties.keys()].filter((id) => this.policy.isDuty(id)));
    for (const [enc, f] of [...this.fights]) {
      if (f.until > now) for (const id of f.peers) p0.add(id);
      else {
        this.fights.delete(enc);
        for (const id of f.peers) this.released.add(id);
      }
    }
    for (const id of p0) this.released.delete(id);
    const classes = self
      ? this.mgr.classify(self, this.o.neighbours.known(now), p0, this.classes)
      : new Map<string, LinkClass>([...p0].map((id) => [id, 0]));
    const plan = this.mgr.plan(classes, new Set(this.o.mesh.peers()), now);
    this.classes = classes;
    this.crowded = plan.crowded;
    this.lastPlan = now;
    return plan;
  }

  private offer(from: string, sdp: string, cls: WireClass, now: number): void {
    const { mesh } = this.o;
    const mine = this.out.get(from);
    if (mine) {
      // Crossing offers: the lower id keeps its own and ignores the other.
      if (this.o.selfId < from) return;
    } else if (mesh.peers().includes(from)) {
      // Admitted already: the mesh answers a repeated offer again, or a fresh one replaces the link.
      void mesh.handleSignal(from, 'offer', sdp);
      return;
    }
    if (!this.o.ready() || !this.admit(from, cls, now)) {
      this.refused++;
      this.o.send(from, 'refuse', '', this.classOrFar(from), false);
      return;
    }
    this.out.delete(from);
    void mesh.handleSignal(from, 'offer', sdp);
  }

  /** By the better of the caller's class and this page's own, against the links held now. */
  private admit(from: string, cls: WireClass, now: number): boolean {
    this.replan(now);
    const classes = new Map(this.classes);
    if (cls < (classes.get(from) ?? NO_CLASS)) classes.set(from, cls);
    const held = new Set(this.o.mesh.peers());
    held.delete(from);
    const plan = this.mgr.plan(classes, held, now);
    if (!plan.connect.includes(from)) return false;
    this.classes = classes;
    for (const id of plan.evict) this.close(id);
    return true;
  }

  private close(id: string): void {
    this.out.delete(id);
    this.o.mesh.disconnect(id);
  }

  private backOff(id: string, now: number): void {
    const n = this.refusals.get(id) ?? 0;
    this.refusals.set(id, n + 1);
    this.refusedUntil.set(id, now + Math.min(REFUSED_BACKOFF_MAX_MS, REFUSED_BACKOFF_MS * 2 ** n));
  }

  private hubInFlight(): boolean {
    for (const a of this.out.values()) if (!a.answered && a.viaHub === true) return true;
    return false;
  }
}
