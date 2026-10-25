import { DurableObject } from 'cloudflare:workers';
import {
  fromBase64Url,
  HELLO_DOMAIN,
  helloMessage,
  toBase64Url,
  verify,
} from '../src/ledger/identity';
import {
  CLOSE_BAD_HELLO,
  CLOSE_RATE_LIMITED,
  CLOSE_REPLACED,
  type ClientMsg,
  type HubMsg,
  NONCE_BYTES,
  parseClientMsg,
} from '../src/net/protocol';
import { RULES } from '../src/sim/rules';

const HELLO_TIMEOUT_MS = 10_000;
const RATE_WINDOW_MS = 10_000;
const RATE_MAX_MESSAGES = 20;

/** Per-socket state, kept in the hibernation attachment (survives eviction, never touches SQLite). */
type Session = (
  | { phase: 'challenged'; nonce: string }
  | { phase: 'active'; playerId: string; name: string }
) & { openedAt: number; windowStart: number; count: number };

/** The one authority object (ADR 0008). Handles messages and alarms only: no game loop. */
export class Authority extends DurableObject<Env> {
  override async fetch(): Promise<Response> {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    const now = Date.now();
    const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
    pair[1].serializeAttachment({
      phase: 'challenged',
      nonce,
      openedAt: now,
      windowStart: now,
      count: 0,
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
    const now = Date.now();
    if (now - session.windowStart >= RATE_WINDOW_MS) {
      session.windowStart = now;
      session.count = 0;
    }
    session.count++;
    if (session.count > RATE_MAX_MESSAGES) {
      ws.close(CLOSE_RATE_LIMITED, 'rate limited');
      return;
    }
    ws.serializeAttachment(session);

    const msg = typeof data === 'string' ? parseClientMsg(data) : null;
    if (session.phase === 'challenged') {
      if (msg?.t !== 'hello') {
        ws.close(CLOSE_BAD_HELLO, 'hello expected');
        return;
      }
      this.hello(ws, session, msg);
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
        ws.close(1000, 'bye');
        return;
      case 'hello':
        ws.close(CLOSE_BAD_HELLO, 'already signed in');
        return;
      case 'signal':
        // Relay arrives with the ponds (M2 T6).
        return;
    }
  }

  override webSocketClose(ws: WebSocket, code: number): void {
    // A close frame can't echo the reserved "no status" code 1005.
    ws.close(code === 1005 ? 1000 : code);
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

  private hello(
    ws: WebSocket,
    session: Session & { phase: 'challenged' },
    msg: ClientMsg & { t: 'hello' },
  ): void {
    const message = helloMessage(session.nonce, msg.name);
    const sig = fromBase64Url(msg.sig);
    if (!sig || !verify(msg.playerId, HELLO_DOMAIN, message, sig)) {
      ws.close(CLOSE_BAD_HELLO, 'bad hello');
      return;
    }
    for (const other of this.ctx.getWebSockets()) {
      if (other === ws) continue;
      const theirs = sessionOf(other);
      if (theirs?.phase === 'active' && theirs.playerId === msg.playerId) {
        other.close(CLOSE_REPLACED, 'replaced by a newer session');
      }
    }
    ws.serializeAttachment({
      ...session,
      phase: 'active',
      playerId: msg.playerId,
      name: msg.name,
    } satisfies Session);
    // A single stub pond until the roster arrives (M2 T6).
    const centre = RULES.world.size / 2;
    send(ws, {
      t: 'welcome',
      pond: { id: 'stub', seed: 'stub', epoch: 0, centre: { x: centre, y: centre }, size: 24 },
      you: { spawnHint: { x: centre, y: centre } },
      members: [],
      ice: [],
      turn: false,
      now: Date.now(),
    });
  }
}

function sessionOf(ws: WebSocket): Session | null {
  return ws.deserializeAttachment() as Session | null;
}

function send(ws: WebSocket, msg: HubMsg): void {
  ws.send(JSON.stringify(msg));
}
