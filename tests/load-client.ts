// A headless load client (M13 T7): what a page does on the hub's wire and nothing else. It signs in
// with a seeded identity through the page's own `HubClient`, hatches a recorded genesis, enters the
// water with a `spawn`, wanders and reports through the page's own `WhereReporter`, sends a
// `progress` every 30 s, offers to its `near` peers at a steady rate (each answered by the target
// client through the hub), and leaves with a `gone` and a close. It opens no WebRTC link, so its hub
// signals follow a measured rate (`offersPerMinute`). It offers itself as a witness (`avail`) and
// audits the genesis cases the hub hands it, with the page's own `AuditDuties`. It counts what it
// sends and receives by type and times each `where`'s `near` and each offer's answer. Node only
// (the global `WebSocket`).

import { createHash } from 'node:crypto';
import { AuditDuties } from '../src/game/app-audit';
import { signGenesisAsk } from '../src/ledger/ask';
import { createIdentity, memoryKeyStore, toBase64Url } from '../src/ledger/identity';
import { auditJob } from '../src/net/audit';
import { HubClient, type LifeMsg, type SocketLike, type WorldMsg } from '../src/net/hub-client';
import { type Leaf, type LifeInfo, WIRE_POS_MAX } from '../src/net/protocol';
import { WhereReporter } from '../src/net/where';
import { createRng, seedFromString } from '../src/sim/prng';
import { TICK_HZ } from '../src/sim/rules';

/** The creature a hatch makes, as the hub's `spawn` and `where` take it (a starter cell). */
const STARTER = { r: 10, aoi: 233 };
/** Wu per second of the scripted wandering, far under what the hub's jump check allows. */
const SWIM_WU_S = 12;
/** One step of the loop. The page reports every `REPORT_EVERY_TICKS` (30 s of ticks). */
const STEP_MS = 1000;
const PROGRESS_EVERY_MS = 30_000;
/** The `Origin` the hub allows from a local page. */
const ORIGIN = 'http://localhost:5173';
/** What a `progress` falls back to when the hub never told the client its creature's condition. */
const CALM = { biomass: 10_000, energy: 12_000, health: 10_000 };
const SDP = 'v=0 load';
/** The longest the client waits for one answer. */
const WAIT_MS = 60_000;
const MAX_RTT_SAMPLES = 5000;
/** An offer unanswered this long is forgotten, and its peer may be offered to again. */
const OFFER_TTL_MS = 10_000;

export interface LoadClientOptions {
  /** The hub's WebSocket URL. */
  url: string;
  /** Which client this is; seeds the identity, the name and the wandering. */
  index: number;
  /** Offers to `near` peers per minute while in the water. */
  offersPerMinute: number;
  /**
   * Whether the client answers the offers it gets (default true). A real page that dials it gets a
   * bogus answer that fails at once, which a page redials with no backoff; a client that stays
   * silent is a peer that cannot be reached, which a page backs off from (M13 T11).
   */
  answerOffers?: boolean;
  /** Opens a socket (default: Node's `WebSocket` with the origin); tests fake it. */
  createSocket?: (url: string) => SocketLike;
  now?: () => number;
}

export interface LoadStats {
  /** Messages this client sent, by type. */
  sent: Record<string, number>;
  /** Messages this client received, by type. */
  received: Record<string, number>;
  /** Close codes the hub sent that this client didn't ask for. */
  closes: Record<string, number>;
  /** `refused` reasons. */
  refused: Record<string, number>;
  /** Milliseconds from each `where` to the `near` that answered it. */
  nearRtt: number[];
  /** Milliseconds from each offer to the answer that came back. */
  signalRtt: number[];
  offers: number;
  answers: number;
}

/** The seed of the `index`th client's identity: the same every run. */
export const seedOf = (index: number): Uint8Array =>
  new Uint8Array(createHash('sha256').update(`bs-load-client-${index}`).digest());

const bump = (r: Record<string, number>, key: string): void => {
  r[key] = (r[key] ?? 0) + 1;
};

const typeOf = (data: unknown): string => {
  if (typeof data !== 'string') return 'binary';
  const m = /^\{"t":"([a-z0-9_-]+)"/.exec(data);
  return m?.[1] ?? 'other';
};

type Waiter = { t: LifeMsg['t']; resolve: (m: LifeMsg) => void };

export class LoadClient {
  readonly stats: LoadStats = {
    sent: {},
    received: {},
    closes: {},
    refused: {},
    nearRtt: [],
    signalRtt: [],
    offers: 0,
    answers: 0,
  };
  /** Whether the client is in the water (spawned and not yet leaving). */
  inWater = false;

  private hub: HubClient | null = null;
  private leaving = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly reporter = new WhereReporter();
  private readonly rng;
  private leaf: Leaf | null = null;
  private peers: string[] = [];
  private x = 0;
  private y = 0;
  private heading = 0;
  private offerCredit: number;
  private progressN = 0;
  private lastProgress = 0;
  private enteredAt = 0;
  private life: LifeInfo | null = null;
  /** When the last `where` went and has not been answered; a newer `where` replaces it. */
  private askedAt: number | null = null;
  private readonly offered = new Map<string, number>();
  private readonly waiters: Waiter[] = [];
  private readonly seen: LifeMsg[] = [];
  private audits: AuditDuties | null = null;
  /** True until `start` has the creature in the water; only then are unmatched life messages kept. */
  private starting = true;

  constructor(private readonly opts: LoadClientOptions) {
    this.rng = createRng(seedFromString(`load-${opts.index}`), 'wander');
    this.heading = this.rng.next() * Math.PI * 2;
    this.offerCredit = this.rng.next();
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  get name(): string {
    return `load-${this.opts.index}`;
  }

  /** Signs in, hatches if needed, spawns, and starts wandering. Resolves once the creature is in the water. */
  async start(): Promise<void> {
    const store = memoryKeyStore(seedOf(this.opts.index));
    const identity = await createIdentity(store);
    const hub = new HubClient({
      url: this.opts.url,
      identity,
      name: this.name,
      seed: `load-${this.opts.index}`,
      createSocket: (url) => this.socket(url),
    });
    this.hub = hub;
    hub.onLife((m) => this.onLife(m));
    hub.onWorld((m) => this.onWorld(m));
    this.audits = new AuditDuties({
      identity: () => identity,
      keys: async () => [],
      sendHub: (msg) => hub.send(msg),
      runner: { run: async (job) => auditJob({ ...job, id: 0 }) as never },
      perfNow: () => performance.now(),
    });
    hub.onDuty((m) => {
      if (m.t === 'duty-end') this.audits?.end(m);
      else if (m.t === 'duty' && m.role === 'auditor') void this.audits?.offer(m);
      else if (m.t === 'duty') hub.send({ t: 'duty-no', event: m.event });
    });
    hub.onSignal((m) => {
      if (m.kind === 'offer') {
        if (this.opts.answerOffers === false) return;
        hub.send({ t: 'signal', to: m.from, kind: 'answer', sdp: SDP });
      } else if (m.kind === 'answer') {
        const at = this.offered.get(m.from);
        if (at !== undefined) {
          this.offered.delete(m.from);
          this.stats.answers++;
          this.sample(this.stats.signalRtt, this.now() - at);
        }
      }
    });
    await hub.connect();
    const first = await this.expect('life');
    this.life = first.t === 'life' ? first.life : null;
    if (!this.life) {
      hub.send({ t: 'genesis-request', ...signGenesisAsk(identity, this.nonce()) });
      await this.expect('commit');
      await this.expect('genesis');
      // The hub says `life` again once the creature exists; a hub that doesn't leaves the calm default.
      const next = await this.expect('life', 3000).catch(() => null);
      if (next?.t === 'life') this.life = next.life;
    }
    hub.send({ t: 'spawn', ...STARTER });
    const spawn = await this.expect('spawn');
    if (spawn.t !== 'spawn') throw new Error('no spawn');
    this.x = spawn.x;
    this.y = spawn.y;
    this.enteredAt = this.lastProgress = this.now();
    if (this.leaving) return;
    this.inWater = true;
    this.starting = false;
    this.seen.length = 0;
    hub.send({ t: 'avail', on: true });
    this.timer = setInterval(() => this.step(), STEP_MS);
    this.step();
  }

  /** Leaves the water (`gone`) and closes the socket. */
  leave(): void {
    if (this.leaving) return;
    this.leaving = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.inWater) this.hub?.send({ t: 'gone' });
    this.inWater = false;
    this.hub?.close();
  }

  private nonce(): string {
    // 16 bytes are 22 base64url characters, the length a nonce has.
    return toBase64Url(seedOf(this.opts.index).subarray(0, 16));
  }

  private sample(into: number[], ms: number): void {
    if (into.length < MAX_RTT_SAMPLES) into.push(ms);
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
        bump(this.stats.sent, typeOf(data));
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
      if (!this.leaving) bump(this.stats.closes, String(ev.code));
      s.onclose?.(ev);
    };
    return s;
  }

  private onLife(m: LifeMsg): void {
    if (m.t === 'refused') bump(this.stats.refused, m.reason);
    const at = this.waiters.findIndex((w) => w.t === m.t);
    if (at >= 0) this.waiters.splice(at, 1)[0]?.resolve(m);
    // Only the start-up looks back at what came: later messages are counted and let go.
    else if (this.starting) this.seen.push(m);
  }

  private onWorld(m: WorldMsg): void {
    if (m.t === 'leaf') {
      this.leaf = m.leaf;
    } else if (m.t === 'near') {
      this.leaf = m.leaf;
      this.peers = m.peers.map((p) => p.id);
      if (this.askedAt !== null) this.sample(this.stats.nearRtt, this.now() - this.askedAt);
      this.askedAt = null;
    }
  }

  /** The next message of type `t`, from those already seen or still to come. */
  private expect(t: LifeMsg['t'], ms = WAIT_MS): Promise<LifeMsg> {
    const at = this.seen.findIndex((m) => m.t === t);
    if (at >= 0) return Promise.resolve(this.seen.splice(at, 1)[0] as LifeMsg);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        t,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      };
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error(`no ${t} in ${ms} ms (${this.name})`));
      }, ms);
      this.waiters.push(waiter);
    });
  }

  /** One second of the page's loop: swim, report, offer, and every 30 s a `progress`. */
  private step(): void {
    const hub = this.hub;
    if (!hub || !this.inWater || this.leaving) return;
    const t = this.now();
    if (this.rng.next() < 0.2) this.heading += (this.rng.next() - 0.5) * 1.5;
    this.x += Math.cos(this.heading) * SWIM_WU_S * (STEP_MS / 1000);
    this.y += Math.sin(this.heading) * SWIM_WU_S * (STEP_MS / 1000);
    this.x = Math.min(WIRE_POS_MAX - 1, Math.max(1, this.x));
    this.y = Math.min(WIRE_POS_MAX - 1, Math.max(1, this.y));
    const where = this.reporter.update(
      { inWater: true, x: this.x, y: this.y, ...STARTER, now: t },
      this.leaf,
    );
    if (where) {
      this.askedAt = t;
      hub.send(where);
    }
    for (const [peer, at] of this.offered) if (t - at > OFFER_TTL_MS) this.offered.delete(peer);
    this.offerCredit += this.opts.offersPerMinute / 60;
    if (this.offerCredit >= 1) {
      this.offerCredit -= 1;
      const to = this.peers[Math.floor(this.rng.next() * this.peers.length)];
      if (to !== undefined && !this.offered.has(to)) {
        this.offered.set(to, t);
        this.stats.offers++;
        hub.send({ t: 'signal', to, kind: 'offer', sdp: SDP });
      }
    }
    if (t - this.lastProgress >= PROGRESS_EVERY_MS) {
      this.lastProgress = t;
      const cond = this.life
        ? { biomass: this.life.biomass, energy: this.life.energy, health: this.life.health }
        : CALM;
      // The ticks the creature has played, a little under the wall time since it entered.
      const ticks = Math.max(1, Math.floor(((t - this.enteredAt) / 1000) * TICK_HZ) - TICK_HZ);
      hub.send({ t: 'progress', n: ++this.progressN, ticks, ...cond });
    }
  }
}
