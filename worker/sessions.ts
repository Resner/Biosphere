// Sessions and signaling: sign-in, admission and its queue, seats in the world, signal relay and leaving.
import { fromBase64Url, HELLO_DOMAIN, helloMessage, verify } from '../src/ledger/identity';
import {
  byteLength,
  CLOSE_BAD_HELLO,
  CLOSE_REPLACED,
  type ClientMsg,
  type IceServer,
  SDP_MAX_BYTES,
} from '../src/net/protocol';
import { isProfane } from '../src/net/text';
import { awayDue } from './away';
import { flushFight, resend } from './fights';
import { unsaved } from './life';
import { bind, checkpoint, sendLife } from './lives';
import { seatTicket } from './seat';
import {
  type ActiveSession,
  activeSessions,
  type Hub,
  type LiveSession,
  liveSessions,
  type Session,
  send,
  sendIfOpen,
  sessionOf,
} from './socket';
import { fightAnchor } from './spawn';
import { atOf, countRelay, gone, relayReach } from './where';
import { witnessLeft } from './witness-fight';
import { worldInfo, worldRow } from './world';

/** New sessions queue once the day's requests reach this share of the budget (DESIGN §8). */
const BUDGET_SHARE = 0.9;
/** A queued session's estimated wait per place, until M13 measures it. */
const ETA_S_PER_PLACE = 30;
const DEFAULT_MAX_SESSIONS = 200;
const DEFAULT_DAILY_REQUEST_BUDGET = 100_000;

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
  // The new tab takes over the old one's place: its seat, or its spot in line.
  let held: LiveSession | undefined;
  let duties: number[] | undefined;
  for (const [other, theirs] of liveSessions(hub, ws)) {
    if (theirs.playerId !== msg.playerId) continue;
    if (theirs.phase === 'active' || held?.phase !== 'active') held = theirs;
    if (theirs.phase === 'active' && theirs.duties) duties = theirs.duties;
    // Quietly: the new socket takes over the place, so nobody moves up and no seat is offered.
    drop(hub, other, CLOSE_REPLACED, 'replaced by a newer session', true);
  }
  const who = { playerId: msg.playerId, name: msg.name };
  // Admission never drops or re-queues a player who already has a seat: a seated tab's, or the one
  // its fight held while it was away (M8).
  const seat = held?.phase === 'active' || hub.fights.ofPlayer(msg.playerId)?.fight != null;
  if (!seat && (queued(hub).length > 0 || !canAdmit(hub, Date.now()))) {
    const ticket = held?.phase === 'queued' ? held.ticket : hub.nextTicket++;
    ws.serializeAttachment({
      ...current,
      phase: 'queued',
      ...who,
      ticket,
      place: 0,
    } satisfies Session);
  } else {
    enter(hub, ws, { ...current, duties }, who, { ice, turn });
  }
  announceQueue(hub);
  await hub.rearm();
}

/**
 * Whether one more session fits: under the session cap (away fighters' seats included) and short
 * of 90% of the day's request budget.
 */
export function canAdmit(hub: Hub, now: number): boolean {
  const sessions = [...activeSessions(hub)].length + awaySeats(hub);
  return (
    sessions < limit(hub.env.MAX_SESSIONS, DEFAULT_MAX_SESSIONS) &&
    hub.usage.requests(now) < BUDGET_SHARE * requestBudget(hub.env)
  );
}

/** The day's request budget (`DAILY_REQUEST_BUDGET`), which admission and the proof reads share. */
export const requestBudget = (env: Env): number =>
  limit(env.DAILY_REQUEST_BUDGET, DEFAULT_DAILY_REQUEST_BUDGET);

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

/**
 * The seats held world-wide for fighters whose player is away (ADR 0053): every participant of a
 * running fight with no seated socket keeps its place until the fight ends.
 */
function awaySeats(hub: Hub): number {
  const running = hub.fights.running();
  if (running.length === 0) return 0;
  const here = new Set<string>();
  for (const [, theirs] of activeSessions(hub)) here.add(theirs.playerId);
  let away = 0;
  for (const { players, fight } of running) {
    if (fight) away += players.filter((p) => !here.has(p)).length;
  }
  return away;
}

/**
 * Seats a signed-in session in the world and welcomes it. A player locked in a running fight goes
 * back to the fight: `life` names it, and its start and every frame and join so far follow (M8,
 * ADR 0053), and its binding is anchored at its place in the fight. Anyone else asks `spawn` as
 * its creature enters the water (M12 T4).
 */
export function enter(
  hub: Hub,
  ws: WebSocket,
  from: Pick<Session, 'openedAt' | 'windowStart' | 'count' | 'signals' | 'ip'> & {
    duties?: number[] | undefined;
  },
  who: { playerId: string; name: string },
  link: { ice: IceServer[]; turn: boolean },
): void {
  const lock = hub.fights.ofPlayer(who.playerId);
  const fight = lock?.fight ?? null;
  const world = worldInfo(worldRow(hub));
  const { openedAt, windowStart, count, signals, ip, duties } = from;
  const now = hub.clock.now();
  const ticket = seatTicket(hub, who, now);
  const life = bind(hub, who.playerId, now);
  const anchor = fightAnchor(lock, who.playerId, life, now);
  ws.serializeAttachment({
    phase: 'active',
    openedAt,
    windowStart,
    count,
    signals,
    ip,
    ...who,
    life,
    ...(anchor ? { anchor } : {}),
    seatAt: now,
    // The hour's duties belong to the player, not the socket: a reload keeps them.
    ...(duties ? { duties } : {}),
  } satisfies Session);
  sendIfOpen(ws, {
    t: 'welcome',
    world,
    ice: link.ice,
    turn: link.turn,
    now: Date.now(),
    ticket,
  });
  sendLife(hub, ws, who.playerId, undefined, fight?.enc.id);
  if (!lock || !fight) return;
  resend(hub, lock, who.playerId);
  // Back in time: the fight goes on in real time.
  awayDue(hub, fight, hub.clock.now());
}

/**
 * Forwards a signal, stamped with the verified sender, to a session the directory places within
 * reach (`relayReach`, M11 T6), or anywhere between a referee witness and its fight's fighters
 * while that duty runs (M10 T6); nothing else passes (M11 T14). It carries the sender's
 * directory position as `at` once the sender has reported, and the sender's link class `cls` (M11
 * T13) when it named one.
 */
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
  const from = session.playerId;
  for (const [other, theirs] of activeSessions(hub, ws)) {
    if (theirs.playerId !== msg.to) continue;
    if (relayReach(hub, from, msg.to) || hub.duties.linksOf(from).includes(msg.to)) {
      const at = atOf(hub, from);
      const cls = msg.cls === undefined ? {} : { cls: msg.cls };
      send(other, {
        t: 'signal',
        from,
        kind: msg.kind,
        sdp: msg.sdp,
        ...cls,
        ...(at ? { at } : {}),
      });
      countRelay(hub, from, msg.to);
      return;
    }
  }
  send(ws, { t: 'error', code: 'no-peer' });
}

/**
 * A connection that reported anything since the last record leaves its condition behind as a
 * checkpoint; a fighter's leaves nothing, since its fight's settlement writes its records. A lock
 * still asking is no fight yet: its close writes the checkpoint.
 */
export function saveOnClose(hub: Hub, { life, playerId }: ActiveSession): void {
  if (life && unsaved(life) && !hub.fights.playerFighting(playerId))
    checkpoint(hub, life, playerId);
}

/** Closes a socket; an active one first leaves the directory and its duties. */
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
    // Its fight runs on: the log takes every frame final so far (a failed write is logged there).
    flushFight(hub, session.playerId);
    // A fight it referees is taken back, and a witness duty offered to it moves on.
    witnessLeft(hub, session.playerId);
    hub.duties.left(session.playerId);
    // Out of the directory: a split's neighbours hear their new leaf (the socket is going, so no attachment is kept).
    gone(hub, null, session);
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
