// Hub WebSocket client: challenge-signed hello, reconnect with backoff, pings for the pond clock.

import { HELLO_DOMAIN, helloMessage, type Identity, toBase64Url } from '../ledger/identity';
import { createRng, type Rng, seedFromString } from '../sim/prng';
import { PondClock } from './clock';
import {
  CLOSE_ORIGIN,
  CLOSE_REPLACED,
  type ClientMsg,
  type HubMsg,
  type Member,
  PROTOCOL_VERSION,
  parseHubMsg,
} from './protocol';

export type HubStatus = 'connecting' | 'online' | 'offline' | 'replaced';
export type Welcome = Extract<HubMsg, { t: 'welcome' }>;
export type SignalMsg = Extract<HubMsg, { t: 'signal' }>;

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

  constructor(private readonly opts: HubClientOptions) {
    this.rng = createRng(seedFromString(opts.seed ?? opts.identity.playerId), 'hub-backoff');
  }

  get status(): HubStatus {
    return this._status;
  }

  /** Connects now and resolves with the first welcome; retries in the background until then. */
  connect(): Promise<Welcome> {
    const result = new Promise<Welcome>((resolve, reject) =>
      this.waiting.push({ resolve, reject }),
    );
    if (this._status === 'online' && this.lastWelcome) this.settleWith(this.lastWelcome);
    else if (this._status === 'offline') this.open();
    else if (this._status === 'replaced') this.settle(new Error('replaced by another session'));
    return result;
  }

  close(): void {
    this.clearTimers();
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.onclose = null;
      s.close();
    }
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
  /** Fires on every welcome, including after a reconnect. */
  onWelcome(fn: (w: Welcome) => void): () => void {
    return subscribe(this.welcomeListeners, fn);
  }

  private open(): void {
    this.clearTimers();
    const old = this.socket;
    if (old) {
      old.onclose = null;
      old.close();
    }
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
      case 'welcome':
        this.attempt = 0;
        this.setStatus('online');
        this.startPings();
        this.lastWelcome = msg;
        this.settleWith(msg);
        for (const fn of [...this.welcomeListeners]) fn(msg);
        break;
      case 'pong': {
        const sent = this.pending.get(msg.id);
        if (sent === undefined) break;
        this.pending.delete(msg.id);
        this.clock.addSample(sent, Date.now(), msg.now);
        break;
      }
      case 'member':
        for (const fn of [...this.memberListeners]) fn(msg.op, msg.member);
        break;
      case 'signal':
        for (const fn of [...this.signalListeners]) fn(msg);
        break;
      case 'error':
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
    if (code === CLOSE_REPLACED) {
      this.setStatus('replaced');
      this.settle(new Error('replaced by another session'));
      return;
    }
    this.setStatus('offline');
    if (code === CLOSE_ORIGIN) {
      this.settle(new Error('origin not allowed'));
      return;
    }
    const base = BACKOFF_S[Math.min(this.attempt, BACKOFF_S.length - 1)] as number;
    this.attempt++;
    const delay = base * 1000 * (1 + (this.rng.next() * 2 - 1) * JITTER);
    this.retry = setTimeout(() => {
      this.retry = null;
      this.open();
    }, delay);
  }

  private startPings(): void {
    let sent = 0;
    const tick = (): void => {
      const id = ++this.pingId;
      this.pending.set(id, Date.now());
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

  private setStatus(s: HubStatus): void {
    if (s === this._status) return;
    this._status = s;
    for (const fn of [...this.statusListeners]) fn(s);
  }
}

function subscribe<T>(list: T[], fn: T): () => void {
  list.push(fn);
  return () => {
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  };
}
