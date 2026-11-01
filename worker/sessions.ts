// Sessions and signaling: sign-in, admission and its queue, pond seats, signal relay and leaving.
import { fromBase64Url, HELLO_DOMAIN, helloMessage, verify } from '../src/ledger/identity';
import {
  byteLength,
  CLOSE_BAD_HELLO,
  CLOSE_REPLACED,
  type ClientMsg,
  type HubMsg,
  type IceServer,
  type Member,
  type PondInfo,
  SDP_MAX_BYTES,
  SPAWN_GOLDEN_ANGLE,
  type Vec2,
} from '../src/net/protocol';
import { isProfane } from '../src/net/text';
import { RULES } from '../src/sim/rules';
import { unsaved } from './life';
import { bind, checkpoint, sendLife } from './lives';
import type { PondRow } from './schema';
import {
  type ActiveSession,
  activeSessions,
  type Hub,
  type LiveSession,
  liveSessions,
  randomToken,
  type Session,
  send,
  sendIfOpen,
  sessionOf,
} from './socket';

const POND_CAPACITY = 24;
/** New sessions queue once the day's requests reach this share of the budget (DESIGN §8). */
const BUDGET_SHARE = 0.9;
/** A queued session's estimated wait per place, until M13 measures it. */
const ETA_S_PER_PLACE = 30;
const DEFAULT_MAX_SESSIONS = 200;
const DEFAULT_DAILY_REQUEST_BUDGET = 100_000;
/** A joiner takes the first free slot `i` of its pond: angle `i · SPAWN_GOLDEN_ANGLE`, radius `RING_BASE + RING_STEP · i` (DESIGN.md). */
const RING_BASE = 300;
const RING_STEP = 40;

export async function hello(
  hub: Hub,
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
  const { ice, turn } = await hub.turn.ice(hub.env);
  // The socket may have closed, said hello again or sent messages while the lookup ran: go on
  // from its current state. From here to the welcome there is no await, so nobody can relay a
  // signal to the joiner or learn of it first.
  const current = ws.readyState === WebSocket.OPEN ? sessionOf(ws) : null;
  if (current?.phase !== 'challenged') return;
  // The new tab takes over the old one's place: its pond seat, or its spot in line.
  let held: LiveSession | undefined;
  for (const [other, theirs] of liveSessions(hub, ws)) {
    if (theirs.playerId !== msg.playerId) continue;
    if (theirs.phase === 'active' || held?.phase !== 'active') held = theirs;
    // Quietly: the new socket takes over the place, so nobody moves up and no seat is offered.
    drop(hub, other, CLOSE_REPLACED, 'replaced by a newer session', true);
  }
  const who = { playerId: msg.playerId, name: msg.name };
  // Admission never drops or re-queues a player who already has a seat.
  if (held?.phase !== 'active' && (queued(hub).length > 0 || !canAdmit(hub, Date.now()))) {
    const ticket = held?.phase === 'queued' ? held.ticket : hub.nextTicket++;
    ws.serializeAttachment({
      ...current,
      phase: 'queued',
      ...who,
      ticket,
      place: 0,
    } satisfies Session);
  } else {
    enter(hub, ws, current, who, { ice, turn });
  }
  announceQueue(hub);
  await hub.rearm();
}

/** Whether one more session fits: under the session cap and short of 90% of the day's request budget. */
export function canAdmit(hub: Hub, now: number): boolean {
  const sessions = [...activeSessions(hub)].length;
  return (
    sessions < limit(hub.env.MAX_SESSIONS, DEFAULT_MAX_SESSIONS) &&
    hub.usage.requests(now) <
      BUDGET_SHARE * limit(hub.env.DAILY_REQUEST_BUDGET, DEFAULT_DAILY_REQUEST_BUDGET)
  );
}

/** The waiting sessions, next first. */
export function queued(hub: Hub): [WebSocket, Session & { phase: 'queued' }][] {
  const out: [WebSocket, Session & { phase: 'queued' }][] = [];
  for (const [ws, session] of liveSessions(hub)) {
    if (session.phase === 'queued') out.push([ws, session]);
  }
  return out.sort((a, b) => a[1].ticket - b[1].ticket);
}

/** Tells each waiting session its place when that changed (the first time included). */
export function announceQueue(hub: Hub): void {
  queued(hub).forEach(([ws, session], i) => {
    const place = i + 1;
    if (session.place === place) return;
    ws.serializeAttachment({ ...session, place } satisfies Session);
    sendIfOpen(ws, { t: 'queued', position: place, etaS: place * ETA_S_PER_PLACE });
  });
}

/** Seats waiting sessions, in arrival order, for as long as there is room. */
export function promote(hub: Hub): Promise<void> {
  const run = hub.promoting.then(() => promoteWaiting(hub));
  hub.promoting = run.catch(() => {});
  return run;
}

export async function promoteWaiting(hub: Hub): Promise<void> {
  try {
    for (;;) {
      const first = queued(hub)[0];
      if (!first || !canAdmit(hub, Date.now())) return;
      const { ice, turn } = await hub.turn.ice(hub.env);
      // The line may have changed while the lookup ran. No await from here to the welcome.
      const next = queued(hub)[0];
      if (next?.[0] !== first[0] || !canAdmit(hub, Date.now())) continue;
      const [ws, session] = next;
      enter(hub, ws, session, { playerId: session.playerId, name: session.name }, { ice, turn });
    }
  } finally {
    announceQueue(hub);
    await hub.rearm();
  }
}

/** Seats a signed-in session in a pond and welcomes it. */
export function enter(
  hub: Hub,
  ws: WebSocket,
  from: Pick<Session, 'openedAt' | 'windowStart' | 'count' | 'signals'>,
  who: { playerId: string; name: string },
  link: { ice: IceServer[]; turn: boolean },
): void {
  const { pond, spawnHint, members, slot } = place(hub);
  const { openedAt, windowStart, count, signals } = from;
  ws.serializeAttachment({
    phase: 'active',
    openedAt,
    windowStart,
    count,
    signals,
    ...who,
    pondId: pond.id,
    slot,
    life: bind(hub, who.playerId, Date.now()),
  } satisfies Session);
  broadcast(hub, pond.id, ws, { t: 'member', op: 'join', member: who });
  sendIfOpen(ws, {
    t: 'welcome',
    pond,
    you: { spawnHint },
    members,
    ice: link.ice,
    turn: link.turn,
    now: Date.now(),
  });
  sendLife(hub, ws, who.playerId);
}

/** Picks the fullest pond with a free place (creating one if none), and the joiner's spawn hint. */
export function place(hub: Hub): {
  pond: PondInfo;
  spawnHint: Vec2;
  members: Member[];
  slot: number;
} {
  const sql = hub.ctx.storage.sql;
  const counts = new Map<string, number>();
  for (const [, theirs] of activeSessions(hub)) {
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
  for (const [, theirs] of activeSessions(hub)) {
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

export function broadcast(hub: Hub, pondId: string, except: WebSocket, msg: HubMsg): void {
  for (const [other, theirs] of activeSessions(hub, except)) {
    if (theirs.pondId === pondId) send(other, msg);
  }
}

/** Forwards a signal to a member of the sender's pond, stamped with the verified sender. */
export function relay(
  hub: Hub,
  ws: WebSocket,
  session: ActiveSession,
  msg: ClientMsg & { t: 'signal' },
): void {
  if (byteLength(msg.sdp) > SDP_MAX_BYTES) {
    send(ws, { t: 'error', code: 'too-big' });
    return;
  }
  for (const [other, theirs] of activeSessions(hub, ws)) {
    if (theirs.pondId === session.pondId && theirs.playerId === msg.to) {
      send(other, { t: 'signal', from: session.playerId, kind: msg.kind, sdp: msg.sdp });
      return;
    }
  }
  send(ws, { t: 'error', code: 'no-peer' });
}

/** A connection that reported anything since the last record leaves its condition behind as a checkpoint. */
export function saveOnClose(hub: Hub, { life, playerId }: ActiveSession): void {
  if (life && unsaved(life)) checkpoint(hub, life, playerId);
}

/** Closes a socket; an active one first leaves its pond so the others see it go exactly once. */
export function drop(
  hub: Hub,
  ws: WebSocket,
  code: number,
  reason?: string,
  replaced = false,
): void {
  const session = sessionOf(ws);
  if (session?.phase === 'queued') {
    ws.serializeAttachment({ ...session, phase: 'retired' } satisfies Session);
    if (!replaced) {
      announceQueue(hub);
      hub.rearm().catch(() => {});
    }
  }
  if (session?.phase === 'active') {
    ws.serializeAttachment({ ...session, phase: 'retired' } satisfies Session);
    try {
      saveOnClose(hub, session);
    } catch {
      // A failed save must not keep the others from seeing this player leave; the next login resumes from the last record.
    }
    broadcast(hub, session.pondId, ws, {
      t: 'member',
      op: 'leave',
      member: { playerId: session.playerId, name: session.name },
    });
    // The seat is free: the first in line takes it.
    if (!replaced && queued(hub).length > 0) promote(hub).catch(() => {});
  }
  try {
    ws.close(code, reason);
  } catch {
    // already closed
  }
}

/** A positive whole number from a `vars` entry, else the default. */
function limit(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
