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
import { poolOf } from '../src/ledger/witness';
import {
  AoiManager,
  type AoiSelf,
  aoiRadius,
  INTERACT_LEAD_WU,
  INTERACT_RADII,
  type Known,
  p1Reach,
  queryRadius,
} from '../src/net/aoi';
import { type LinkClass, NO_CLASS } from '../src/net/connection-policy';
import { type Fix, Gossip, type PeersEvent } from '../src/net/gossip';
import { CROWD_AT, OPEN_WATER, sameWater } from '../src/net/instance';
import { SIGN_EVERY } from '../src/net/pond-sync';
import {
  byteLength,
  type Leaf,
  type Pos,
  SIGNED_FRAME_BYTES,
  type SignalKind,
  SNAPSHOT_BYTES,
} from '../src/net/protocol';
import { SignalRoute } from '../src/net/signal-route';
import { FULL_RATE, wantedRate } from '../src/net/snapshot-rates';
import { crowdList, WHERE_EVERY_MS, WhereReporter } from '../src/net/where';
import { clamp } from '../src/sim/math';
import { createRng, type Rng, seedFromString } from '../src/sim/prng';
import { RULES, TICK_HZ } from '../src/sim/rules';
import { linkTiers, sizeTier, viewHalfHeight } from '../src/sim/size';
import { type CrowdContext, Crowds, type Moved } from '../worker/crowds';
import { Directory, RELAY_SLACK_WU } from '../worker/directory';
import {
  clearance,
  groupsFor,
  inSpawnBand,
  type Placed,
  type Placement,
  place,
  SPAWN_RECENT_MS,
} from '../worker/placement';
import { EventQueue, type Meter, type MsgType, type Op } from './aoi-meter';
import {
  type Box,
  type ClientSpec,
  type FightSpec,
  GATE_KEYS,
  type GateKey,
  type RunResult,
  type Scenario,
} from './aoi-types';
import { type Arrival, emptyWave, type WaveRecord } from './wave-record';

const TICK_MS = 100;
/** The world's centre: scenarios lay their creatures out around it (ADR 0061). */
export const CENTRE = 131_072;
const WORLD = 262_144;
/** The half-diagonal of a 16:9 view, in view half-heights. */
const VIEW_DIAG = Math.hypot(1, 16 / 9);
/** A pair that has been within P1 reach this long must be linked (gate 2). */
const SETUP_GRACE_MS = 10_000;
/**
 * A pair that knows each other only from the directory has this long (the wave, ADR 0066): the
 * directory's word of a creature is up to one `where` interval old (30 s), and nothing else tells
 * two lone creatures that they have closed.
 */
const DIRECTORY_GRACE_MS = SETUP_GRACE_MS + WHERE_EVERY_MS;
/** Gate 3 holds for newcomers closing at most this fast (relative, wu/s): the P1 lead gives 6 s at 100. */
const LATE_CLOSING = 100;
/** A link made this long after the later spawn counts as a later link (gate 5's relay share). */
const LATE_AFTER_MS = 60_000;
/** A crowded flag settles this long after the last plan that set it. */
const CROWD_SETTLE_MS = 10_000;
const ICE_FAIL = 0.05;
/** A client alone this long may ride the current (M12 T7's `RIDE_ALONE_MS`, 120 s). */
export const RIDE_ALONE_MS = 120_000;
/** Gate 10 starts to count a client this long after its spawn. */
export const CROWD_GRACE_MS = 10_000;
/** What carries each state frame (B): IPv4 20, UDP 8, a DTLS record 37 (header, nonce, tag), SCTP 28. */
export const FRAME_OVERHEAD_BYTES = 93;
const MAX_VIOLATIONS = 8;
/** The hub refuses a ride this long after the rider's last fight ended (`RIDE_AFTER_FIGHT_MS` in `worker/fights.ts`). */
export const RIDE_AFTER_FIGHT_MS = 120_000;

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
  /** Its instance, as the hub last told it (M12); 0 is the open water. */
  n = OPEN_WATER;
  changes = 0;
  joined = false;
  waterAt = Number.NEGATIVE_INFINITY;
  /** Since when the directory has named no peer for it, null while it has one. */
  aloneSince: number | null = null;
  /** The box it bounces in: a ride takes it out. */
  box: Box | undefined;
  /** It has left the water (`ClientSpec.leaveAt`). */
  left = false;
  leftAt = Number.POSITIVE_INFINITY;
  /** When its last fight ended (ms). */
  fightEnd = Number.NEGATIVE_INFINITY;
  /** The wave's record of its last arrival, and the ids of the group it was placed around. */
  arrival: Arrival | null = null;
  groupIds: Set<string> | null = null;
  readonly links = new Map<string, Link>();
  readonly out = new Map<string, Attempt>();
  readonly inn = new Map<string, Attempt>();
  readonly fixes = new Map<string, Fix>();
  dirKnown: Known[] = [];
  readonly signalKnown = new Map<string, Known>();
  /** The freshest word of each creature's instance, from whatever source (the page's `CrowdView`). */
  readonly words = new Map<string, { n: number; at: number }>();
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
  /** Whether the pair checks judge it (all, or a seeded sample). */
  judged = true;
  /** Bytes per second the links sent to it in this tick (the meter). */
  rx = 0;
  tx = 0;
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
    sample: number,
  ) {
    this.mgr = new AoiManager({ selfId: spec.id });
    this.gossip = new Gossip(spec.id);
    this.x = spec.x;
    this.y = spec.y;
    this.r = spec.r;
    this.heading = spec.walk.heading;
    this.box = spec.walk.box;
    this.phase = index % 5;
    this.judged = sample >= 1 || (Math.imul(index + 1, 2654435761) >>> 0) / 2 ** 32 < sample;
    this.route = route(this);
  }
  get id(): string {
    return this.spec.id;
  }
  aoi(): number {
    return aoiRadius(this.r, this.spec.adultR);
  }
  view(): number {
    return VIEW_DIAG * this.viewHalf();
  }
  private viewR = Number.NaN;
  private viewH = 0;
  /** The half-height of its view, kept while its radius stays (it is asked of every link every tick). */
  viewHalf(): number {
    if (this.r !== this.viewR) {
      this.viewR = this.r;
      this.viewH = viewHalfHeight(this.r, this.spec.adultR);
    }
    return this.viewH;
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
  private readonly events = new EventQueue<{ t: number; seq: number; fn: () => void }>();
  private readonly clients = new Map<string, Client>();
  private readonly order: Client[] = [];
  private readonly dir = new Directory(WORLD);
  private readonly script: Rng;
  private readonly net: Rng;
  private readonly res: RunResult;
  private readonly crowds: Crowds | null;
  private readonly fights: FightSpec[];
  private readonly fightWater = new Map<FightSpec, number[]>();
  private readonly placeRng: Rng;
  private readonly wave: WaveRecord | null;
  /** The wave's counters since the last minute mark: spawns, rides and authority messages. */
  private minuteSpawns = 0;
  private minuteRides = 0;
  private minuteMsgs = 0;
  private readonly spawns: { x: number; y: number; r: number; aoi: number; t: number }[] = [];
  private readonly p1Since = new Map<string, number>();
  private readonly badSince = new Map<string, number>();
  private readonly firstLink = new Set<string>();
  private tickIndex = 0;
  /** A route's `tick` resends its unanswered offers through the hub. */
  private resending = false;
  private readonly meter: Meter | null;

  constructor(
    private readonly sc: Scenario,
    seed: string,
  ) {
    const s = seedFromString(`aoi|${sc.name}|${seed}`);
    this.script = createRng(s, 'script');
    this.net = createRng(s, 'net');
    this.placeRng = createRng(s, 'place');
    this.meter = sc.meter ?? null;
    this.crowds = sc.instances === false ? null : new Crowds();
    this.wave = sc.wave ? emptyWave(sc.wave) : null;
    this.fights = (sc.fights ?? []).map((f) => ({ ...f, fighters: [...f.fighters] }));
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
      upload24: 0,
      upload24Sum: 0,
      upload24Samples: 0,
      linkUpload: 0,
      crowdedSeconds: 0,
      clientSeconds: 0,
      instances: sc.instances !== false,
      crowdedLate: 0,
      clientLate: 0,
      changesPerMinute: [],
      spawns: 0,
      spawnFallbacks: 0,
      rides: 0,
      duties: 0,
      dutiesTaken: 0,
      entries: 0,
      entriesLinked: 0,
      hub: { relayed: 0, hub: 0, fallback: 0, refused: 0 },
    };
    if (this.wave) this.res.wave = this.wave;
    sc.clients.forEach((spec, i) => {
      this.after(spec.spawnAt, () => this.spawn(spec, i));
      if (spec.leaveAt !== undefined) this.after(spec.leaveAt, () => this.leave(spec.id));
    });
    for (const f of this.fights) {
      this.after(f.from, () => this.startFight(f));
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
      if (this.sc.progress && this.now % 60_000 === 0)
        this.sc.progress(this.now / 60_000, this.order.length);
    }
    for (const c of this.order) this.retire(c);
    if (this.wave) {
      this.wave.fights = this.fights.map((f) => ({
        fighters: [...f.fighters],
        from: f.from,
        until: f.until,
      }));
    }
    return this.res;
  }

  // ---- time ----

  private after(ms: number, fn: () => void): void {
    this.events.push({ t: this.now + Math.max(0, ms), seq: this.seq++, fn });
  }

  private runEvents(): void {
    for (let e = this.events.peek(); e && e.t <= this.now; e = this.events.peek()) {
      (this.events.pop() as { fn: () => void }).fn();
    }
  }

  private hop = () => this.net.range(30, 80);
  private hubMs = () => this.net.range(50, 150);

  private violate(gate: GateKey, text: string): void {
    this.res.violations[gate]++;
    const ex = this.res.examples[gate];
    if (ex.length < MAX_VIOLATIONS) ex.push(`t=${(this.now / 1000).toFixed(1)}s ${text}`);
  }

  /** Times a hub operation when the scenario carries a meter. */
  private timed<T>(op: Op, fn: () => T): T {
    return this.meter ? this.meter.time(op, fn) : fn();
  }

  // ---- clients ----

  private spawn(spec: ClientSpec, index: number): void {
    const c = new Client(spec, index, (self) => this.routeOf(self), this.sc.pairSample ?? 1);
    if (spec.place) {
      const at = this.placeFor(c) as Placement;
      c.x = at.x;
      c.y = at.y;
      this.hubMsg(c, 'spawn');
      this.hubReport(c);
    }
    c.dashAt = this.now + this.script.range(1000, 6000);
    this.clients.set(spec.id, c);
    this.order.push(c);
  }

  /** A message the authority receives from `c` (the budget gate's count). */
  private hubMsg(c: Client, type: MsgType): void {
    c.hubMsgs.push(this.now);
    this.minuteMsgs++;
    if (this.meter) this.meter.msgs[type]++;
  }

  /** `c` leaves the water: its links close, the hub drops it from the directory and the crowds. */
  private leave(id: string): void {
    const c = this.clients.get(id);
    if (!c || c.left) return;
    // Closing a tab never cancels a fight (M8): a fighter's leave waits for the fight's end.
    const fight = this.activeFights().find((f) => f.fighters.includes(id));
    if (fight) {
      this.after(fight.until - this.now + TICK_MS, () => this.leave(id));
      return;
    }
    for (const other of [...c.links.keys()]) this.close(c, other);
    for (const a of [...c.out.values(), ...c.inn.values()]) this.dropAttempt(a);
    c.left = true;
    c.leftAt = this.now;
    for (const m of this.dir.remove(id)) {
      const o = this.clients.get(m.id);
      if (o) this.after(this.hubMs(), () => (o.leaf = m.leaf));
    }
    if (this.crowds) this.told(this.crowds.remove(id, this.now, this.ctx));
    this.order.splice(this.order.indexOf(c), 1);
    this.clients.delete(id);
    if (this.meter) this.meter.msgs.gone++;
    // Its numbers are final: they are taken now, so a long run doesn't hold every client it ever had.
    this.retire(c);
  }

  /** A client's counters go into the result, once: when it leaves or the run ends. */
  private retire(c: Client): void {
    this.finish(c);
    const s = c.route.stats();
    this.res.hub.relayed += s.relayed;
    this.res.hub.hub += s.hub;
    this.res.hub.fallback += s.fallback;
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
    this.settleCrowds();
    for (const c of this.order) this.move(c, dt);
    for (const c of this.order) this.snapshots(c);
    for (const c of this.order) {
      this.report(c);
      this.sendGossip(c);
      this.resending = true;
      c.route.tick();
      this.resending = false;
      if ((this.tickIndex + c.phase) % 5 === 0 || c.dirty) this.plan(c);
      this.sample(c, dt);
    }
    if (this.meter && this.tickIndex % (this.sc.rateEvery ?? 1) === 0) {
      for (const c of this.order) {
        this.meter.rate(c.tx, c.rx);
        c.tx = c.rx = 0;
      }
    }
    if (this.tickIndex % (this.sc.pairsEvery ?? 1) === 0) this.pairs(this.order);
    this.checkFightWater();
    if (this.sc.ride) for (const c of this.order) this.maybeRide(c);
    if (this.wave) this.recordWave();
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
    const b = c.box;
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
      // The fix and the word are updated in place: this runs for every link every tick.
      const fix = c.fixes.get(id);
      if (fix) {
        fix.x = o.x;
        fix.y = o.y;
        fix.r = o.r;
        fix.at = this.now;
        fix.n = o.n;
      } else c.fixes.set(id, { x: o.x, y: o.y, r: o.r, at: this.now, n: o.n });
      const word = c.words.get(id);
      if (word) {
        word.n = o.n;
        word.at = this.now;
      } else c.words.set(id, { n: o.n, at: this.now });
    }
  }

  // ---- the directory ----

  private report(c: Client): void {
    // A page whose wanted P0 + P1 that share its water reach `CROWD_AT` is crowded: its `where` carries its crowd.
    const crowd =
      this.crowds !== null && c.heavy() >= CROWD_AT
        ? () => crowdList(c.id, { x: c.x, y: c.y, r: c.r, n: c.n }, c.fixes)
        : null;
    const msg = c.reporter.update(
      { inWater: true, x: c.x, y: c.y, r: c.r, aoi: c.aoi(), now: this.now },
      c.leaf,
      crowd,
    );
    if (msg?.t !== 'where') return;
    this.hubMsg(c, msg.crowd ? 'whereCrowd' : 'where');
    const sent = { x: c.x, y: c.y, r: c.r, aoi: c.aoi() };
    const list = msg.crowd ?? null;
    this.after(this.hubMs(), () => this.answerWhere(c, sent, list));
  }

  /** The hub takes a report: the directory, then the crowds (a list of ids that aren't seated is cut). */
  private hubReport(
    c: Client,
    crowd: readonly string[] | null = null,
    s: { x: number; y: number; r: number; aoi: number } = { x: c.x, y: c.y, r: c.r, aoi: c.aoi() },
  ): void {
    if (c.left) return;
    const { moved } = this.dir.report({ id: c.id, name: c.id, ...s, t: this.now });
    for (const m of moved) {
      const o = this.clients.get(m.id);
      if (o) this.after(this.hubMs(), () => (o.leaf = m.leaf));
    }
    if (this.crowds === null) return;
    const seated = crowd?.filter((id) => id === c.id || this.dir.member(id)) ?? null;
    this.told(this.crowds.report({ id: c.id, x: s.x, y: s.y, r: s.r }, seated, this.now, this.ctx));
  }

  private answerWhere(
    c: Client,
    s: { x: number; y: number; r: number; aoi: number },
    crowd: readonly string[] | null,
  ): void {
    if (c.left) return;
    const near = this.timed('where', () => {
      this.hubReport(c, crowd, s);
      return this.dir.near(c.id, this.now, (id) => this.inst(id));
    });
    if (!near) return;
    c.aloneSince = near.peers.length === 0 ? (c.aloneSince ?? this.now) : null;
    this.checkSwarm(c, s, near.swarm);
    this.after(this.hubMs(), () => {
      for (const p of near.peers) c.words.set(p.id, { n: p.n, at: this.now });
      c.leaf = near.leaf;
      c.dirKnown = near.peers.map((p) => ({
        id: p.id,
        x: p.x,
        y: p.y,
        r: p.r,
        at: this.now - p.age,
        n: p.n,
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
      if (!sameWater(this.inst(c.id), this.inst(id))) continue;
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
    this.hubMsg(c, this.resending ? 'resend' : kind);
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

  /** The hub relays between members within max(Q) + 4,096 wu, or a duty pair (M11 T14). */
  private hubPasses(a: string, b: string): boolean {
    return this.timed('signal', () => this.reaches(a, b));
  }

  private reaches(a: string, b: string): boolean {
    if (this.dutyPair(a, b)) return true;
    if (!sameWater(this.inst(a), this.inst(b))) return false;
    const d = this.dir.distance(a, b);
    const ma = this.dir.member(a);
    const mb = this.dir.member(b);
    if (d === null || !ma || !mb) return false;
    return d <= Math.max(queryRadius(ma.aoi), queryRadius(mb.aoi)) + RELAY_SLACK_WU;
  }

  /** The fights running now, kept for the tick: the crowds ask for them once per member. */
  private activeAt = Number.NaN;
  private active: FightSpec[] = [];

  private activeFights(): FightSpec[] {
    if (this.activeAt !== this.now) {
      this.activeAt = this.now;
      this.active = this.fights.filter((f) => f.from <= this.now && this.now < f.until);
    }
    return this.active;
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
      this.hubMsg(c, 'refuse');
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
    // Each sighting carries the freshest word of its creature's instance.
    return out.map((k) => {
      const w = c.words.get(k.id);
      return w ? { ...k, n: w.n } : k;
    });
  }

  private replan(c: Client) {
    const self: AoiSelf = {
      x: c.x,
      y: c.y,
      vx: c.vx,
      vy: c.vy,
      r: c.r,
      adultR: c.spec.adultR,
      n: c.n,
    };
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
    this.closeApart(c);
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
    if (!this.shares(c.id, id) || this.watered(c) || this.watered(o)) return;
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
    if (this.meter) {
      this.meter.setups++;
      if (la.relayed) this.meter.setupsRelayed++;
    }
    this.noteLink(a, b);
    this.noteLink(b, a);
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
    if (c?.helloed(from)) c.gossip.receive(from, ev, this.now, c.n);
  }

  // ---- fights ----

  private duty(f: FightSpec, on: boolean): void {
    const ids = [...f.fighters, ...f.witnesses];
    for (const id of ids) {
      const c = this.clients.get(id);
      if (!c) continue;
      if (!on && f.fighters.includes(id)) c.fightEnd = this.now;
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

  // ---- instances, placement and rides (M12) ----

  /** A client's instance by the hub's crowds (0 without them). */
  private inst(id: string): number {
    return this.crowds?.instanceOf(id) ?? OPEN_WATER;
  }

  private shares(a: string, b: string): boolean {
    return sameWater(this.inst(a), this.inst(b));
  }

  /** What the crowds need of the hub: a fight's fighters are locked and each other's partners. */
  private readonly ctx: CrowdContext = {
    locked: (id) => this.activeFights().some((f) => f.fighters.includes(id)),
    partners: (id) => {
      const f = this.activeFights().find((g) => g.fighters.includes(id));
      return f ? f.fighters.filter((o) => o !== id) : [];
    },
    around: (x, y, radius) =>
      this.dir.around(x, y, radius).flatMap((id) => {
        const m = this.dir.member(id);
        return m ? [{ id, x: m.x, y: m.y, r: m.r }] : [];
      }),
  };

  /** Each member whose instance changed hears it after the hub's latency. */
  private told(moved: readonly Moved[]): void {
    for (const m of moved) {
      const o = this.clients.get(m.id);
      if (o) this.after(this.hubMs(), () => this.setWater(o, this.inst(o.id)));
    }
  }

  private setWater(c: Client, n: number): void {
    if (c.n === n) return;
    // The first instance a creature joins is its entry; what follows is a change (gate 10).
    if (c.joined) c.changes++;
    c.joined = true;
    c.n = n;
    c.waterAt = this.now;
    c.reporter.nudge();
    c.dirty = true;
  }

  /** The hub's one crowd timer: what is due settles. */
  private settleCrowds(): void {
    if (!this.crowds) return;
    const due = this.crowds.due();
    if (due !== null && due <= this.now) {
      const crowds = this.crowds;
      this.told(this.timed('split', () => crowds.settle(this.now, this.ctx)));
    }
  }

  /** A link that no longer shares water closes at once, unless it is a duty link (P0). */
  private closeApart(c: Client): void {
    if (this.crowds === null) return;
    for (const id of c.links.keys()) {
      const f = c.fixes.get(id);
      if (f && !c.p0.has(id) && !sameWater(c.n, f.n ?? OPEN_WATER)) this.close(c, id);
    }
  }

  /** An engage picks its target: the nearest comparable creature sharing the attacker's water. */
  private startFight(f: FightSpec): void {
    const a =
      f.engage && f.fighters.length === 1 ? this.clients.get(f.fighters[0] as string) : null;
    if (a) {
      const taken = new Set(
        this.activeFights().flatMap((g) => [...g.fighters, ...(g === f ? f.witnesses : [])]),
      );
      let best: Client | null = null;
      let near = Number.POSITIVE_INFINITY;
      for (const o of this.order) {
        if (o === a || taken.has(o.id) || !linkTiers(a.r, o.r) || !this.shares(a.id, o.id))
          continue;
        const d = Math.hypot(o.x - a.x, o.y - a.y);
        if (d < near) [best, near] = [o, d];
      }
      if (best) f.fighters.push(best.id);
    }
    this.fightWater.set(
      f,
      f.fighters.map((id) => this.inst(id)),
    );
    if (this.meter) {
      const present = this.order.map((o) => o.id);
      this.timed('pool', () => poolOf(present, `fight|${f.from}|${f.fighters.join(',')}`));
    }
    this.duty(f, true);
  }

  /** Gate 10: a fight's fighters share water and keep their instance for the whole fight. */
  private checkFightWater(): void {
    for (const f of this.activeFights()) {
      const start = this.fightWater.get(f);
      if (!start) continue;
      f.fighters.forEach((id, i) => {
        if (this.inst(id) !== start[i])
          this.violate('fightWater', `${id} changed instance during a fight`);
      });
      const [a, b] = f.fighters;
      if (a && b && !this.shares(a, b))
        this.violate('fightWater', `fighters ${a} and ${b} do not share water`);
    }
  }

  /**
   * Where `c` enters the water, by `place()` over the directory's positions as the hub knows them
   * (gate 11: the clearance from every engage-capable member). A ride with no group to ride to gets
   * null.
   */
  private placeFor(c: Client, ride = false): Placement | null {
    const members: Placed[] = [];
    for (const o of this.order) {
      const m = o === c ? undefined : this.dir.member(o.id);
      if (m) members.push({ id: m.id, x: m.x, y: m.y, r: m.r, aoi: m.aoi, n: this.inst(o.id) });
    }
    while (this.spawns[0] && this.now - this.spawns[0].t >= SPAWN_RECENT_MS) this.spawns.shift();
    const spawner = { r: c.r, adultR: c.spec.adultR, aoi: c.aoi() };
    const at = this.timed('place', () =>
      place({
        members,
        recent: this.spawns,
        spawner,
        centre: { x: CENTRE, y: CENTRE },
        world: this.worldOf(),
        now: this.now,
        rng: this.placeRng,
      }),
    );
    // The hub refuses a ride with no group to ride to, or no room around it.
    if (ride && (at.group === null || at.fallback !== 'none')) return null;
    this.res.spawns++;
    if (at.fallback === 'centre') this.res.spawnFallbacks++;
    else this.checkClearance(c, at, members, spawner);
    this.spawns.push({ x: at.x, y: at.y, r: c.r, aoi: spawner.aoi, t: this.now });
    this.noteArrival(c, at, ride, spawner, members);
    return at;
  }

  /**
   * Gate 11 and the wave's gate 1: the clearance from every engage-capable member and every spawn of
   * the last minute, the depth band, and P1 reach from a member in an instance, by the directory's
   * positions.
   */
  private checkClearance(
    c: Client,
    at: Placement,
    members: readonly Placed[],
    spawner: { r: number; adultR: number; aoi: number },
  ): void {
    const tier = sizeTier(c.r * c.r);
    for (const m of members) {
      const d = Math.hypot(m.x - at.x, m.y - at.y);
      if (
        Math.abs(sizeTier(m.r * m.r) - tier) <= RULES.encounter.maxTierGap &&
        d < clearance(spawner, m) - 1e-6
      )
        this.violate('clearance', `${c.id} placed ${Math.round(d)} wu from ${m.id}`);
      if (m.n !== OPEN_WATER && linkTiers(c.r, m.r) && d < p1Reach(c.r, m.r) - 1e-6)
        this.violate(
          'clearance',
          `${c.id} placed ${Math.round(d)} wu from ${m.id} in instance ${m.n}`,
        );
    }
    for (const s of this.spawns) {
      const d = Math.hypot(s.x - at.x, s.y - at.y);
      if (d < clearance(spawner, s) - 1e-6)
        this.violate(
          'clearance',
          `${c.id} placed ${Math.round(d)} wu from a spawn ${Math.round((this.now - s.t) / 1000)} s ago`,
        );
    }
    // An empty world gives the spawn centre itself, whatever its depth (`place`).
    const centre = members.length === 0 && at.x === CENTRE && at.y === CENTRE;
    if (!centre && !inSpawnBand(this.worldOf(), at.x, at.y))
      this.violate('clearance', `${c.id} placed outside the depth band`);
  }

  private worldOf() {
    return {
      seed: `aoi|${this.res.scenario}|${this.res.seed}`,
      size: WORLD,
      tick: Math.floor((this.now * TICK_HZ) / 1000),
    };
  }

  /** The wave's record of an arrival: how far it landed from its group, and (later) when it was linked. */
  private noteArrival(
    c: Client,
    at: Placement,
    ride: boolean,
    spawner: { r: number; adultR: number; aoi: number },
    members: readonly Placed[],
  ): void {
    if (ride) {
      this.minuteRides++;
      this.wave?.rides.push({ id: c.id, t: this.now });
    } else this.minuteSpawns++;
    if (!this.wave) return;
    const g = at.group;
    // A clearance is what the spawner owes its group: the most it owes any member (a starter beside a
    // T1 keeps the T1's clearance, which is wider than its own).
    let base = clearance(spawner, spawner);
    if (g) {
      const ids = new Set(g.ids);
      for (const m of members) if (ids.has(m.id)) base = Math.max(base, clearance(spawner, m));
    }
    c.groupIds = g ? new Set(g.ids) : null;
    // The group's reach includes the minute's spawns around it: they are about to be members.
    let radius = g?.radius ?? 0;
    if (g) {
      for (const sp of this.spawns.slice(0, -1)) {
        const d = Math.hypot(sp.x - g.x, sp.y - g.y);
        if (d <= g.radius + 4 * base) radius = Math.max(radius, d);
      }
    }
    c.arrival = {
      id: c.id,
      t: this.now,
      ride,
      tier: sizeTier(c.r * c.r),
      groupSize: g?.ids.length ?? 0,
      fallback: at.fallback,
      edgeClearances: g ? (Math.hypot(at.x - g.x, at.y - g.y) - radius) / base : null,
      linkMs: null,
      groupLinkMs: null,
    };
    this.wave.arrivals.push(c.arrival);
  }

  /** `c` has a hello with `other`: its arrival's first link and first link into its group. */
  private noteLink(c: Client, other: Client): void {
    const a = c.arrival;
    if (!a) return;
    const ms = this.now - a.t;
    a.linkMs ??= ms;
    if (c.groupIds?.has(other.id)) a.groupLinkMs ??= ms;
  }

  /**
   * The ride model: a client the directory has named no one for in `RIDE_ALONE_MS` asks to ride; the
   * hub refuses a locked one, one with company now and one with no group to ride to, and otherwise
   * places it around the best group at once. It asks again after another wait.
   */
  private maybeRide(c: Client): void {
    if (c.aloneSince === null || this.now - c.aloneSince < (this.sc.rideAloneMs ?? RIDE_ALONE_MS))
      return;
    // A fight, or one that ended under 120 s ago, refuses the ride and leaves the wait running.
    if (
      this.activeFights().some((f) => f.fighters.includes(c.id)) ||
      this.now - c.fightEnd < RIDE_AFTER_FIGHT_MS
    )
      return;
    c.aloneSince = null;
    this.hubMsg(c, 'ride');
    const near = this.dir.near(c.id, this.now, (id) => this.inst(id));
    if (!near || near.peers.length > 0) return;
    const at = this.placeFor(c, true);
    if (!at) return;
    for (const id of [...c.links.keys()]) this.close(c, id);
    for (const a of [...c.out.values(), ...c.inn.values()]) this.dropAttempt(a);
    c.fixes.clear();
    c.dirKnown = [];
    c.signalKnown.clear();
    c.x = at.x;
    c.y = at.y;
    c.box = undefined;
    c.dirty = true;
    this.res.rides++;
    this.hubReport(c);
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

  /** The wave's series: a row each simulated minute, the regroup and crowd samples each second. */
  private recordWave(): void {
    const w = this.wave as WaveRecord;
    const { peakFrom, peakUntil, regroupFrom, crowdsGoneAt } = w.params;
    if (this.now >= peakFrom && this.now < peakUntil) {
      for (const c of this.order) {
        if (this.now - c.spec.spawnAt < CROWD_GRACE_MS) continue;
        w.peakSeconds += TICK_MS / 1000;
        if (c.crowded) w.peakCrowded += TICK_MS / 1000;
      }
    }
    if (this.now % 1000 === 0 && this.now >= crowdsGoneAt)
      w.crowdsLeft = Math.max(w.crowdsLeft, this.crowds?.view().length ?? 0);
    if (this.now % 1000 === 0 && this.now >= regroupFrom) {
      let eligible = 0;
      let linked = 0;
      for (const a of this.order) {
        if (!this.order.some((b) => b !== a && linkTiers(a.r, b.r))) continue;
        eligible++;
        for (const [id, l] of a.links) {
          const b = this.clients.get(id);
          if (l.hello && b && linkTiers(a.r, b.r)) {
            linked++;
            break;
          }
        }
      }
      w.regroup.push({ t: this.now, eligible, linked });
    }
    if (this.now === 0 || this.now % 60_000 !== 0) return;
    if (this.meter && this.now === w.params.holdFrom) this.measureHeap();
    const nominal = { r: 20, adultR: 20, aoi: aoiRadius(20, 20) };
    const members: Placed[] = [];
    const seen = new Set<number>();
    for (const o of this.order) {
      const m = this.dir.member(o.id);
      if (m) members.push({ id: m.id, x: m.x, y: m.y, r: m.r, aoi: m.aoi, n: this.inst(o.id) });
      if (this.inst(o.id) !== OPEN_WATER) seen.add(this.inst(o.id));
    }
    w.minutes.push({
      minute: this.now / 60_000,
      population: this.order.length,
      groups: groupsFor(members, nominal, { x: CENTRE, y: CENTRE }).length,
      crowded: this.order.filter((c) => c.crowded).length,
      instances: seen.size,
      spawns: this.minuteSpawns,
      rides: this.minuteRides,
      messages: this.minuteMsgs,
    });
    this.minuteSpawns = this.minuteRides = this.minuteMsgs = 0;
  }

  /**
   * The heap a directory of the members now present holds, by a copy built beside the live one
   * (after a GC when the process runs with `--expose-gc`). The crowds hold a few entries and aren't
   * copied.
   */
  private measureHeap(): void {
    const meter = this.meter as Meter;
    const gc = (globalThis as { gc?: () => void }).gc;
    gc?.();
    const before = process.memoryUsage().heapUsed;
    const copy = new Directory(WORLD);
    for (const o of this.order) {
      const m = this.dir.member(o.id);
      if (m) copy.report({ id: m.id, name: m.id, x: m.x, y: m.y, r: m.r, aoi: m.aoi, t: this.now });
    }
    gc?.();
    meter.heapBytes = Math.max(0, process.memoryUsage().heapUsed - before);
    meter.heapMembers = this.order.length;
    // Keeps the copy alive until after the second reading.
    if (copy.size < 0) throw new Error('unreachable');
  }

  private sample(c: Client, dt: number): void {
    let n = 0;
    for (const l of c.links.values()) if (l.hello) n++;
    const bin = Math.min(32, n);
    this.res.linkHistogram[bin] = (this.res.linkHistogram[bin] ?? 0) + 1;
    this.res.linkSeconds += n * dt;
    this.res.clientSeconds += dt;
    if (c.crowded) this.res.crowdedSeconds += dt;
    if (this.now - c.spec.spawnAt >= CROWD_GRACE_MS) {
      this.res.clientLate += dt;
      if (c.crowded) this.res.crowdedLate += dt;
    }
    if (this.tickIndex % (this.sc.rateEvery ?? 1) === 0) this.upload(c, n);
  }

  /**
   * The snapshots `c` sends this tick (B/s) at the rate each linked peer asks of it (M11 T15): by
   * the peer's class for `c` and their distance, as the page's `wantedRate`; an engage candidate
   * also gets a signed frame every 200 ms whatever it asked.
   */
  private upload(c: Client, n: number): void {
    let total = 0;
    for (const [id, l] of c.links) {
      const b = this.clients.get(id);
      if (!l.hello || !b) continue;
      const d = Math.hypot(b.x - c.x, b.y - c.y);
      const hz = wantedRate(b.classes.get(c.id) ?? null, d, b.viewHalf());
      const candidate = linkTiers(c.r, b.r) && d <= INTERACT_RADII * Math.max(c.r, b.r);
      const signed = FULL_RATE / SIGN_EVERY;
      // A signed frame takes the place of a plain one on the frames it falls on.
      const plain = candidate ? Math.min(hz, FULL_RATE - signed) : hz;
      const frames = (candidate ? signed : 0) + plain;
      const bps =
        (candidate ? signed * SIGNED_FRAME_BYTES : 0) +
        plain * SNAPSHOT_BYTES +
        frames * FRAME_OVERHEAD_BYTES;
      total += bps;
      b.rx += bps;
      this.res.linkUpload = Math.max(this.res.linkUpload, bps);
    }
    c.tx = total;
    if (n < 24) return;
    const at24 = (total * 24) / n;
    this.res.upload24 = Math.max(this.res.upload24, at24);
    this.res.upload24Sum += at24;
    this.res.upload24Samples++;
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
            if (d <= INTERACT_RADII * Math.max(a.r, b.r) + INTERACT_LEAD_WU && linkTiers(a.r, b.r))
              a.p1True++;
            // A client outside the sample (`Scenario.pairSample`) is only counted, not judged.
            if (!a.judged) continue;
            near.add(b.id);
            this.discover(a, b, d, q);
            if (d <= view) inView.add(b.id);
            if (a.id < b.id || !b.judged) checks.push([a, b, d]);
          }
        }
      }
      if (!a.judged) continue;
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
    if (!linkTiers(a.r, b.r) || !this.shares(a.id, b.id)) {
      this.p1Since.delete(key);
      return;
    }
    if (d <= reach + INTERACT_LEAD_WU) {
      if (!this.p1Since.has(key)) this.p1Since.set(key, this.now);
    } else if (d > reach + 900) this.p1Since.delete(key);
    const since = this.p1Since.get(key);
    if (since === undefined || d > reach || this.now - since < SETUP_GRACE_MS) return;
    if (a.helloed(b.id) && b.helloed(a.id)) return;
    // The wave gives a pair that knows each other only from the directory a `where` interval more.
    if (this.wave && this.now - since < DIRECTORY_GRACE_MS && !this.sees(a, b) && !this.sees(b, a))
      return;
    if (this.settling(a) || this.settling(b)) return;
    this.violate(
      'hidden',
      `${a.id} and ${b.id} are ${Math.round(d)} wu apart (reach ${Math.round(reach)}) and not linked`,
    );
  }

  /** Whether `c` holds a snapshot, gossip or signal fix of `id`: more than the directory's word. */
  private sees(c: Client, id: Client): boolean {
    return (
      c.fixes.has(id.id) || c.signalKnown.has(id.id) || c.gossip.heard(id.id, this.now).length > 0
    );
  }

  /** A creature that is crowded, or has the room under 24 full of P1 by true positions, is excused. */
  private settling(c: Client): boolean {
    return (
      c.crowded || c.p1True >= 24 || this.now - c.crowdedAt < CROWD_SETTLE_MS || this.watered(c)
    );
  }

  /** Its instance changed in the last 10 s: a pair is excused as a new pair is. */
  private watered(c: Client): boolean {
    return this.now - c.waterAt < CROWD_SETTLE_MS;
  }

  private entered(a: Client, b: Client): void {
    if (!linkTiers(a.r, b.r) || !this.shares(a.id, b.id)) return;
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
        `${b.id} came into ${a.id}'s view unlinked (closing ${Math.round(closing)} wu/s, instances ${b.n} and ${a.n}, P0+P1 ${a.heavy()})`,
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

  /** The wave's message counts: the whole life, and the hold for a player that was in the water through it. */
  private finishWave(c: Client, end: number): void {
    const w = this.wave;
    if (!w) return;
    w.messageTotal += c.hubMsgs.length;
    w.lifeMinutes += (end - c.spec.spawnAt) / 60_000;
    const { holdFrom, holdUntil } = w.params;
    if (c.spec.spawnAt <= holdFrom && end >= holdUntil) {
      const n = c.hubMsgs.filter((m) => m >= holdFrom && m < holdUntil).length;
      w.holdPerMinute.push(n / ((holdUntil - holdFrom) / 60_000));
    }
    // The load scenario's reading of the hold: every player in the water in it, joins and leaves included.
    const from = Math.max(holdFrom, c.spec.spawnAt);
    const until = Math.min(holdUntil, end);
    if (until > from) {
      const inHold = c.hubMsgs.filter((m) => m >= from && m < until).length;
      w.holdMessages += inHold;
      w.holdMinutes += (until - from) / 60_000;
      // After its first minute, a player's messages per minute (at least a minute of them to judge).
      const steady = Math.max(from, c.spec.spawnAt + 60_000);
      if (until - steady >= 60_000) {
        const n = c.hubMsgs.filter((m) => m >= steady && m < until).length;
        w.holdSteady.push(n / ((until - steady) / 60_000));
      }
      // Each minute of the hold, the messages of the players past their first minute and there for all of it.
      const minutes = Math.round((holdUntil - holdFrom) / 60_000);
      for (let k = 0; k < minutes; k++) {
        const a = holdFrom + k * 60_000;
        if (c.spec.spawnAt + 60_000 > a || end < a + 60_000) continue;
        const sent = c.hubMsgs.filter((m) => m >= a && m < a + 60_000).length;
        const row = w.holdByMinute[k];
        if (row) row.push(sent);
        else w.holdByMinute[k] = [sent];
      }
      // A player that joined in the hold: its first minute.
      if (
        c.spec.spawnAt >= holdFrom &&
        c.spec.spawnAt + 60_000 <= Math.min(end, holdUntil + 60_000)
      ) {
        w.holdJoin.push(c.hubMsgs.filter((m) => m < c.spec.spawnAt + 60_000).length);
      }
    }
  }

  private finish(c: Client): void {
    const end = Math.min(this.sc.seconds * 1000, c.leftAt);
    const life = end - c.spec.spawnAt;
    this.finishWave(c, end);
    if (life >= 60_000) this.res.changesPerMinute.push(c.changes / (life / 60_000));
    // Authority messages per player-minute: each full minute of the creature's life.
    const from = c.spec.spawnAt;
    for (let t = from; t + 60_000 <= end; t += 60_000) {
      const n = c.hubMsgs.filter((m) => m >= t && m < t + 60_000).length;
      (t === from ? this.res.joinMinute : this.res.perMinute).push(n);
    }
  }
}
