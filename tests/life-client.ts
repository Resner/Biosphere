// A headless life client (M14 T13): a player that lives whole lives on the hub's wire and nothing
// else. It runs the page's own flows (`LifeFlow`, `MateFlow`) over the page's own `HubClient`, with a
// seeded identity, a local copy of the hub's world and the pacing bot's policy for its creature
// (`tests/life-policy.ts`). It hatches, enters the water, reports honestly, courts and accepts,
// waits for its births and promotes its child half the time, fights (each client signs its own
// snapshots onto an in-process bus that stands in for the peer links), dies, restores its nearest
// ancestor or hatches again, and drops: it closes its socket at a random moment and signs in again
// 1 to 90 s later, resuming from what the hub names. Node only (the global `WebSocket`).

import { createHash } from 'node:crypto';
import { lockState } from '../src/game/engage';
import { LifeFlow } from '../src/game/life';
import { MateFlow } from '../src/game/mate';
import { genomeFromBase64url, genomeHash } from '../src/genome/codec';
import { buildCreature } from '../src/genome/stats';
import { matureBiomassOf, type Scales } from '../src/ledger/gates';
import { createIdentity, type Identity, memoryKeyStore, toBase64Url } from '../src/ledger/identity';
import { signSnap } from '../src/ledger/snapshot-sig';
import {
  type FightMsg,
  HubClient,
  type LifeMsg,
  type SocketLike,
  type Welcome,
  type WorldMsg,
} from '../src/net/hub-client';
import { snapshotOf } from '../src/net/pond-sync';
import {
  type Born,
  encodeSnapshot,
  genomeRefOf,
  type NearPeer,
  type SignedSnap,
  type Snapshot,
} from '../src/net/protocol';
import { FRAME_MS } from '../src/net/referee';
import { WhereReporter } from '../src/net/where';
import { encodeFrameInput } from '../src/sim/encounter/codec';
import { applyLife } from '../src/sim/life';
import { type MateView, ownRefusal } from '../src/sim/mating';
import { createRng, seedFromString } from '../src/sim/prng';
import { TICK_HZ } from '../src/sim/rules';
import { step } from '../src/sim/step';
import type { CreatureState, DeathCause, World } from '../src/sim/types';
import { createWorld, spawnCreature } from '../src/sim/world';
import { Forager, type Goal } from './life-policy';

/** The hub counts condition in hundredths. */
const HUNDREDTHS = 100;

/** The `Origin` the hub allows from a local page. */
const ORIGIN = 'http://localhost:5173';
/** One step of the loop. */
const LOOP_MS = 100;
/** The most ticks one step plays to catch up with the pond clock; a bigger lag jumps. */
const CATCH_UP_TICKS = 12;
/** Periodic reports a client holds back near the hub's 20 messages per 10 s (`RATE_MAX_MESSAGES`), and the count from which it does. */
const PERIODIC: ReadonlySet<string> = new Set(['where', 'mate-check']);
const WINDOW_SOFT_CAP = 15;
const SNAP_MS = 200;
const FIRST_REPORT_TICKS = 5 * TICK_HZ;
const REPORT_EVERY_TICKS = 30 * TICK_HZ;
const WAIT_MS = 60_000;
/** The aoi radius a spawn and a `where` carry for a starter-sized creature. */
const AOI = 233;
/** How long a client hunts for an opponent, and how soon it may hunt again (ms). */
const HUNT_MS = 25_000;
const HUNT_GAP_MS = 5000;
/** A hunting client engages from this many radii apart; the hub's own range check decides. */
const ENGAGE_RADII = 6;
const ENGAGE_GAP_MS = 2500;
/** After a refused engage the next waits this much longer. */
const ENGAGE_BACKOFF_MS = 5000;
/** The ticks behind and ahead of the pond clock that the hub takes a snapshot from (`fresh` in `worker/engage.ts`, less a margin for the trip). */
const ENGAGE_BEHIND_TICKS = 24;
const ENGAGE_AHEAD_TICKS = 20;
const inWindow = (tick: number, now: number): boolean =>
  tick >= now - ENGAGE_BEHIND_TICKS && tick <= now + ENGAGE_AHEAD_TICKS;
/** A court refused or unanswered is not repeated to the same player for this long. */
const COURT_GAP_MS = 30_000;
const FIGHT_PAUSE_MS = 5000;
/** A client that fought does not hunt again for this long. */
const AFTER_FIGHT_MS = 45_000;
/** How long a client without a creature waits before it asks again. */
const RETRY_MS = 30_000;
/**
 * The chance per second that a creature stops eating and starves, a life that ends in the water as
 * many do: rarely for a hatched creature, and soon for a promoted child, whose death sends the
 * player back to its ancestor (the restore the soak must see).
 */
const STARVE_PER_S = 0.002;
const CHILD_STARVE_PER_S = 0.04;

/** The in-process stand-in for the peer links: each client's newest signed snapshots and its hunting mark. */
export class SnapBus {
  private readonly held = new Map<string, { signed: SignedSnap; snap: Snapshot; at: number }[]>();
  private readonly hunting = new Map<string, number>();

  post(id: string, signed: SignedSnap, snap: Snapshot, at: number): void {
    const list = this.held.get(id) ?? [];
    list.push({ signed, snap, at });
    while (list.length > 16) list.shift();
    this.held.set(id, list);
  }

  latest(id: string): { signed: SignedSnap; snap: Snapshot } | null {
    return this.held.get(id)?.at(-1) ?? null;
  }

  /** The signed snapshots of `id` from the last 2 s, oldest first. */
  recent(id: string, now: number): SignedSnap[] {
    return (this.held.get(id) ?? []).filter((h) => now - h.at <= 2000).map((h) => h.signed);
  }

  hunt(id: string, until: number | null): void {
    if (until === null) this.hunting.delete(id);
    else this.hunting.set(id, until);
  }

  /** The players that hunt now, with their newest snapshot. */
  hunters(now: number): { id: string; snap: Snapshot }[] {
    const out: { id: string; snap: Snapshot }[] = [];
    for (const [id, until] of this.hunting) {
      const held = this.latest(id);
      if (until > now && held) out.push({ id, snap: held.snap });
    }
    return out;
  }
}

export interface LifeClientOptions {
  /** The hub's WebSocket URL; the tools refuse any but localhost. */
  url: string;
  /** Which client this is; seeds the identity, the name and every choice. */
  index: number;
  bus: SnapBus;
  /** The hub's scales (its fixture mode): the client reads maturity from them as the hub does. */
  scales: Scales;
  /** Mean play time between drops (ms); 0 never drops. Default 10 minutes. */
  dropEveryMs?: number;
  /** The shortest and longest absence after a drop (ms). Default 1 to 90 s. */
  absenceMs?: readonly [number, number];
  /** Chance per second of starting to hunt for a fight when nobody else does. Default 0.003; with a hunter in sight the chance per roll is 25%. */
  huntPerSecond?: number;
  /** The chance per roll of joining a hunt already on. Default 0.25: with a crowd of clients someone always hunts, so the rate is this one. */
  huntJoinChance?: number;
  /** Whether a fighter sends an input every frame (default: one client in four) instead of letting the autopilot fly. */
  scripted?: boolean;
  createSocket?: (url: string) => SocketLike;
  now?: () => number;
}

export interface LifeStats {
  sent: Record<string, number>;
  received: Record<string, number>;
  closes: Record<string, number>;
  refused: Record<string, number>;
  deaths: Record<string, number>;
  /** Why a creature that wanted to court could not (the rules' own refusals, as the client sees them). */
  notReady: Record<string, number>;
  hatches: number;
  resumes: number;
  matings: number;
  births: number;
  promotes: number;
  restores: number;
  fights: number;
  /** Lives that ended with the hub's word that this client had been killed. */
  kills: number;
  drops: number;
  limited: number;
  courts: number;
  engages: number;
}

/** The seed of the `index`th client's identity: the same every run. */
export const lifeSeedOf = (index: number): Uint8Array =>
  new Uint8Array(createHash('sha256').update(`bs-life-client-${index}`).digest());

const bump = (r: Record<string, number>, key: string): void => {
  r[key] = (r[key] ?? 0) + 1;
};

const typeOf = (data: unknown): string => {
  if (typeof data !== 'string') return 'binary';
  return /^\{"t":"([a-z0-9_-]+)"/.exec(data)?.[1] ?? 'other';
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The creature in the water: a local copy of the hub's world with the creature in it. */
interface Swimmer {
  world: World;
  me: CreatureState;
  policy: Forager;
  /** The least biomass (wu) from which it may mate. */
  matureBiomass: number;
  ref: number;
  /** The world tick of the hatch, from which the ticks are counted. */
  startTick: number;
  /** When (`now()`) the creature entered the water: the ticks it claims never pass the time since. */
  enteredAt: number;
  nextReport: number;
  seq: number;
  phys: ReturnType<typeof buildCreature>['phys'];
}

export class LifeClient {
  readonly stats: LifeStats = {
    sent: {},
    received: {},
    closes: {},
    refused: {},
    deaths: {},
    notReady: {},
    hatches: 0,
    resumes: 0,
    matings: 0,
    births: 0,
    promotes: 0,
    restores: 0,
    fights: 0,
    kills: 0,
    drops: 0,
    limited: 0,
    courts: 0,
    engages: 0,
  };

  private readonly rng;
  private identity: Identity | null = null;
  private hub: HubClient | null = null;
  private flow: LifeFlow | null = null;
  private mate: MateFlow | null = null;
  private welcome: Welcome | null = null;
  private swim: Swimmer | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private busy = false;
  private readonly waiters: { t: LifeMsg['t']; resolve: (m: LifeMsg) => void }[] = [];
  private readonly reporter = new WhereReporter();
  /** What the socket sent in the last 10 s (the hub's rate window), to say what a rate close was made of. */
  private readonly recent: { at: number; type: string }[] = [];
  private peers: NearPeer[] = [];
  private leafValue: Extract<WorldMsg, { t: 'leaf' }>['leaf'] | null = null;
  private pending: Born | null = null;
  private fight: { enc: string; at: number; sentTo: number } | null = null;
  private fightEndedAt = Number.NEGATIVE_INFINITY;
  private huntUntil = 0;
  private huntAgainAt = 0;
  private engagedAt = Number.NEGATIVE_INFINITY;
  private nextSnapAt = 0;
  private dropAt = Number.POSITIVE_INFINITY;
  private reconnectAt: number | null = null;
  private acceptAt: number | null = null;
  private promoteAt: number | null = null;
  private courtedAt = new Map<string, number>();
  /** What a step of the loop threw, for the soak to report. */
  readonly errors: string[] = [];
  private noteAt = 0;
  private retryAt = 0;
  /** The creature in the water is a promoted child. */
  private child = false;
  private entering = false;
  private readonly scripted: boolean;
  private readonly names = new Map<string, string>();
  /** Every creature this client played or bore, in order: the soak checks their lineages. */
  readonly seen: string[] = [];

  constructor(private readonly opts: LifeClientOptions) {
    this.rng = createRng(seedFromString(`life-${opts.index}`), 'client');
    this.scripted = opts.scripted ?? opts.index % 4 === 0;
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  get name(): string {
    return `life-${this.opts.index}`;
  }

  /** The state of the page's courtship flow (the tests read it). */
  get mateState(): string {
    return this.mate?.view().state ?? 'idle';
  }

  /** Whether the client has a creature in the water. */
  get inWater(): boolean {
    return this.swim !== null && !this.entering;
  }

  /** Signs in and starts living. Resolves once the first creature is in the water. */
  async start(): Promise<void> {
    this.identity = await createIdentity(memoryKeyStore(lifeSeedOf(this.opts.index)));
    this.timer = setInterval(() => void this.loop(), LOOP_MS);
    await this.connect();
    await this.live();
  }

  /** Leaves the water and closes the socket for good. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.opts.bus.hunt(this.identity?.playerId ?? '', null);
    if (this.swim) this.hub?.send({ t: 'gone' });
    this.swim = null;
    this.hub?.close();
  }

  // ---- connection ----

  private async connect(): Promise<void> {
    const identity = this.identity as Identity;
    const hub = new HubClient({
      url: this.opts.url,
      identity,
      name: this.name,
      seed: `life-${this.opts.index}`,
      createSocket: (url) => this.socket(url),
      ...(this.opts.now ? { now: this.opts.now } : {}),
    });
    this.hub = hub;
    const flow = new LifeFlow({
      identity: () => identity,
      nonce: () => this.nonce(),
      verify: async () => [],
    });
    const mate = new MateFlow({
      identity: () => identity,
      nonce: () => this.nonce(),
      now: () => this.now(),
      own: () => this.mateView(),
      nameOf: (id) => this.names.get(id),
      fresh: () => this.reportNow(),
    });
    this.flow = flow;
    this.mate = mate;
    flow.attach({ send: (m) => hub.send(m) });
    mate.attach({ send: (m) => hub.send(m) });
    this.pending = null;
    this.peers = [];
    this.leafValue = null;
    this.fight = null;
    hub.onLife((m) => this.onLife(m));
    hub.onFight((m) => this.onFight(m));
    hub.onWorld((m) => this.onWorld(m));
    // A client never offers itself as a witness: it declines every duty it is asked for.
    hub.onDuty((m) => {
      if (m.t === 'duty') hub.send({ t: 'duty-no', event: m.event });
    });
    hub.onSignal(() => {});
    this.welcome = await hub.connect();
    this.scheduleDrop();
  }

  private scheduleDrop(): void {
    const every = this.opts.dropEveryMs ?? 600_000;
    this.dropAt =
      every > 0 ? this.now() - Math.log(1 - this.rng.next()) * every : Number.POSITIVE_INFINITY;
  }

  /** Closes the socket as a closed tab does, with nothing said, and signs in again after a while. */
  private drop(): void {
    this.stats.drops++;
    this.opts.bus.hunt(this.identity?.playerId ?? '', null);
    this.hub?.close();
    this.hub = null;
    this.swim = null;
    this.fight = null;
    const [lo, hi] = this.opts.absenceMs ?? [1000, 90_000];
    this.reconnectAt = this.now() + lo + this.rng.next() * (hi - lo);
    this.dropAt = Number.POSITIVE_INFINITY;
  }

  private nonce(): string {
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(this.rng.next() * 256);
    return toBase64Url(bytes);
  }

  /** The socket the hub client uses: Node's `WebSocket` (or the option's), counting what crosses it. */
  private socket(url: string): SocketLike {
    const raw: SocketLike =
      this.opts.createSocket?.(url) ??
      (new WebSocket(url, {
        headers: { Origin: ORIGIN },
      } as unknown as string[]) as unknown as SocketLike);
    const s: SocketLike = {
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send: (data) => {
        const type = typeOf(data);
        const now = this.now();
        // A reconnect's burst (hello, 8 pings, spawn, a promote) plus the periodic reports can pass
        // the hub's 20 messages in 10 s, as 200 clients on one machine do now and then; a page's own
        // sends are far sparser. The periodic reports are repeated anyway, so near the cap they wait.
        if (PERIODIC.has(type) && this.recentCount(now) >= WINDOW_SOFT_CAP) return;
        bump(this.stats.sent, type);
        this.recent.push({ at: now, type });
        while (this.recent.length > 0 && (this.recent[0]?.at ?? now) < now - 10_000)
          this.recent.shift();
        raw.send(data);
      },
      close: () => raw.close(),
    };
    raw.onopen = () => s.onopen?.();
    raw.onerror = () => s.onerror?.();
    raw.onmessage = (ev) => {
      bump(this.stats.received, typeOf(ev.data));
      s.onmessage?.(ev);
    };
    raw.onclose = (ev) => {
      if (!this.stopped && this.hub !== null) bump(this.stats.closes, String(ev.code));
      if (!this.stopped && this.hub !== null && ev.code === 4003)
        this.errors.push(this.lastWindow());
      s.onclose?.(ev);
    };
    return s;
  }

  /** What the hub's rate window counts among the last 10 s of sends (its inputs and signals have windows of their own). */
  private recentCount(now: number): number {
    return this.recent.filter(
      (m) => m.at >= now - 10_000 && m.type !== 'input' && m.type !== 'signal',
    ).length;
  }

  /** The last 10 s of sends by type, for the failure line of a rate close. */
  private lastWindow(): string {
    const from = this.now() - 10_000;
    const counts: Record<string, number> = {};
    for (const m of this.recent) if (m.at >= from) bump(counts, m.type);
    return `rate close after ${Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k} ${n}`)
      .join(', ')}`;
  }

  // ---- messages ----

  private onLife(m: LifeMsg): void {
    const flow = this.flow as LifeFlow;
    flow.receive(m, this.ticksNow());
    this.mate?.receive(m);
    switch (m.t) {
      case 'life':
        this.pending = m.pending ?? null;
        if (m.life && this.swim && !this.entering) this.adopt(m.life);
        break;
      case 'refused':
        bump(this.stats.refused, m.reason);
        // An engage the hub refused is not asked again at once, whatever it said.
        if (m.reason.startsWith('engage:')) this.engagedAt = this.now() + ENGAGE_BACKOFF_MS;
        break;
      case 'mating':
        this.stats.matings++;
        break;
      case 'born':
        this.stats.births++;
        this.seen.push(m.record.hash);
        this.pending = m;
        if (this.rng.next() < 0.5) this.promoteAt = this.now() + 1000 + this.rng.next() * 4000;
        break;
      case 'promoted':
      case 'restored':
        this.pending = null;
        break;
      case 'died':
        bump(this.stats.deaths, m.cause);
        if (m.cause === 'killed') this.stats.kills++;
        this.pending = m.fallback?.pending ? this.pending : null;
        break;
      default:
        break;
    }
    const at = this.waiters.findIndex((w) => w.t === m.t);
    if (at >= 0) this.waiters.splice(at, 1)[0]?.resolve(m);
  }

  private onWorld(m: WorldMsg): void {
    if (m.t === 'instance') return;
    this.leafValue = m.leaf;
    if (m.t === 'near') {
      this.peers = m.peers;
      for (const p of m.peers) this.names.set(p.id, p.name);
    }
  }

  private onFight(m: FightMsg): void {
    const hub = this.hub;
    if (!hub || !this.identity) return;
    if (m.t === 'lock-ask') {
      const swim = this.swim;
      if (!swim || !swim.me.alive || !this.welcome) return;
      const bytes = encodeSnapshot({ ...this.snapshot(swim), seq: ++swim.seq });
      hub.send(
        lockState(
          m.lock,
          bytes,
          this.identity,
          this.welcome.world.id,
          this.opts.bus.recent(m.by, this.now()),
        ),
      );
    } else if (m.t === 'enc-start') {
      if (this.fight?.enc !== m.enc) this.stats.fights++;
      this.fight = { enc: m.enc, at: m.at, sentTo: -1 };
      this.huntUntil = 0;
      this.opts.bus.hunt(this.identity.playerId, null);
    } else if (m.t === 'enc-end') {
      this.fight = null;
      this.fightEndedAt = this.now();
      this.huntAgainAt = this.now() + AFTER_FIGHT_MS;
    }
  }

  private waitFor(t: LifeMsg['t'], ms = WAIT_MS): Promise<LifeMsg | null> {
    return new Promise((resolve) => {
      const waiter = {
        t,
        resolve: (m: LifeMsg) => {
          clearTimeout(timer);
          resolve(m);
        },
      };
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        resolve(null);
      }, ms);
      this.waiters.push(waiter);
    });
  }

  // ---- lives ----

  /**
   * The ticks as the flow counts them: since the creature hatched, and never more than the time
   * since it entered the water. A page's clock follows the hub's; a client whose offset was off by
   * seconds (a hub busy with 200 others) would otherwise claim time that has not passed.
   */
  private ticksNow(): number {
    const swim = this.swim;
    if (!swim) return 0;
    const played = swim.world.tick - swim.startTick;
    const elapsed = Math.floor(((this.now() - swim.enteredAt) / 1000) * TICK_HZ);
    return Math.max(0, Math.min(played, elapsed));
  }

  /** Gets a creature into the water: resume, promote the child, restore an ancestor or hatch. */
  private async live(): Promise<void> {
    const flow = this.flow as LifeFlow;
    const hub = this.hub as HubClient;
    this.entering = true;
    try {
      for (let attempt = 0; attempt < 5 && !this.stopped && this.hub === hub; attempt++) {
        const view = flow.view();
        let outcome: Awaited<ReturnType<LifeFlow['hatch']>>;
        // A fresh connection to a player whose creature ended while it was away says the same as a death:
        // no life and a way back (`missedDeath`); asking for a genesis then is refused (`has-lineage`).
        const ended = view.status !== 'playing' && view.fallback !== null;
        if (ended && view.fallback?.pending && this.pending) {
          outcome = await flow.promote(this.pending);
          this.child = outcome.kind === 'recorded';
          if (outcome.kind === 'recorded') this.stats.promotes++;
        } else if (ended && view.fallback?.ancestor) {
          outcome = await flow.restore(view.fallback.ancestor);
          this.child = false;
          if (outcome.kind === 'recorded') this.stats.restores++;
        } else {
          this.child = false;
          outcome = await flow.hatch(WAIT_MS);
          if (outcome.kind === 'recorded') {
            if (outcome.start.seq === 0 && outcome.protect) this.stats.hatches++;
            else this.stats.resumes++;
          }
        }
        if (outcome.kind === 'practice') {
          this.stats.limited++;
          await sleep(Math.min(30_000, (outcome.genesisIn ?? 5000) + 500));
          continue;
        }
        if (outcome.kind === 'failed') {
          await sleep(2000);
          continue;
        }
        if (await this.enterWater(outcome.start)) return;
      }
    } finally {
      this.entering = false;
    }
  }

  /** Asks the hub for a place and puts the creature in a local copy of its world there. */
  private async enterWater(start: {
    genome: string;
    condition: { biomass: number; energy: number; health: number } | null;
  }): Promise<boolean> {
    const hub = this.hub as HubClient;
    const welcome = this.welcome as Welcome;
    const genome = genomeFromBase64url(start.genome);
    if (!genome) return false;
    const answer = this.waitFor('spawn');
    hub.send({ t: 'spawn', r: 10, aoi: AOI });
    const spawn = await answer;
    if (spawn?.t !== 'spawn' || this.hub !== hub) return false;
    const { phys } = buildCreature(genome);
    const world = createWorld({ seed: welcome.world.seed, size: welcome.world.size });
    world.tick = hub.clock.pondTick(this.now(), welcome.world.epoch);
    const me = spawnCreature(world, {
      id: 'me',
      x: spawn.x,
      y: spawn.y,
      phys,
      ...(start.condition ? { biomass: start.condition.biomass } : {}),
    });
    if (start.condition) {
      me.energy = start.condition.energy;
      me.health = start.condition.health;
    }
    const id = this.flow?.view().creature;
    if (id && this.seen.at(-1) !== id) this.seen.push(id);
    this.swim = {
      world,
      me,
      policy: new Forager(this.opts.index),
      matureBiomass: matureBiomassOf(genome, this.opts.scales) / HUNDREDTHS,
      ref: genomeRefOf(genomeHash(genome)),
      startTick: world.tick,
      enteredAt: this.now(),
      nextReport: FIRST_REPORT_TICKS,
      seq: 0,
      phys,
    };
    this.nextSnapAt = 0;
    this.huntAgainAt = this.now() + HUNT_GAP_MS * this.rng.next();
    return true;
  }

  /** The hub's word on the creature's condition after a fight: the body takes it. */
  private adopt(life: { biomass: number; energy: number; health: number }): void {
    const { me } = this.swim as Swimmer;
    if (life.biomass > 0) {
      me.biomass = life.biomass / 100;
      me.energy = life.energy / 100;
      me.health = life.health / 100;
    }
  }

  private snapshot(swim: Swimmer): Omit<Snapshot, 'seq'> & { seq?: number } {
    const view = this.mateView();
    return snapshotOf(swim.me, swim.world.tick, swim.ref, {
      ready: view !== null && ownRefusal(view) === null,
      egg: this.pending !== null,
      spawnProtected: false,
      fighting: this.fight !== null,
    });
  }

  private mateView(): MateView | null {
    const swim = this.swim;
    const flow = this.flow;
    if (!swim || !flow || !this.identity || flow.state !== 'playing' || !swim.me.alive) return null;
    const v = flow.view();
    const clock = flow.clock(this.ticksNow(), swim.me.biomass, swim.phys.maxBiomass, 0);
    return {
      creature: v.creature as string,
      owner: this.identity.playerId,
      active: true,
      activeMs: clock?.activeMs ?? v.activeMs,
      matureAtMs: v.matureAtMs,
      matureBiomass: swim.matureBiomass,
      cooldownUntilMs: v.cooldownUntilMs,
      biomass: swim.me.biomass,
      energy: swim.me.energy,
      hasPending: this.pending !== null || v.pending,
      inFlight: false,
      locked: this.fight !== null,
    };
  }

  // ---- the loop ----

  private async loop(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      await this.loopOnce();
    } catch (e) {
      // A step that threw ends nothing: the next one goes on. The soak reports what was thrown.
      if (!this.stopped) this.errors.push(e instanceof Error ? e.message : String(e));
    } finally {
      this.busy = false;
    }
  }

  private async loopOnce(): Promise<void> {
    const t = this.now();
    if (this.reconnectAt !== null && t >= this.reconnectAt) {
      this.reconnectAt = null;
      await this.connect();
      await this.live();
      return;
    }
    // A client the hub would not give a creature (a hatch it refused) asks again now and then.
    if (this.hub && !this.swim && !this.entering && t >= this.retryAt) {
      this.retryAt = t + RETRY_MS;
      await this.live();
      return;
    }
    if (!this.hub || !this.swim || this.entering) return;
    if (t >= this.dropAt) {
      this.drop();
      return;
    }
    const flow = this.flow as LifeFlow;
    if (flow.state === 'dead') {
      this.swim = null;
      this.opts.bus.hunt(this.identity?.playerId ?? '', null);
      this.hub.send({ t: 'gone' });
      await sleep(1000 + this.rng.next() * 2000);
      await this.live();
      return;
    }
    this.play(t);
    if (this.promoteAt !== null && t >= this.promoteAt && this.pending && !this.fight) {
      this.promoteAt = null;
      const born = this.pending;
      this.swim = null;
      this.hub.send({ t: 'gone' });
      const outcome = await flow.promote(born);
      if (outcome.kind === 'recorded') {
        this.stats.promotes++;
        this.child = true;
        if (await this.enterWater(outcome.start)) return;
      }
      await this.live();
    }
  }

  /** One step of the page's loop: swim, report, sign, court, hunt. */
  private play(t: number): void {
    const swim = this.swim as Swimmer;
    const hub = this.hub as HubClient;
    const flow = this.flow as LifeFlow;
    const mate = this.mate as MateFlow;
    const welcome = this.welcome as Welcome;
    const target = hub.clock.pondTick(t, welcome.world.epoch);
    if (this.fight) {
      this.fightInputs(t);
    } else {
      if (swim.world.tick < target - 4 * CATCH_UP_TICKS) swim.world.tick = target - CATCH_UP_TICKS;
      const goal = this.goal(t);
      for (let n = 0; n < CATCH_UP_TICKS && swim.world.tick < target && swim.me.alive; n++) {
        step(swim.world, { me: swim.policy.input(swim.world, swim.me, goal) });
        if (mate.takeCost()) applyLife(swim.world, 'me', 'mate');
        if (swim.world.tick - swim.startTick >= swim.nextReport) {
          swim.nextReport = swim.world.tick - swim.startTick + REPORT_EVERY_TICKS;
          this.reportNow();
        }
      }
      if (
        swim.me.energy > 0 &&
        this.rng.next() < (this.child ? CHILD_STARVE_PER_S : STARVE_PER_S) * (LOOP_MS / 1000)
      )
        swim.me.energy = 0;
      if (!swim.me.alive) {
        flow.died((swim.me.cause ?? 'starved') as DeathCause, this.ticksNow());
        return;
      }
    }
    mate.tick();
    this.where(t, swim);
    this.sign(t, swim);
    this.social(t, swim);
  }

  private reportNow(): void {
    const swim = this.swim;
    if (!swim || this.fight || !swim.me.alive) return;
    const { biomass, energy, health } = swim.me;
    this.flow?.report(this.ticksNow(), { biomass, energy, health, phys: swim.phys });
  }

  private where(t: number, swim: Swimmer): void {
    const hub = this.hub as HubClient;
    const r = Math.sqrt(Math.max(1, swim.me.biomass));
    const msg = this.reporter.update(
      { inWater: true, x: swim.me.x, y: swim.me.y, r, aoi: AOI, now: t },
      this.leafValue,
    );
    if (msg) hub.send(msg);
  }

  /** Signs the own snapshot onto the bus every 200 ms while someone could be near. */
  private sign(t: number, swim: Swimmer): void {
    if (t < this.nextSnapAt || this.peers.length === 0) return;
    this.nextSnapAt = t + SNAP_MS;
    const own = this.signedNow(swim);
    if (own) this.opts.bus.post((this.identity as Identity).playerId, own.signed, own.snap, t);
  }

  private signedNow(swim: Swimmer): { signed: SignedSnap; snap: Snapshot } | null {
    if (!this.identity || !this.welcome) return null;
    const snap = { ...this.snapshot(swim), seq: ++swim.seq };
    return { signed: signSnap(this.identity, this.welcome.world.id, encodeSnapshot(snap)), snap };
  }

  // ---- the social part: courts, accepts and fights ----

  private goal(t: number): Goal | null {
    if (t >= this.huntUntil || this.fight) return null;
    const mine = (this.identity as Identity).playerId;
    let best: { x: number; y: number } | null = null;
    let bestD = Number.POSITIVE_INFINITY;
    const swim = this.swim as Swimmer;
    for (const h of this.opts.bus.hunters(t)) {
      if (h.id === mine || !this.peers.some((p) => p.id === h.id)) continue;
      const d = Math.hypot(h.snap.x - swim.me.x, h.snap.y - swim.me.y);
      if (d < bestD) {
        bestD = d;
        best = { x: h.snap.x, y: h.snap.y };
      }
    }
    return best ? { ...best, dashFrom: 400 } : null;
  }

  private social(t: number, swim: Swimmer): void {
    const hub = this.hub as HubClient;
    const mate = this.mate as MateFlow;
    const welcome = this.welcome as Welcome;
    const mine = (this.identity as Identity).playerId;
    const state = mate.view().state;
    // An invitation is accepted after a moment, as a player reads it.
    if (state === 'invited') {
      this.acceptAt ??= t + 300 + this.rng.next() * 1700;
      if (t >= this.acceptAt) {
        this.acceptAt = null;
        mate.accept();
      }
    } else {
      this.acceptAt = null;
    }
    if (this.fight || t - this.fightEndedAt < FIGHT_PAUSE_MS) return;
    // Courting: the first ready creature in reach that was not courted lately.
    const view = this.mateView();
    const why = view ? ownRefusal(view) : 'no-view';
    if (state === 'idle' && why !== null && t - this.noteAt >= 5000) {
      this.noteAt = t;
      bump(this.stats.notReady, why);
      if (process.env.LIFE_DEBUG && view)
        process.stderr.write(`${this.name} ${why} ${JSON.stringify(view)}\n`);
    }
    if (state === 'idle' && view && why === null) {
      for (const p of this.peers) {
        const held = this.opts.bus.latest(p.id);
        if (
          !held?.snap.ready ||
          t - (this.courtedAt.get(p.id) ?? Number.NEGATIVE_INFINITY) < COURT_GAP_MS
        )
          continue;
        this.courtedAt.set(p.id, t);
        this.stats.courts++;
        mate.court(p.id);
        return;
      }
    }
    // Hunting: now and then a client looks for a fight, and so does whoever it meets.
    if (t >= this.huntAgainAt && t >= this.huntUntil && state === 'idle') {
      this.huntAgainAt = t + HUNT_GAP_MS;
      const others = this.opts.bus.hunters(t).some((h) => h.id !== mine);
      const chance = others
        ? (this.opts.huntJoinChance ?? 0.25)
        : (this.opts.huntPerSecond ?? 0.003) * (HUNT_GAP_MS / 1000);
      if (this.rng.next() < chance) {
        this.huntUntil = t + HUNT_MS;
        this.opts.bus.hunt(mine, this.huntUntil);
      }
    }
    if (t >= this.huntUntil) {
      this.opts.bus.hunt(mine, null);
      return;
    }
    if (t - this.engagedAt < ENGAGE_GAP_MS) return;
    for (const h of this.opts.bus.hunters(t)) {
      if (h.id === mine || !this.peers.some((p) => p.id === h.id)) continue;
      const d = Math.hypot(h.snap.x - swim.me.x, h.snap.y - swim.me.y);
      if (d > ENGAGE_RADII * (Math.sqrt(swim.me.biomass) + Math.sqrt(h.snap.biomass))) continue;
      const theirs = this.opts.bus.latest(h.id);
      const own = this.signedNow(swim);
      if (!theirs || !own) continue;
      // Only snapshots the hub would take (`fresh` in `worker/engage.ts`, with a margin): an engage it
      // refuses as stale costs a message and is asked again, 25,000 times in an hour of soak.
      const at = hub.clock.pondTick(t, welcome.world.epoch);
      if (!inWindow(own.snap.tick, at) || !inWindow(theirs.snap.tick, at)) continue;
      this.engagedAt = t;
      this.stats.engages++;
      hub.send({ t: 'engage', target: h.id, mine: own.signed, theirs: theirs.signed });
      return;
    }
  }

  /** A scripted fighter sends an input for each frame from the one after the last it sent; the others fly on autopilot. */
  private fightInputs(t: number): void {
    const fight = this.fight;
    const hub = this.hub;
    if (!fight || !hub || !this.scripted) return;
    const due = Math.floor((t - fight.at) / FRAME_MS) + 2;
    for (let f = Math.max(0, fight.sentTo + 1); f <= due && f < fight.sentTo + 4; f++) {
      const i = encodeFrameInput({
        steer: Math.floor(this.rng.next() * 256),
        throttle: 15,
        dash: false,
        stance: 'aggressive',
        target: 0,
        brace: false,
      });
      hub.send({ t: 'input', enc: fight.enc, f, i });
      fight.sentTo = f;
    }
  }
}
