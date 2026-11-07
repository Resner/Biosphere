// The headless area-of-interest harness (M11 T10, ADR 0062): simulated clients, each with its own
// `AoiManager`, `WhereReporter`, `Gossip` and `SignalRoute`, against one real `Directory`, over a
// seeded link model, with no sockets and no WebRTC. Creatures move by script within the real speed
// limits. The harness measures what the gates in `aoi-scenarios.ts` judge. Deterministic: the same
// scenario and seed give the same result.
//
// The link model (all numbers seeded): a hop between two peers takes 30-80 ms, the hub 50-150 ms
// each way; ICE takes 0.5-2 s and fails 5% of the time (the next plan retries at once); the hello
// takes a round trip. A caller whose offer is refused or answered by the hub's `no-peer` waits 5 s
// before it asks that peer again, and an offer nobody answers within 8 s is dropped. The plan runs
// every 500 ms, and at once when the directory answers or an offer comes in.

// The page's dial rules (M11 T13): the harness models the same loop with the same constants. A
// creature younger than `YOUNG_MS` dials freely, and is not yet expected to be linked to anyone.
import {
  DIALS_PER_PLAN,
  FRESH_DIAL_MS,
  HUB_DIALS_FREE,
  LOWER_CALLS_MS,
  OFFER_TIMEOUT_MS,
  REFUSED_BACKOFF_MAX_MS,
  REFUSED_BACKOFF_MS,
  YOUNG_MS,
} from '../src/game/online-links';
import {
  AoiManager,
  type AoiSelf,
  aoiRadius,
  INTERACT_LEAD_WU,
  INTERACT_RADII,
  type Known,
  queryRadius,
} from '../src/net/aoi';
import { type LinkClass, NO_CLASS } from '../src/net/connection-policy';
import { type Fix, Gossip, type PeersEvent } from '../src/net/gossip';
import { byteLength, type Leaf, type Pos, type SignalKind } from '../src/net/protocol';
import { SignalRoute } from '../src/net/signal-route';
import { WhereReporter } from '../src/net/where';
import { clamp } from '../src/sim/math';
import { createRng, type Rng, seedFromString } from '../src/sim/prng';
import { linkTiers, viewHalfHeight } from '../src/sim/size';
import { Directory, RELAY_SLACK_WU } from '../worker/directory';

import {
  type ClientSpec,
  type FightSpec,
  GATE_KEYS,
  type GateKey,
  type RunResult,
  type Scenario,
} from './aoi-types';

const TICK_MS = 100;
/** The world's centre: scenarios lay their creatures out around it (ADR 0061). */
export const CENTRE = 131_072;
const WORLD = 262_144;
/** The half-diagonal of a 16:9 view, in view half-heights. */
const VIEW_DIAG = Math.hypot(1, 16 / 9);
/** A pair that has been within P1 reach this long must be linked (gate 2). */
const SETUP_GRACE_MS = 10_000;
/** Gate 3 holds for newcomers closing at most this fast (relative, wu/s): the P1 lead gives 6 s at 100. */
const LATE_CLOSING = 100;
/** A link made this long after the later spawn counts as a later link (gate 5's relay share). */
const LATE_AFTER_MS = 60_000;
/** A crowded flag settles this long after the last plan that set it. */
const CROWD_SETTLE_MS = 10_000;
const ICE_FAIL = 0.05;
const MAX_VIOLATIONS = 8;

interface Link {
  hello: boolean;
  helloAt: number;
  relayed: boolean;
}

interface Attempt {
  from: string;
  to: string;
  state: 'offer' | 'ice' | 'dead';
  relayed: boolean;
  /** The class the caller holds the callee in: the offer carries it, and `admit` judges by it. */
  cls: LinkClass;
}

class Client {
  readonly mgr: AoiManager;
  readonly gossip: Gossip;
  readonly reporter = new WhereReporter();
  readonly route: SignalRoute;
  x: number;
  y: number;
  vx = 0;
  vy = 0;
  r: number;
  heading: number;
  dashUntil = 0;
  dashAt = 0;
  readonly links = new Map<string, Link>();
  readonly out = new Map<string, Attempt>();
  readonly inn = new Map<string, Attempt>();
  readonly fixes = new Map<string, Fix>();
  dirKnown: Known[] = [];
  readonly signalKnown = new Map<string, Known>();
  readonly refusedUntil = new Map<string, number>();
  readonly refusals = new Map<string, number>();
  /** When a higher-id peer first showed up in the plan: it waits for the lower id's call. */
  readonly waiting = new Map<string, number>();
  classes = new Map<string, LinkClass>();
  knownIds = new Set<string>();
  p0 = new Set<string>();
  crowded = false;
  crowdedAt = Number.NEGATIVE_INFINITY;
  /** Creatures it could link within its P1 reach by true positions, this tick. */
  p1True = 0;
  dirty = false;
  leaf: Leaf | null = null;
  readonly hubMsgs: number[] = [];
  readonly phase: number;
  /** Discovery bookkeeping per other creature. */
  readonly entered = new Map<string, number>();
  readonly found = new Set<string>();
  viewSet = new Set<string>();
  constructor(
    readonly spec: ClientSpec,
    index: number,
    route: (c: Client) => SignalRoute,
  ) {
    this.mgr = new AoiManager({ selfId: spec.id });
    this.gossip = new Gossip(spec.id);
    this.x = spec.x;
    this.y = spec.y;
    this.r = spec.r;
    this.heading = spec.walk.heading;
    this.phase = index % 5;
    this.route = route(this);
  }
  get id(): string {
    return this.spec.id;
  }
  aoi(): number {
    return aoiRadius(this.r, this.spec.adultR);
  }
  view(): number {
    return VIEW_DIAG * viewHalfHeight(this.r, this.spec.adultR);
  }
  helloed(id: string): boolean {
    return this.links.get(id)?.hello === true;
  }
  /** P0 and P1 peers by the last plan. */
  heavy(): number {
    let n = 0;
    for (const c of this.classes.values()) if (c <= 1) n++;
    return n;
  }
}

export function runScenario(scenario: Scenario, seed: string): RunResult {
  return new Sim(scenario, seed).run();
}

class Sim {
  private now = 0;
  private seq = 0;
  private readonly events: { t: number; seq: number; fn: () => void }[] = [];
  private readonly clients = new Map<string, Client>();
  private readonly order: Client[] = [];
  private readonly dir = new Directory(WORLD);
  private readonly script: Rng;
  private readonly net: Rng;
  private readonly res: RunResult;
  private readonly p1Since = new Map<string, number>();
  private readonly badSince = new Map<string, number>();
  private readonly firstLink = new Set<string>();
  private tickIndex = 0;

  constructor(
    private readonly sc: Scenario,
    seed: string,
  ) {
    const s = seedFromString(`aoi|${sc.name}|${seed}`);
    this.script = createRng(s, 'script');
    this.net = createRng(s, 'net');
    const zero = () => Object.fromEntries(GATE_KEYS.map((k) => [k, 0])) as Record<GateKey, number>;
    const none = () =>
      Object.fromEntries(GATE_KEYS.map((k) => [k, []])) as unknown as Record<GateKey, string[]>;
    this.res = {
      scenario: sc.name,
      seed,
      seconds: sc.seconds,
      clients: sc.clients.length,
      violations: zero(),
      examples: none(),
      linkHistogram: Array.from({ length: 33 }, () => 0),
      maxHeld: 0,
      friendMs: [],
      discoveryMs: [],
      perMinute: [],
      joinMinute: [],
      lateLinks: 0,
      lateRelayed: 0,
      gossipBytes: 0,
      linkSeconds: 0,
      crowdedSeconds: 0,
      clientSeconds: 0,
      duties: 0,
      dutiesTaken: 0,
      entries: 0,
      entriesLinked: 0,
      hub: { relayed: 0, hub: 0, fallback: 0, refused: 0 },
    };
    sc.clients.forEach((spec, i) => {
      this.after(spec.spawnAt, () => this.spawn(spec, i));
    });
    for (const f of sc.fights ?? []) {
      this.after(f.from, () => this.duty(f, true));
      this.after(f.until, () => this.duty(f, false));
      this.after(f.from + 10_000, () => this.checkDuty(f, 'taken'));
      this.after(f.until - 500, () => this.checkDuty(f, 'held'));
    }
  }

  run(): RunResult {
    const end = this.sc.seconds * 1000;
    for (this.now = 0; this.now <= end; this.now += TICK_MS) {
      this.runEvents();
      this.tick();
      this.tickIndex++;
    }
    for (const c of this.order) this.finish(c);
    for (const c of this.order) {
      const s = c.route.stats();
      this.res.hub.relayed += s.relayed;
      this.res.hub.hub += s.hub;
      this.res.hub.fallback += s.fallback;
    }
    return this.res;
  }

  // ---- time ----

  private after(ms: number, fn: () => void): void {
    const t = this.now + Math.max(0, ms);
    const e = { t, seq: this.seq++, fn };
    let lo = 0;
    let hi = this.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const m = this.events[mid] as (typeof this.events)[number];
      if (m.t < t || (m.t === t && m.seq < e.seq)) lo = mid + 1;
      else hi = mid;
    }
    this.events.splice(lo, 0, e);
  }

  private runEvents(): void {
    while (this.events.length > 0 && (this.events[0] as { t: number }).t <= this.now) {
      (this.events.shift() as { fn: () => void }).fn();
    }
  }

  private hop = () => this.net.range(30, 80);
  private hubMs = () => this.net.range(50, 150);

  private violate(gate: GateKey, text: string): void {
    this.res.violations[gate]++;
    const ex = this.res.examples[gate];
    if (ex.length < MAX_VIOLATIONS) ex.push(`t=${(this.now / 1000).toFixed(1)}s ${text}`);
  }

  // ---- clients ----

  private spawn(spec: ClientSpec, index: number): void {
    const c = new Client(spec, index, (self) => this.routeOf(self));
    c.dashAt = this.now + this.script.range(1000, 6000);
    this.clients.set(spec.id, c);
    this.order.push(c);
  }

  private routeOf(c: Client): SignalRoute {
    return new SignalRoute({
      selfId: c.id,
      now: () => this.now,
      pos: () => [Math.round(c.x), Math.round(c.y), Math.round(c.r)],
      sign: () => 'sig',
      verify: () => true,
      linked: (id) => c.helloed(id),
      heard: (id) => c.gossip.heard(id, this.now),
      placeOf: (id) => c.fixes.get(id) ?? null,
      sendPeer: (via, m) => {
        if (!c.helloed(via)) return false;
        if (m.kind === 'offer' && m.from === c.id) {
          const a = c.out.get(m.to);
          if (a) a.relayed = true;
        }
        this.after(this.hop(), () => this.clients.get(via)?.route.fromPeer(c.id, m));
        return true;
      },
      sendHub: (to, kind, sdp) => this.hubSend(c, to, kind, sdp),
      deliver: (from, kind, _sdp, pos) => this.onSignal(c, from, kind, pos),
    });
  }

  private tick(): void {
    const dt = TICK_MS / 1000;
    for (const c of this.order) this.move(c, dt);
    for (const c of this.order) this.snapshots(c);
    for (const c of this.order) {
      this.report(c);
      this.sendGossip(c);
      c.route.tick();
      if ((this.tickIndex + c.phase) % 5 === 0 || c.dirty) this.plan(c);
      this.sample(c, dt);
    }
    this.pairs(this.order);
  }

  private move(c: Client, dt: number): void {
    const w = c.spec.walk;
    c.heading += this.script.range(-w.turn, w.turn) * dt;
    if (w.dash && this.now >= c.dashAt) {
      c.dashUntil = this.now + 500;
      c.dashAt = this.now + 2500 + this.script.range(0, 6000);
    }
    const speed = this.now < c.dashUntil ? w.speed + 60 : w.speed;
    c.vx = Math.cos(c.heading) * speed;
    c.vy = Math.sin(c.heading) * speed;
    c.x += c.vx * dt;
    c.y += c.vy * dt;
    const b = w.box;
    if (b) {
      if (c.x < b.x0 || c.x > b.x1) {
        c.x = clamp(c.x, b.x0, b.x1);
        c.heading = Math.PI - c.heading;
      }
      if (c.y < b.y0 || c.y > b.y1) {
        c.y = clamp(c.y, b.y0, b.y1);
        c.heading = -c.heading;
      }
    }
    if (w.grow) c.r *= 1 + w.grow * dt;
  }

  private snapshots(c: Client): void {
    for (const [id, link] of c.links) {
      const o = this.clients.get(id);
      if (!o || !link.hello) continue;
      c.fixes.set(id, { x: o.x, y: o.y, r: o.r, at: this.now });
    }
  }

  // ---- the directory ----

  private report(c: Client): void {
    const msg = c.reporter.update(
      { inWater: true, x: c.x, y: c.y, r: c.r, aoi: c.aoi(), now: this.now },
      c.leaf,
    );
    if (msg?.t !== 'where') return;
    c.hubMsgs.push(this.now);
    const sent = { x: c.x, y: c.y, r: c.r, aoi: c.aoi() };
    this.after(this.hubMs(), () => this.answerWhere(c, sent));
  }

  private answerWhere(c: Client, s: { x: number; y: number; r: number; aoi: number }): void {
    const { moved } = this.dir.report({ id: c.id, name: c.id, ...s, t: this.now });
    for (const m of moved) {
      const o = this.clients.get(m.id);
      if (o) this.after(this.hubMs(), () => (o.leaf = m.leaf));
    }
    const near = this.dir.near(c.id, this.now);
    if (!near) return;
    this.checkSwarm(c, s, near.swarm);
    this.after(this.hubMs(), () => {
      c.leaf = near.leaf;
      c.dirKnown = near.peers.map((p) => ({
        id: p.id,
        x: p.x,
        y: p.y,
        r: p.r,
        at: this.now - p.age,
        source: 'directory' as const,
      }));
      c.dirty = true;
    });
  }

  /** Gate 7: every creature too small to link within the AoI is in the swarm, up to its cap. */
  private checkSwarm(
    c: Client,
    s: { x: number; y: number; r: number; aoi: number },
    swarm: [number, number][],
  ) {
    const sent = new Set(swarm.map(([x, y]) => `${x},${y}`));
    const want: { d: number; key: string }[] = [];
    for (const id of this.dir.around(s.x, s.y, s.aoi)) {
      const m = id === c.id ? null : this.dir.member(id);
      if (!m || m.r >= s.r || linkTiers(s.r, m.r) || this.now - m.t > 30_000) continue;
      const wire = (v: number) => Math.round(v * 8) / 8;
      want.push({ d: Math.hypot(m.x - s.x, m.y - s.y), key: `${wire(m.x)},${wire(m.y)}` });
    }
    want.sort((a, b) => a.d - b.d);
    for (const w of want.slice(0, 64)) {
      if (!sent.has(w.key))
        this.violate('swarm', `${c.id}'s swarm lacks a small creature at ${w.key}`);
    }
  }

  // ---- signals ----

  private hubSend(c: Client, to: string, kind: SignalKind, sdp: string): void {
    c.hubMsgs.push(this.now);
    if (kind === 'offer') {
      const a = c.out.get(to);
      if (a) a.relayed = false;
    }
    this.after(this.hubMs(), () => {
      const dst = this.clients.get(to);
      if (!dst) return;
      if (!this.hubPasses(c.id, to)) {
        this.res.hub.refused++;
        if (kind === 'offer') this.failAttempt(c.out.get(to), true);
        return;
      }
      const at = this.dir.member(c.id);
      this.after(this.hubMs(), () =>
        dst.route.fromHub(c.id, kind, sdp, at ? [at.x, at.y, at.r] : undefined),
      );
    });
  }

  /** The hub relays within the pond or between members within max(Q) + 4,096 wu, or a duty pair. */
  private hubPasses(a: string, b: string): boolean {
    if (this.dutyPair(a, b)) return true;
    const d = this.dir.distance(a, b);
    const ma = this.dir.member(a);
    const mb = this.dir.member(b);
    if (d === null || !ma || !mb) return false;
    return d <= Math.max(queryRadius(ma.aoi), queryRadius(mb.aoi)) + RELAY_SLACK_WU;
  }

  private activeFights(): FightSpec[] {
    return (this.sc.fights ?? []).filter((f) => f.from <= this.now && this.now < f.until);
  }

  private dutyPair(a: string, b: string): boolean {
    return this.activeFights().some(
      (f) =>
        (f.witnesses.includes(a) && f.fighters.includes(b)) ||
        (f.witnesses.includes(b) && f.fighters.includes(a)),
    );
  }

  private onSignal(c: Client, from: string, kind: SignalKind, pos: Pos | null): void {
    if (pos) {
      c.signalKnown.set(from, {
        id: from,
        x: pos[0],
        y: pos[1],
        r: pos[2],
        at: this.now,
        source: 'signal',
      });
    }
    if (kind === 'answer') {
      const a = c.out.get(from);
      if (a?.state !== 'offer') return;
      a.state = 'ice';
      this.after(this.net.range(500, 2000), () => this.iceDone(a));
      return;
    }
    if (c.links.has(from)) return;
    const held = c.inn.get(from);
    if (held) {
      // The caller's offer again (its relay failed and the hub resent it): the answer may have been lost.
      if (held.state === 'offer') c.route.send(from, 'answer', 'sdp', held.cls);
      return;
    }
    const mine = c.out.get(from);
    if (mine) {
      // Glare: the lower id keeps its own offer, the higher answers.
      if (c.id < from) return;
      this.dropAttempt(mine);
    }
    const a = this.clients.get(from)?.out.get(c.id);
    if (a?.state !== 'offer') return;
    if (!this.admit(c, from, a.cls)) {
      this.refuse(c, from, a);
      return;
    }
    c.inn.set(from, a);
    this.checkCap(c);
    c.route.send(from, 'answer', 'sdp', a.cls);
  }

  /** The callee says no: the caller hears it after a hop (or through the hub, which costs a message) and backs off. */
  private refuse(c: Client, from: string, a: Attempt): void {
    const caller = this.clients.get(from);
    if (!caller) return;
    let ms = this.hop();
    if (!a.relayed) {
      c.hubMsgs.push(this.now);
      ms = this.hubMs() + this.hubMs();
    }
    this.after(ms, () => {
      caller.route.forget(c.id);
      this.failAttempt(a, true);
    });
  }

  /** By the caller's class (the offer carries it) or the callee's own, whichever is higher, against the links held. */
  private admit(c: Client, from: string, cls: LinkClass): boolean {
    this.replan(c);
    const classes = new Map(c.classes);
    if (cls < (classes.get(from) ?? NO_CLASS)) classes.set(from, cls);
    const plan = c.mgr.plan(classes, this.heldSet(c), this.now);
    if (!plan.connect.includes(from)) return false;
    c.classes = classes;
    this.evict(c, plan.evict);
    return true;
  }

  // ---- links ----

  private heldSet(c: Client): Set<string> {
    return new Set([...c.links.keys(), ...c.out.keys(), ...c.inn.keys()]);
  }

  private knownOf(c: Client): Known[] {
    const out: Known[] = [];
    for (const [id, f] of c.fixes) out.push({ id, ...f, source: 'snapshot' });
    out.push(...c.gossip.known(this.now));
    out.push(...c.dirKnown);
    for (const [id, k] of c.signalKnown) {
      if (this.now - k.at > 10_000) c.signalKnown.delete(id);
      else out.push(k);
    }
    return out;
  }

  private replan(c: Client) {
    const self: AoiSelf = { x: c.x, y: c.y, vx: c.vx, vy: c.vy, r: c.r, adultR: c.spec.adultR };
    const known = this.knownOf(c);
    const classes = c.mgr.classify(self, known, c.p0, c.classes);
    const plan = c.mgr.plan(classes, this.heldSet(c), this.now);
    c.classes = classes;
    c.crowded = plan.crowded;
    if (plan.crowded) c.crowdedAt = this.now;
    c.knownIds = new Set(known.map((k) => k.id));
    c.dirty = false;
    return plan;
  }

  private plan(c: Client): void {
    const plan = this.replan(c);
    this.evict(c, plan.evict);
    for (const id of c.waiting.keys()) if (!plan.connect.includes(id)) c.waiting.delete(id);
    // Dial pacing: P0 and P1 at once; others when a peer can carry the offer; the rest through the
    // hub, up to `HUB_DIALS_FREE` links held, then one a plan, so the first link's gossip can carry the rest.
    let hubDials = 0;
    let dials = 0;
    for (const id of plan.connect) {
      if (c.links.has(id) || c.out.has(id) || c.inn.has(id)) continue;
      const cls = c.classes.get(id) ?? 5;
      // A refusal holds off a P3 or P4 call; P0 to P2 are always asked again.
      if (cls > 2 && (c.refusedUntil.get(id) ?? 0) > this.now) continue;
      const urgent = cls <= 1;
      // A creature just hatched dials at once: it has no links to carry its offers.
      const young = this.now - c.spec.spawnAt < YOUNG_MS;
      if (!urgent && !young) {
        if (dials >= DIALS_PER_PLAN) continue;
        if (cls === 4 && this.fixAge(c, id) > FRESH_DIAL_MS) continue;
        if (c.id > id) {
          const since = c.waiting.get(id) ?? this.now;
          c.waiting.set(id, since);
          if (this.now - since < LOWER_CALLS_MS) continue;
        }
        const relayable = c.gossip.heard(id, this.now).some((h) => c.helloed(h.via));
        if (!relayable) {
          if (this.heldSet(c).size >= HUB_DIALS_FREE && (hubDials >= 1 || this.hubInFlight(c)))
            continue;
          hubDials++;
        }
        dials++;
      }
      this.call(c, id, urgent);
    }
    this.checkCap(c);
  }

  /** Whether one of this client's offers is out through the hub and unanswered. */
  private hubInFlight(c: Client): boolean {
    for (const a of c.out.values()) if (a.state === 'offer' && !a.relayed) return true;
    return false;
  }

  /** How old the newest fix of a creature is, whatever its source (ms). */
  private fixAge(c: Client, id: string): number {
    let at = c.fixes.get(id)?.at ?? Number.NEGATIVE_INFINITY;
    at = Math.max(at, c.signalKnown.get(id)?.at ?? at);
    for (const h of c.gossip.heard(id, this.now)) at = Math.max(at, h.fix.at);
    for (const k of c.dirKnown) if (k.id === id) at = Math.max(at, k.at);
    return this.now - at;
  }

  /** An urgent call (P0, P1) goes through the hub: a peer's relay that fails silently costs 4 s of a 3 s lead. */
  private call(c: Client, to: string, urgent: boolean): void {
    const a: Attempt = {
      from: c.id,
      to,
      state: 'offer',
      relayed: false,
      cls: (c.classes.get(to) ?? 4) as LinkClass,
    };
    c.out.set(to, a);
    this.after(OFFER_TIMEOUT_MS, () => {
      if (a.state === 'offer') this.failAttempt(a, true);
    });
    c.route.send(to, 'offer', 'sdp', a.cls, urgent);
  }

  private evict(c: Client, ids: string[]): void {
    for (const id of ids) {
      const link = c.links.get(id);
      if (link) this.popCheck(c, id);
      this.close(c, id);
    }
  }

  /** Gate 3: a link closed to a creature in view, while both are within each other's AoI. */
  private popCheck(c: Client, id: string): void {
    const o = this.clients.get(id);
    if (!o || !c.helloed(id)) return;
    const d = Math.hypot(o.x - c.x, o.y - c.y);
    const inView = d <= c.view() || d <= o.view();
    if (!inView || d > Math.min(c.aoi(), o.aoi()) || !linkTiers(c.r, o.r)) return;
    if (c.crowded || o.crowded || c.heavy() >= 24 || o.heavy() >= 24) return;
    this.violate('pops', `${c.id} closed the link to ${id} in view at ${Math.round(d)} wu`);
  }

  private close(c: Client, id: string): void {
    const o = this.clients.get(id);
    for (const [x, y] of [
      [c, id],
      [o, c.id],
    ] as const) {
      if (!x) continue;
      x.links.delete(y);
      const out = x.out.get(y);
      if (out) this.dropAttempt(out);
      const inn = x.inn.get(y);
      if (inn) this.dropAttempt(inn);
      x.gossip.drop(y);
      x.route.forget(y);
      x.fixes.delete(y);
    }
  }

  private dropAttempt(a: Attempt): void {
    a.state = 'dead';
    const from = this.clients.get(a.from);
    const to = this.clients.get(a.to);
    if (from?.out.get(a.to) === a) from.out.delete(a.to);
    if (to?.inn.get(a.from) === a) to.inn.delete(a.from);
  }

  private failAttempt(a: Attempt | undefined, backoff: boolean): void {
    if (!a || a.state === 'dead') return;
    this.dropAttempt(a);
    const from = this.clients.get(a.from);
    if (backoff && from) {
      const n = from.refusals.get(a.to) ?? 0;
      from.refusals.set(a.to, n + 1);
      from.refusedUntil.set(
        a.to,
        this.now + Math.min(REFUSED_BACKOFF_MAX_MS, REFUSED_BACKOFF_MS * 2 ** n),
      );
    }
  }

  private iceDone(a: Attempt): void {
    if (a.state !== 'ice') return;
    this.dropAttempt(a);
    if (this.net.next() < ICE_FAIL) return;
    const from = this.clients.get(a.from);
    const to = this.clients.get(a.to);
    if (!from || !to) return;
    const link = (): Link => ({ hello: false, helloAt: 0, relayed: a.relayed });
    from.links.set(a.to, link());
    to.links.set(a.from, link());
    this.after(2 * this.hop(), () => this.hello(from, to));
  }

  private hello(a: Client, b: Client): void {
    const la = a.links.get(b.id);
    const lb = b.links.get(a.id);
    if (!la || !lb) return;
    a.refusals.delete(b.id);
    b.refusals.delete(a.id);
    la.hello = lb.hello = true;
    la.helloAt = lb.helloAt = this.now;
    const pair = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
    if (this.sc.friends && !this.firstLink.has(pair)) {
      this.firstLink.add(pair);
      this.res.friendMs.push(this.now - Math.max(a.spec.spawnAt, b.spec.spawnAt));
    }
    if (this.now - Math.max(a.spec.spawnAt, b.spec.spawnAt) >= LATE_AFTER_MS) {
      this.res.lateLinks++;
      if (la.relayed) this.res.lateRelayed++;
    }
    a.dirty = b.dirty = true;
  }

  // ---- gossip ----

  private sendGossip(c: Client): void {
    const linked = [...c.links].filter(([, l]) => l.hello).map(([id]) => id);
    for (const [to, ev] of c.gossip.due(linked, c.fixes, this.now)) {
      this.res.gossipBytes += byteLength(JSON.stringify(ev));
      this.after(this.hop(), () => this.hearGossip(to, c.id, ev));
    }
  }

  private hearGossip(to: string, from: string, ev: PeersEvent): void {
    const c = this.clients.get(to);
    if (c?.helloed(from)) c.gossip.receive(from, ev, this.now);
  }

  // ---- fights ----

  private duty(f: FightSpec, on: boolean): void {
    const ids = [...f.fighters, ...f.witnesses];
    for (const id of ids) {
      const c = this.clients.get(id);
      if (!c) continue;
      const mates = f.witnesses.includes(id) ? f.fighters : ids.filter((o) => o !== id);
      for (const m of mates) {
        if (on) c.p0.add(m);
        else c.p0.delete(m);
      }
      c.dirty = true;
    }
  }

  /** Gate 8: every duty link is taken within 10 s of the fight's start, and held to its end. */
  private checkDuty(f: FightSpec, when: 'taken' | 'held'): void {
    for (const w of f.witnesses) {
      const wc = this.clients.get(w);
      if (!wc) continue;
      for (const id of f.fighters) {
        if (when === 'taken') this.res.duties++;
        const ok = wc.helloed(id);
        if (ok && when === 'taken') this.res.dutiesTaken++;
        if (ok) continue;
        const text = `witness ${w} has no link to fighter ${id} (${when}), P0+P1 ${wc.heavy()}`;
        if (wc.heavy() <= 28) this.violate('duty', text);
      }
    }
  }

  // ---- measurements ----

  private checkCap(c: Client): void {
    const held = this.heldSet(c).size;
    this.res.maxHeld = Math.max(this.res.maxHeld, held);
    if (held > 32) this.violate('cap', `${c.id} holds ${held} links`);
    else if (held > 24 && c.heavy() <= 24 && !c.crowded) {
      this.violate('cap', `${c.id} holds ${held} links with P0+P1 = ${c.heavy()}`);
    }
    if (this.activeFights().length > 0 && held > 32)
      this.violate('dutyCap', `${c.id} holds ${held}`);
  }

  private sample(c: Client, dt: number): void {
    let n = 0;
    for (const l of c.links.values()) if (l.hello) n++;
    const bin = Math.min(32, n);
    this.res.linkHistogram[bin] = (this.res.linkHistogram[bin] ?? 0) + 1;
    this.res.linkSeconds += n * dt;
    this.res.clientSeconds += dt;
    if (c.crowded) this.res.crowdedSeconds += dt;
  }

  private cellKey = (cx: number, cy: number) => cy * 256 + cx;

  /** Pair measurements from true positions: discovery, hidden threats, views, tier links. */
  private pairs(all: Client[]): void {
    const CELL = 2048;
    const grid = new Map<number, Client[]>();
    for (const c of all) {
      const k = this.cellKey(Math.floor(c.x / CELL), Math.floor(c.y / CELL));
      const cell = grid.get(k);
      if (cell) cell.push(c);
      else grid.set(k, [c]);
    }
    const checks: [Client, Client, number][] = [];
    const entries: [Client, Client][] = [];
    for (const a of all) a.p1True = 0;
    for (const a of all) {
      const q = queryRadius(a.aoi());
      const view = a.view();
      const near = new Set<string>();
      const x0 = Math.max(0, Math.floor((a.x - q) / CELL));
      const x1 = Math.min(127, Math.floor((a.x + q) / CELL));
      const y0 = Math.max(0, Math.floor((a.y - q) / CELL));
      const y1 = Math.min(127, Math.floor((a.y + q) / CELL));
      const inView = new Set<string>();
      for (let cy = y0; cy <= y1; cy++) {
        for (let cx = x0; cx <= x1; cx++) {
          for (const b of grid.get(this.cellKey(cx, cy)) ?? []) {
            if (b === a) continue;
            const d = Math.hypot(b.x - a.x, b.y - a.y);
            if (d > q * 1.1) continue;
            near.add(b.id);
            this.discover(a, b, d, q);
            if (d <= view) inView.add(b.id);
            if (d <= INTERACT_RADII * Math.max(a.r, b.r) + INTERACT_LEAD_WU && linkTiers(a.r, b.r))
              a.p1True++;
            if (a.id < b.id) checks.push([a, b, d]);
          }
        }
      }
      for (const id of inView) {
        if (!a.viewSet.has(id)) entries.push([a, this.clients.get(id) as Client]);
      }
      a.viewSet = inView;
      for (const id of [...a.entered.keys()]) {
        if (!near.has(id)) {
          a.entered.delete(id);
          a.found.delete(id);
        }
      }
    }
    for (const [a, b, d] of checks) this.pairChecks(a, b, d);
    for (const [a, b] of entries) this.entered(a, b);
    this.tierLinks(all);
  }

  private discover(a: Client, b: Client, d: number, q: number): void {
    if (!linkTiers(a.r, b.r) || d > q) return;
    if (!a.entered.has(b.id))
      a.entered.set(b.id, Math.max(this.now, b.spec.spawnAt, a.spec.spawnAt));
    if (!a.found.has(b.id) && a.knownIds.has(b.id)) {
      a.found.add(b.id);
      this.res.discoveryMs.push(this.now - (a.entered.get(b.id) as number));
    }
  }

  private pairChecks(a: Client, b: Client, d: number): void {
    const key = `${a.id}|${b.id}`;
    const reach = INTERACT_RADII * Math.max(a.r, b.r);
    if (!linkTiers(a.r, b.r)) {
      this.p1Since.delete(key);
      return;
    }
    if (d <= reach + INTERACT_LEAD_WU) {
      if (!this.p1Since.has(key)) this.p1Since.set(key, this.now);
    } else if (d > reach + 900) this.p1Since.delete(key);
    const since = this.p1Since.get(key);
    if (since === undefined || d > reach || this.now - since < SETUP_GRACE_MS) return;
    if (a.helloed(b.id) && b.helloed(a.id)) return;
    if (this.settling(a) || this.settling(b)) return;
    this.violate(
      'hidden',
      `${a.id} and ${b.id} are ${Math.round(d)} wu apart (reach ${Math.round(reach)}) and not linked`,
    );
  }

  /** A creature that is crowded, or has the room under 24 full of P1 by true positions, is excused. */
  private settling(c: Client): boolean {
    return c.crowded || c.p1True >= 24 || this.now - c.crowdedAt < CROWD_SETTLE_MS;
  }

  private entered(a: Client, b: Client): void {
    if (!linkTiers(a.r, b.r)) return;
    if (this.now - a.spec.spawnAt < YOUNG_MS || this.now - b.spec.spawnAt < YOUNG_MS) return;
    if (this.settling(a) || this.settling(b) || a.heavy() >= 24) return;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 1;
    const closing = -((dx * (b.vx - a.vx) + dy * (b.vy - a.vy)) / d);
    if (closing > LATE_CLOSING) return;
    this.res.entries++;
    const l = a.links.get(b.id);
    if (l?.hello && this.now - l.helloAt >= 500) this.res.entriesLinked++;
    else
      this.violate(
        'late',
        `${b.id} came into ${a.id}'s view unlinked (closing ${Math.round(closing)} wu/s)`,
      );
  }

  /** Gate 7: no link between creatures two tiers apart, outside P0, for more than 4 s. */
  private tierLinks(all: Client[]): void {
    for (const a of all) {
      for (const [id, l] of a.links) {
        if (!l.hello || a.id > id) continue;
        const b = this.clients.get(id);
        const key = `${a.id}|${id}`;
        if (!b || linkTiers(a.r, b.r) || a.p0.has(id)) {
          this.badSince.delete(key);
          continue;
        }
        const since = this.badSince.get(key) ?? this.now;
        this.badSince.set(key, since);
        if (this.now - since > 4000)
          this.violate('tierLink', `${a.id} and ${id} are linked across two tiers`);
      }
    }
  }

  private finish(c: Client): void {
    // Authority messages per player-minute: each full minute of the creature's life.
    const from = c.spec.spawnAt;
    for (let t = from; t + 60_000 <= this.sc.seconds * 1000; t += 60_000) {
      const n = c.hubMsgs.filter((m) => m >= t && m < t + 60_000).length;
      (t === from ? this.res.joinMinute : this.res.perMinute).push(n);
    }
  }
}
