import { DurableObject } from 'cloudflare:workers';
import {
  CLOSE_BAD_HELLO,
  CLOSE_RATE_LIMITED,
  isOtherVersionHello,
  NONCE_BYTES,
  parseClientMsg,
} from '../src/net/protocol';
import { type BeaconSource, Beacons, liveSource } from './beacons';
import { type KeyEntry, Ledger } from './ledger';
import {
  death,
  deliverGenesis,
  history,
  lineage,
  owns,
  progress,
  promoteChild,
  queueGenesis,
  restoreAncestor,
} from './lives';
import { court, decline, deliverBirth, mateCheck, queueAccept } from './offspring';
import { migrate } from './schema';
import { drop, hello, promote, queued, relay } from './sessions';
import { type Hub, randomToken, type Session, send, sessionOf } from './socket';
import { TurnCredentials } from './turn';
import { UsageMeter } from './usage';

// The message handlers live by area in `sessions.ts` (sessions and signaling), `lives.ts` (genesis
// and life) and `offspring.ts` (mating and offspring); this object keeps the state, the alarm and the dispatch.

const HELLO_TIMEOUT_MS = 10_000;
const RATE_WINDOW_MS = 10_000;
const RATE_MAX_MESSAGES = 20;
/** Signals have their own window cap: joining a pond of 24 sends one offer per member (at most 23), plus retries. */
const RATE_MAX_SIGNALS = 60;
/** While anyone waits, the object looks at the queue this often (the budget resets at midnight UTC without any message). */
const QUEUE_TICK_MS = 15_000;

/** The one authority object (ADR 0008). Handles messages and alarms only: no game loop. */
export class Authority extends DurableObject<Env> implements Hub {
  // Public for the handler modules, which reach the object through `Hub`.
  declare readonly ctx: DurableObjectState<object>;
  declare readonly env: Env;
  readonly turn = new TurnCredentials();
  readonly ledger: Ledger;
  readonly beacons: Beacons;
  readonly usage: UsageMeter;
  private rearming: Promise<void> = Promise.resolve();
  /** Genesis requests run one at a time per player, so a second can't slip past the checks of the first. */
  readonly asking = new Map<string, Promise<void>>();
  private source: BeaconSource;
  /** Promotions run one at a time: each reads who is waiting and how much room there is fresh. */
  promoting: Promise<void> = Promise.resolve();
  /** Acceptances run one at a time: each commits to a round and then re-reads both creatures. */
  matingQueue: Promise<void> = Promise.resolve();
  nextTicket = 0;
  /** When the queue is looked at next; null while nobody waits (then no alarm is held for it). */
  private queueTickAt: number | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ledger = new Ledger(ctx.storage);
    this.usage = new UsageMeter(ctx.storage.sql, () => this.ledger.rowsWritten);
    for (const ws of ctx.getWebSockets()) {
      const session = sessionOf(ws);
      if (session?.phase === 'queued')
        this.nextTicket = Math.max(this.nextTicket, session.ticket + 1);
    }
    this.source = this.beaconSource();
    this.beacons = new Beacons({
      storage: ctx.storage,
      // Looked up on each use, so a test can swap the source of a live object.
      source: { now: () => this.source.now(), fetch: (round) => this.source.fetch(round) },
      countersign: (hash) => this.ledger.countersign(hash),
      rearm: () => this.rearm(),
    });
    // One transaction, so a migration (the world renewal above all) applies whole or not at all.
    ctx.blockConcurrencyWhile(async () =>
      ctx.storage.transactionSync(() => migrate(ctx.storage.sql)),
    );
  }

  /** Live drand by default; the E2E entry (`worker/e2e-entry.ts`) overrides it with recorded rounds. */
  protected beaconSource(): BeaconSource {
    return liveSource();
  }

  /** The public halves of every authority key (`GET /v1/pubkeys`). */
  pubkeys(): KeyEntry[] {
    return this.ledger.pubkeys();
  }

  override async fetch(): Promise<Response> {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    const now = Date.now();
    this.usage.upgrade(now);
    const nonce = randomToken(NONCE_BYTES);
    pair[1].serializeAttachment({
      phase: 'challenged',
      nonce,
      openedAt: now,
      windowStart: now,
      count: 0,
      signals: 0,
    } satisfies Session);
    send(pair[1], { t: 'challenge', nonce });
    await this.rearm();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  override webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): void {
    const session = sessionOf(ws);
    if (!session) {
      ws.close(CLOSE_BAD_HELLO, 'no session');
      return;
    }
    if (session.phase === 'retired') return;
    const now = Date.now();
    this.usage.message(now);
    const msg = typeof data === 'string' ? parseClientMsg(data) : null;
    if (now - session.windowStart >= RATE_WINDOW_MS) {
      session.windowStart = now;
      session.count = 0;
      session.signals = 0;
    }
    const signal = msg?.t === 'signal';
    // `?? 0`: a hibernated session from before signals were counted has no counter.
    if (signal) session.signals = (session.signals ?? 0) + 1;
    else session.count++;
    if (signal ? session.signals > RATE_MAX_SIGNALS : session.count > RATE_MAX_MESSAGES) {
      drop(this, ws, CLOSE_RATE_LIMITED, 'rate limited');
      return;
    }
    ws.serializeAttachment(session);
    if (session.phase === 'challenged') {
      if (msg?.t !== 'hello') {
        // A client on another protocol version is told so, to show "Update available".
        if (typeof data === 'string' && isOtherVersionHello(data))
          send(ws, { t: 'error', code: 'version' });
        ws.close(CLOSE_BAD_HELLO, 'hello expected');
        return;
      }
      hello(this, ws, session, msg).catch(() => drop(this, ws, 1011, 'hello failed'));
      return;
    }
    if (!msg) {
      send(ws, { t: 'error', code: 'bad-message' });
      return;
    }
    if (session.phase === 'queued') {
      // A waiting session may keep the link alive or leave; everything else needs a place first.
      if (msg.t === 'ping') send(ws, { t: 'pong', id: msg.id, now });
      else if (msg.t === 'leave') drop(this, ws, 1000, 'bye');
      else if (msg.t === 'hello') drop(this, ws, CLOSE_BAD_HELLO, 'already signed in');
      else send(ws, { t: 'refused', reason: 'queued' });
      return;
    }
    switch (msg.t) {
      case 'ping':
        send(ws, { t: 'pong', id: msg.id, now });
        return;
      case 'leave':
        drop(this, ws, 1000, 'bye');
        return;
      case 'hello':
        drop(this, ws, CLOSE_BAD_HELLO, 'already signed in');
        return;
      case 'signal':
        relay(this, ws, session, msg);
        return;
      case 'genesis-request':
        queueGenesis(this, ws, session, msg);
        return;
      case 'progress':
        progress(this, ws, session, msg, now);
        return;
      case 'death':
        death(this, ws, session, msg, now);
        return;
      case 'history':
        history(this, ws, session.playerId);
        return;
      case 'lineage':
        lineage(this, ws, session.playerId);
        return;
      case 'promote':
        if (owns(ws, session, msg.request)) promoteChild(this, ws, session, msg, now);
        return;
      case 'restore':
        if (owns(ws, session, msg.request)) restoreAncestor(this, ws, session, msg, now);
        return;
      case 'mate-check':
        mateCheck(this, ws, session, msg.partner);
        return;
      case 'court':
        court(this, ws, session, msg.ask, now);
        return;
      case 'accept':
        queueAccept(this, ws, msg.ask);
        return;
      case 'decline':
        decline(this, ws, session, msg.partner);
        return;
    }
  }

  override webSocketClose(ws: WebSocket, code: number): void {
    // A close frame can't echo the reserved "no status" code 1005.
    drop(this, ws, code === 1005 ? 1000 : code);
  }

  override webSocketError(ws: WebSocket): void {
    drop(this, ws, 1011, 'error');
  }

  /** Closes sockets that never said hello, resolves due commitments, and re-arms for whatever is still waiting. */
  override async alarm(): Promise<void> {
    const now = Date.now();
    for (const ws of this.ctx.getWebSockets()) {
      const session = sessionOf(ws);
      if (session?.phase === 'challenged' && session.openedAt + HELLO_TIMEOUT_MS <= now) {
        ws.close(CLOSE_BAD_HELLO, 'hello timeout');
      }
    }
    try {
      // The budget resets at midnight with no message to say so, so the queue is looked at on a timer.
      // Reset first, so the re-arm inside `promote` doesn't read the tick that just fired; it arms the next one if anyone still waits.
      this.queueTickAt = null;
      if (queued(this).length > 0) await promote(this);
      for (const id of await this.beacons.alarm()) {
        // One commitment failing must not strand the others this pass resolved.
        await this.deliverGenesis(id).catch(() => {});
      }
      // Matings whose round is published, including one marked resolved whose children were not written (an eviction in between).
      for (const id of this.ledger.openMatingCommits()) {
        if (this.beacons.status(id) === 'ready') await deliverBirth(this, id).catch(() => {});
      }
    } finally {
      await this.rearm();
    }
  }

  /** When the earliest socket that hasn't said hello times out, or null. Sockets already closing don't count. */
  private helloDue(): number | null {
    let next: number | null = null;
    for (const ws of this.ctx.getWebSockets()) {
      const session = sessionOf(ws);
      if (session?.phase !== 'challenged' || ws.readyState > WebSocket.READY_STATE_OPEN) continue;
      const due = session.openedAt + HELLO_TIMEOUT_MS;
      next = Math.min(next ?? due, due);
    }
    return next;
  }

  /** When the admission queue is looked at next, or null while it is empty. */
  private queueDue(): number | null {
    if (queued(this).length === 0) {
      this.queueTickAt = null;
      return null;
    }
    this.queueTickAt ??= Date.now() + QUEUE_TICK_MS;
    return this.queueTickAt;
  }

  /** Writes the genesis record once the commitment's beacon exists and sends it to the owner (`lives.ts`). */
  private deliverGenesis(commitId: string): Promise<void> {
    return deliverGenesis(this, commitId);
  }

  /** The object has one alarm: it is set for the earliest of the hello timeout, the next beacon and the queue tick, and cleared when none is needed. */
  rearm(): Promise<void> {
    // One at a time, each reading fresh deadlines, so a slow caller can't overwrite a sooner alarm.
    const run = this.rearming.then(() => this.setAlarmForNext());
    this.rearming = run.catch(() => {});
    return run;
  }

  private async setAlarmForNext(): Promise<void> {
    const hello = this.helloDue();
    const beacon = this.beacons.nextDue();
    const queue = this.queueDue();
    const next = earliest(hello, beacon, queue);
    const current = await this.ctx.storage.getAlarm();
    if (next === null) {
      if (current !== null) await this.ctx.storage.deleteAlarm();
    } else if (current === null || Math.abs(current - next) > 50) {
      await this.ctx.storage.setAlarm(next);
    }
  }
}

/** The earliest of the times that are set. */
const earliest = (...times: (number | null)[]): number | null =>
  times.reduce<number | null>((a, b) => (a === null ? b : b === null ? a : Math.min(a, b)), null);
