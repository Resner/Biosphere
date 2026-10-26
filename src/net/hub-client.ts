// Hub WebSocket client: challenge-signed hello, reconnect with backoff, pings for the pond clock.

import { HELLO_DOMAIN, helloMessage, type Identity, toBase64Url } from '../ledger/identity';
import { createRng, type Rng, seedFromString } from '../sim/prng';
import { PondClock } from './clock';
import { guarded } from './guarded';
import {
  CLOSE_ORIGIN,
  CLOSE_REPLACED,
  type ClientMsg,
  type HubMsg,
  type Member,
  PROTOCOL_VERSION,
  parseHubMsg,
} from './protocol';

/** `outdated`: the hub speaks another protocol version, so this page needs a reload. */
/** A place in the admission line: 1 is next, `etaS` the estimated wait. */
export interface QueuePlace {
  position: number;
  etaS: number;
}

export type HubStatus = 'connecting' | 'online' | 'offline' | 'replaced' | 'outdated';
/** Statuses the client does not leave on its own: no reconnect follows. */
export const isFinalStatus = (s: HubStatus): boolean => s === 'replaced' || s === 'outdated';
export type Welcome = Extract<HubMsg, { t: 'welcome' }>;
export type SignalMsg = Extract<HubMsg, { t: 'signal' }>;
/** The hub's answers about the player's own creature (M4). */
export type LifeMsg = Extract<
  HubMsg,
  { t: 'life' | 'ack' | 'died' | 'history' | 'commit' | 'genesis' | 'refused' }
>;

/** The slice of `WebSocket` the client uses, so tests can fake it. */
export interface SocketLike {
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export interface HubClientOptions {
  url: string;
  identity: Identity;
  name: string;
  createSocket?: (url: string) => SocketLike;
  /** Seeds the reconnect jitter. */
  seed?: string;
  /** Reads `/v1/health` (default: `fetch` of the URL as JSON); resolves with the body or rejects. */
  fetchHealth?: ((url: string) => Promise<unknown>) | undefined;
  /** The local clock behind the pond clock's samples; default `Date.now`. */
  now?: () => number;
}

const BACKOFF_S = [1, 2, 4, 8, 16, 30];
const JITTER = 0.2;
/** The hub allows 20 messages per 10 s: the opening burst stays well below that. */
const BURST_PINGS = 8;
const BURST_GAP_MS = 250;
const PING_EVERY_MS = 60_000;

export class HubClient {
  readonly clock = new PondClock();
  /** Inbound messages dropped as malformed or not text. */
  dropped = 0;

  private _status: HubStatus = 'offline';
  private socket: SocketLike | null = null;
  private attempt = 0;
  private lastWelcome: Welcome | null = null;
  private versionError = false;
  /** One `/v1/health` look per run of failures; counts `close()` calls so a late reply is dropped. */
  private healthChecked = false;
  private closes = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setTimeout> | null = null;
  private pingId = 0;
  private pending = new Map<number, number>();
  private readonly rng: Rng;
  private waiting: { resolve: (w: Welcome) => void; reject: (e: Error) => void }[] = [];
  private statusListeners: ((s: HubStatus) => void)[] = [];
  private signalListeners: ((m: SignalMsg) => void)[] = [];
  private memberListeners: ((op: 'join' | 'leave', m: Member) => void)[] = [];
  private welcomeListeners: ((w: Welcome) => void)[] = [];
  private lifeListeners: ((m: LifeMsg) => void)[] = [];
  private queueListeners: ((q: QueuePlace | null) => void)[] = [];
  private _queue: QueuePlace | null = null;

  constructor(private readonly opts: HubClientOptions) {
    this.rng = createRng(seedFromString(opts.seed ?? opts.identity.playerId), 'hub-backoff');
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  get status(): HubStatus {
    return this._status;
  }

  /** Where the hub has this session in the admission line, or null when it is not waiting. */
  get queue(): QueuePlace | null {
    return this._queue;
  }

  /** Connects now and resolves with the first welcome; retries in the background until then. */
  connect(): Promise<Welcome> {
    const result = new Promise<Welcome>((resolve, reject) =>
      this.waiting.push({ resolve, reject }),
    );
    if (this._status === 'online' && this.lastWelcome) this.settleWith(this.lastWelcome);
    else if (this._status === 'offline') this.open();
    else if (this._status === 'replaced') this.settle(new Error('replaced by another session'));
    else if (this._status === 'outdated') this.settle(new Error('outdated'));
    return result;
  }

  close(): void {
    this.closes++;
    this.drop();
    this.setStatus('offline');
    this.settle(new Error('closed'));
  }

  send(msg: ClientMsg): void {
    if (this._status === 'online') this.socket?.send(JSON.stringify(msg));
  }

  onStatus(fn: (s: HubStatus) => void): () => void {
    return subscribe(this.statusListeners, fn);
  }
  onSignal(fn: (m: SignalMsg) => void): () => void {
    return subscribe(this.signalListeners, fn);
  }
  onMember(fn: (op: 'join' | 'leave', m: Member) => void): () => void {
    return subscribe(this.memberListeners, fn);
  }
  /** Fires for every message about the player's own creature. */
  onLife(fn: (m: LifeMsg) => void): () => void {
    return subscribe(this.lifeListeners, fn);
  }
  /** Fires when the place in line changes, and with null when the wait ends. */
  onQueue(fn: (q: QueuePlace | null) => void): () => void {
    return subscribe(this.queueListeners, fn);
  }
  /** Fires on every welcome, including after a reconnect. */
  onWelcome(fn: (w: Welcome) => void): () => void {
    return subscribe(this.welcomeListeners, fn);
  }

  /** Stops the timers and abandons the socket without a close event. */
  private drop(): void {
    this.clearTimers();
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.onclose = null;
      s.close();
    }
  }

  private open(): void {
    this.drop();
    this.versionError = false;
    this.setStatus('connecting');
    const socket = (this.opts.createSocket ?? ((u) => new WebSocket(u) as SocketLike))(
      this.opts.url,
    );
    this.socket = socket;
    socket.onmessage = (ev) => {
      if (socket === this.socket) this.receive(ev.data);
    };
    socket.onclose = (ev) => {
      if (socket === this.socket) this.lost(ev.code);
    };
    socket.onerror = () => {};
  }

  private receive(data: unknown): void {
    const msg = typeof data === 'string' ? parseHubMsg(data) : null;
    if (!msg) {
      this.dropped++;
      return;
    }
    switch (msg.t) {
      case 'challenge':
        this.hello(msg.nonce);
        break;
      case 'queued':
        this.setQueue({ position: msg.position, etaS: msg.etaS });
        break;
      case 'welcome':
        this.setQueue(null);
        this.attempt = 0;
        this.healthChecked = false;
        this.setStatus('online');
        this.startPings();
        this.lastWelcome = msg;
        this.settleWith(msg);
        for (const fn of [...this.welcomeListeners]) guarded(() => fn(msg));
        break;
      case 'pong': {
        const sent = this.pending.get(msg.id);
        if (sent === undefined) break;
        this.pending.delete(msg.id);
        this.clock.addSample(sent, this.now(), msg.now);
        break;
      }
      case 'member':
        for (const fn of [...this.memberListeners]) guarded(() => fn(msg.op, msg.member));
        break;
      case 'signal':
        for (const fn of [...this.signalListeners]) guarded(() => fn(msg));
        break;
      case 'life':
      case 'ack':
      case 'died':
      case 'history':
      case 'commit':
      case 'genesis':
      case 'refused':
        for (const fn of [...this.lifeListeners]) guarded(() => fn(msg));
        break;
      case 'error':
        if (msg.code === 'version') this.versionError = true;
        break;
    }
  }

  private hello(nonce: string): void {
    const { identity, name } = this.opts;
    const message = helloMessage(nonce, name);
    if (!message) {
      this.dropped++;
      return;
    }
    const sig = toBase64Url(identity.sign(HELLO_DOMAIN, message));
    this.socket?.send(
      JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, playerId: identity.playerId, name, sig }),
    );
  }

  private lost(code: number): void {
    this.socket = null;
    this.clearTimers();
    this.setQueue(null);
    if (code === CLOSE_REPLACED) {
      this.setStatus('replaced');
      this.settle(new Error('replaced by another session'));
      return;
    }
    if (this.versionError) {
      this.setStatus('outdated');
      this.settle(new Error('outdated'));
      return;
    }
    this.setStatus('offline');
    if (code === CLOSE_ORIGIN) {
      this.settle(new Error('origin not allowed'));
      return;
    }
    if (!this.healthChecked) {
      this.healthChecked = true;
      void this.checkHealth();
    }
    const base = BACKOFF_S[Math.min(this.attempt, BACKOFF_S.length - 1)] as number;
    this.attempt++;
    const delay = base * 1000 * (1 + (this.rng.next() * 2 - 1) * JITTER);
    this.retry = setTimeout(() => {
      this.retry = null;
      this.open();
    }, delay);
  }

  /** A hub that reports another protocol version in `/v1/health` is out of reach for this page. */
  private async checkHealth(): Promise<void> {
    const url = new URL(this.opts.url);
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    url.pathname = '/v1/health';
    url.search = '';
    const closes = this.closes;
    try {
      const body = await (this.opts.fetchHealth ?? fetchJson)(url.toString());
      const protocol = (body as { protocol?: unknown } | null)?.protocol;
      if (typeof protocol !== 'number' || protocol === PROTOCOL_VERSION) return;
    } catch {
      return; // unreachable or garbled: keep retrying
    }
    if (this._status === 'online' || this.closes !== closes) return;
    this.drop();
    this.setStatus('outdated');
    this.settle(new Error('outdated'));
  }

  private startPings(): void {
    let sent = 0;
    const tick = (): void => {
      const id = ++this.pingId;
      this.pending.set(id, this.now());
      this.socket?.send(JSON.stringify({ t: 'ping', id } satisfies ClientMsg));
      sent++;
      this.pingTimer = setTimeout(tick, sent < BURST_PINGS ? BURST_GAP_MS : PING_EVERY_MS);
    };
    tick();
  }

  private clearTimers(): void {
    if (this.retry) clearTimeout(this.retry);
    if (this.pingTimer) clearTimeout(this.pingTimer);
    this.retry = this.pingTimer = null;
    this.pending.clear();
  }

  private settleWith(w: Welcome): void {
    for (const p of this.waiting.splice(0)) p.resolve(w);
  }

  private settle(err: Error): void {
    for (const w of this.waiting.splice(0)) w.reject(err);
  }

  private setQueue(q: QueuePlace | null): void {
    if (q?.position === this._queue?.position && q?.etaS === this._queue?.etaS) return;
    this._queue = q;
    for (const fn of [...this.queueListeners]) guarded(() => fn(q));
  }

  private setStatus(s: HubStatus): void {
    if (s === this._status) return;
    this._status = s;
    for (const fn of [...this.statusListeners]) fn(s);
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  return res.json();
}

function subscribe<T>(list: T[], fn: T): () => void {
  list.push(fn);
  return () => {
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  };
}
