import { DurableObject } from 'cloudflare:workers';
import {
  fromBase64Url,
  HELLO_DOMAIN,
  helloMessage,
  toBase64Url,
  verify,
} from '../src/ledger/identity';
import {
  byteLength,
  CLOSE_BAD_HELLO,
  CLOSE_RATE_LIMITED,
  CLOSE_REPLACED,
  type ClientMsg,
  type HubMsg,
  isOtherVersionHello,
  type Member,
  NONCE_BYTES,
  type PondInfo,
  parseClientMsg,
  SDP_MAX_BYTES,
  SPAWN_GOLDEN_ANGLE,
  type Vec2,
} from '../src/net/protocol';
import { isProfane } from '../src/net/text';
import { RULES } from '../src/sim/rules';
import { migrate, type PondRow } from './schema';
import { TurnCredentials } from './turn';

const HELLO_TIMEOUT_MS = 10_000;
const RATE_WINDOW_MS = 10_000;
const RATE_MAX_MESSAGES = 20;
/** Signals have their own window cap: joining a pond of 24 sends one offer per member (at most 23), plus retries. */
const RATE_MAX_SIGNALS = 60;
const POND_CAPACITY = 24;
/** A joiner takes the first free slot `i` of its pond: angle `i · SPAWN_GOLDEN_ANGLE`, radius `RING_BASE + RING_STEP · i` (DESIGN.md). */
const RING_BASE = 300;
const RING_STEP = 40;

/** Per-socket state, kept in the hibernation attachment (survives eviction, never touches SQLite). */
type Session = (
  | { phase: 'challenged'; nonce: string }
  | { phase: 'active'; playerId: string; name: string; pondId: string; slot: number }
  | { phase: 'retired' }
) & { openedAt: number; windowStart: number; count: number; signals: number };

/** The one authority object (ADR 0008). Handles messages and alarms only: no game loop. */
export class Authority extends DurableObject<Env> {
  readonly turn = new TurnCredentials();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => migrate(ctx.storage.sql));
  }

  override async fetch(): Promise<Response> {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    const now = Date.now();
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
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(now + HELLO_TIMEOUT_MS);
    }
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
      this.drop(ws, CLOSE_RATE_LIMITED, 'rate limited');
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
      this.hello(ws, session, msg).catch(() => this.drop(ws, 1011, 'hello failed'));
      return;
    }
    if (!msg) {
      send(ws, { t: 'error', code: 'bad-message' });
      return;
    }
    switch (msg.t) {
      case 'ping':
        send(ws, { t: 'pong', id: msg.id, now });
        return;
      case 'leave':
        this.drop(ws, 1000, 'bye');
        return;
      case 'hello':
        this.drop(ws, CLOSE_BAD_HELLO, 'already signed in');
        return;
      case 'signal':
        this.relay(ws, session, msg);
        return;
    }
  }

  override webSocketClose(ws: WebSocket, code: number): void {
    // A close frame can't echo the reserved "no status" code 1005.
    this.drop(ws, code === 1005 ? 1000 : code);
  }

  override webSocketError(ws: WebSocket): void {
    this.drop(ws, 1011, 'error');
  }

  /** Closes sockets that never said hello, and reschedules while some still may. */
  override async alarm(): Promise<void> {
    const now = Date.now();
    let next: number | null = null;
    for (const ws of this.ctx.getWebSockets()) {
      const session = sessionOf(ws);
      if (session?.phase !== 'challenged') continue;
      const due = session.openedAt + HELLO_TIMEOUT_MS;
      if (due <= now) ws.close(CLOSE_BAD_HELLO, 'hello timeout');
      else next = Math.min(next ?? due, due);
    }
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }

  private async hello(
    ws: WebSocket,
    session: Session & { phase: 'challenged' },
    msg: ClientMsg & { t: 'hello' },
  ): Promise<void> {
    if (isProfane(msg.name)) {
      ws.close(CLOSE_BAD_HELLO, 'name not allowed');
      return;
    }
    const message = helloMessage(session.nonce, msg.name);
    if (!message) {
      ws.close(CLOSE_BAD_HELLO, 'bad nonce');
      return;
    }
    const sig = fromBase64Url(msg.sig);
    if (!sig || !verify(msg.playerId, HELLO_DOMAIN, message, sig)) {
      ws.close(CLOSE_BAD_HELLO, 'bad hello');
      return;
    }
    const { ice, turn } = await this.turn.ice(this.env);
    // The socket may have closed, said hello again or sent messages while the lookup ran: go on
    // from its current state. From here to the welcome there is no await, so nobody can relay a
    // signal to the joiner or learn of it first.
    const current = ws.readyState === WebSocket.OPEN ? sessionOf(ws) : null;
    if (current?.phase !== 'challenged') return;
    for (const [other, theirs] of this.activeSessions(ws)) {
      if (theirs.playerId === msg.playerId) {
        this.drop(other, CLOSE_REPLACED, 'replaced by a newer session');
      }
    }
    const { pond, spawnHint, members, slot } = this.place();
    ws.serializeAttachment({
      ...current,
      phase: 'active',
      playerId: msg.playerId,
      name: msg.name,
      pondId: pond.id,
      slot,
    } satisfies Session);
    this.broadcast(pond.id, ws, {
      t: 'member',
      op: 'join',
      member: { playerId: msg.playerId, name: msg.name },
    });
    sendIfOpen(ws, { t: 'welcome', pond, you: { spawnHint }, members, ice, turn, now: Date.now() });
  }

  /** Picks the fullest pond with a free place (creating one if none), and the joiner's spawn hint. */
  private place(): { pond: PondInfo; spawnHint: Vec2; members: Member[]; slot: number } {
    const sql = this.ctx.storage.sql;
    const counts = new Map<string, number>();
    for (const [, theirs] of this.activeSessions()) {
      counts.set(theirs.pondId, (counts.get(theirs.pondId) ?? 0) + 1);
    }
    let best: PondRow | null = null;
    for (const row of sql.exec<PondRow>('SELECT * FROM ponds ORDER BY created, id')) {
      const n = counts.get(row.id) ?? 0;
      if (n < POND_CAPACITY && (!best || n > (counts.get(best.id) ?? 0))) best = row;
    }
    if (!best) {
      const centre = RULES.world.size / 2;
      const now = Date.now();
      best = {
        id: randomToken(6),
        seed: randomToken(12),
        epoch: now,
        cx: centre,
        cy: centre,
        created: now,
      };
      sql.exec(
        'INSERT INTO ponds (id, seed, epoch, cx, cy, created) VALUES (?, ?, ?, ?, ?, ?)',
        best.id,
        best.seed,
        best.epoch,
        best.cx,
        best.cy,
        best.created,
      );
    }
    const members: Member[] = [];
    const taken = new Set<number>();
    for (const [, theirs] of this.activeSessions()) {
      if (theirs.pondId !== best.id) continue;
      members.push({ playerId: theirs.playerId, name: theirs.name });
      // A session hibernated before slots existed has none.
      if (theirs.slot !== undefined) taken.add(theirs.slot);
    }
    let slot = 0;
    while (taken.has(slot)) slot++;
    const angle = slot * SPAWN_GOLDEN_ANGLE;
    const radius = slot === 0 ? 0 : RING_BASE + RING_STEP * slot;
    return {
      pond: {
        id: best.id,
        seed: best.seed,
        epoch: best.epoch,
        centre: { x: best.cx, y: best.cy },
        size: RULES.world.size,
      },
      spawnHint: { x: best.cx + radius * Math.cos(angle), y: best.cy + radius * Math.sin(angle) },
      members,
      slot,
    };
  }

  /** Every logged-in socket (except `except`) with its session. A joiner is still `challenged` until placed. */
  private *activeSessions(except?: WebSocket): Generator<[WebSocket, ActiveSession]> {
    for (const other of this.ctx.getWebSockets()) {
      if (other === except) continue;
      const theirs = sessionOf(other);
      if (theirs?.phase === 'active') yield [other, theirs];
    }
  }

  private broadcast(pondId: string, except: WebSocket, msg: HubMsg): void {
    for (const [other, theirs] of this.activeSessions(except)) {
      if (theirs.pondId === pondId) send(other, msg);
    }
  }

  /** Forwards a signal to a member of the sender's pond, stamped with the verified sender. */
  private relay(ws: WebSocket, session: ActiveSession, msg: ClientMsg & { t: 'signal' }): void {
    if (byteLength(msg.sdp) > SDP_MAX_BYTES) {
      send(ws, { t: 'error', code: 'too-big' });
      return;
    }
    for (const [other, theirs] of this.activeSessions(ws)) {
      if (theirs.pondId === session.pondId && theirs.playerId === msg.to) {
        send(other, { t: 'signal', from: session.playerId, kind: msg.kind, sdp: msg.sdp });
        return;
      }
    }
    send(ws, { t: 'error', code: 'no-peer' });
  }

  /** Closes a socket; an active one first leaves its pond so the others see it go exactly once. */
  private drop(ws: WebSocket, code: number, reason?: string): void {
    const session = sessionOf(ws);
    if (session?.phase === 'active') {
      ws.serializeAttachment({ ...session, phase: 'retired' } satisfies Session);
      this.broadcast(session.pondId, ws, {
        t: 'member',
        op: 'leave',
        member: { playerId: session.playerId, name: session.name },
      });
    }
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }
}

type ActiveSession = Session & { phase: 'active' };

/** `bytes` of randomness as base64url. */
function randomToken(bytes: number): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function sessionOf(ws: WebSocket): Session | null {
  return ws.deserializeAttachment() as Session | null;
}

function send(ws: WebSocket, msg: HubMsg): void {
  ws.send(JSON.stringify(msg));
}

/** Sends unless the socket closed in the meantime. */
function sendIfOpen(ws: WebSocket, msg: HubMsg): void {
  try {
    send(ws, msg);
  } catch {
    // closed while waiting
  }
}
