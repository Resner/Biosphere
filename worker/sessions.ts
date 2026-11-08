// Sessions and signaling: sign-in, admission and its queue, seats in the world, signal relay and leaving.
import { fromBase64Url, HELLO_DOMAIN, helloMessage, verify } from '../src/ledger/identity';
import {
  byteLength,
  CLOSE_BAD_HELLO,
  CLOSE_REPLACED,
  type ClientMsg,
  type IceServer,
  type QueueWhy,
  SDP_MAX_BYTES,
} from '../src/net/protocol';
import { isProfane } from '../src/net/text';
import { awayDue } from './away';
import { flushFight, resend } from './fights';
import { unsaved } from './life';
import { bind, checkpoint, sendLife } from './lives';
import { limitsOf } from './plan';
import { seatTicket } from './seat';
import type { InLine } from './seats';
import {
  type ActiveSession,
  type Hub,
  keep,
  type LiveSession,
  type Session,
  seated,
  send,
  sendIfOpen,
  sessionOf,
} from './socket';
import { fightAnchor, saveLeft } from './spawn';
import { atOf, countRelay, gone, relayReach, reseatCrowd, sharesWater } from './where';
import { witnessLeft } from './witness-fight';
import { worldInfo, worldRow } from './world';

/** New sessions queue once the day's requests reach this share of the budget (DESIGN §8). */
const BUDGET_SHARE = 0.9;
/** A queued session's estimated wait per place, until M13 T9 measures it. */
export const ETA_S_PER_PLACE = 30;

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
  for (const [other, theirs] of placesOf(hub, msg.playerId, ws)) {
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
    keep(hub, ws, {
      ...current,
      phase: 'queued',
      ...who,
      ticket,
      place: 0,
      queuedAt: held?.phase === 'queued' && held.queuedAt ? held.queuedAt : Date.now(),
    });
    meterSeats(hub);
  } else {
    enter(hub, ws, { ...current, duties }, who, { ice, turn });
  }
  announceQueue(hub);
  await hub.rearm();
}

/** The player's seat and its place in line (at most one of each), other than `except`'s: two attachment reads at most. */
function placesOf(hub: Hub, player: string, except: WebSocket): [WebSocket, LiveSession][] {
  const out: [WebSocket, LiveSession][] = [];
  const seat = seated(hub, player);
  if (seat && seat[0] !== except) out.push(seat);
  const waiting = hub.seats.waitingOf(player);
  const s = waiting && waiting.ws !== except ? sessionOf(waiting.ws) : null;
  if (waiting && s?.phase === 'queued') out.push([waiting.ws, s]);
  return out;
}

/**
 * Why one more session doesn't fit, by the guard that holds (M13 T4): `budget` at 90% of the day's
 * request budget, else `full` at the session cap (away fighters' seats included); null when it fits.
 */
export function admissionWhy(hub: Hub, now: number): QueueWhy | null {
  if (hub.usage.requests(now) >= BUDGET_SHARE * requestBudget(hub.env)) return 'budget';
  if (seatedCount(hub) + awaySeats(hub) >= limitsOf(hub.env).sessions) return 'full';
  return null;
}

/** Whether one more session fits. */
export const canAdmit = (hub: Hub, now: number): boolean => admissionWhy(hub, now) === null;

/** The day's request budget (`DAILY_REQUEST_BUDGET`), which admission and the proof reads share. */
export const requestBudget = (env: Env): number => limitsOf(env).requestsPerDay;

/** How many sessions hold a seat (away fighters not included). */
export const seatedCount = (hub: Hub): number => hub.seats.size;

/** Tells the usage meter how many sessions are seated and how many wait (the seated time is integrated from these). */
export function meterSeats(hub: Hub): void {
  const now = Date.now();
  hub.usage.setSeated(now, seatedCount(hub));
  hub.usage.setQueued(now, queued(hub).length);
}

/** The waiting sessions, next first (the line's index). */
export const queued = (hub: Hub): readonly InLine[] => hub.seats.line();

/** The first waiting session with its attachment, or null. */
function firstInLine(hub: Hub): [WebSocket, Session & { phase: 'queued' }] | null {
  const first = queued(hub)[0];
  const session = first ? sessionOf(first.ws) : null;
  return first && session?.phase === 'queued' ? [first.ws, session] : null;
}

/**
 * Tells each waiting session its place when that changed (the first time included), with the
 * guard that holds now (a line that waits only for its first to be seated is `full`): only those
 * are read.
 */
export function announceQueue(hub: Hub): void {
  let why: QueueWhy | undefined;
  [...queued(hub)].forEach(({ ws, place: was }, i) => {
    const place = i + 1;
    if (was === place) return;
    const session = sessionOf(ws);
    if (session?.phase !== 'queued') return;
    why ??= admissionWhy(hub, Date.now()) ?? 'full';
    keep(hub, ws, { ...session, place });
    sendIfOpen(ws, { t: 'queued', position: place, etaS: place * ETA_S_PER_PLACE, why });
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
      const next = firstInLine(hub);
      if (next?.[0] !== first.ws || !canAdmit(hub, Date.now())) continue;
      const [ws, session] = next;
      // A session queued before `queuedAt` existed has no wait to record.
      if (session.queuedAt) hub.usage.waited(Date.now(), Date.now() - session.queuedAt);
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
export function awaySeats(hub: Hub): number {
  let away = 0;
  for (const { players, fight } of hub.fights.running()) {
    if (fight) away += players.filter((p) => !hub.seats.has(p)).length;
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
  keep(hub, ws, {
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
  });
  meterSeats(hub);
  sendIfOpen(ws, {
    t: 'welcome',
    world,
    ice: link.ice,
    turn: link.turn,
    now: Date.now(),
    ticket,
  });
  sendLife(hub, ws, who.playerId, undefined, fight?.enc.id);
  // A fighter back during its fight takes back its instance (M12 T5).
  reseatCrowd(hub, ws, who.playerId);
  if (!lock || !fight) return;
  resend(hub, lock, who.playerId);
  // Back in time: the fight goes on in real time.
  awayDue(hub, fight, hub.clock.now());
}

/**
 * Forwards a signal, stamped with the verified sender, to a session the directory places within
 * reach (`relayReach`, M11 T6) that shares water with it (M12 T5), or anywhere between a referee
 * witness and its fight's fighters while that duty runs (M10 T6); nothing else passes (M11 T14). It carries the sender's
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
  const target = hub.seats.socketOf(msg.to);
  if (
    target &&
    target !== ws &&
    ((relayReach(hub, from, msg.to) && sharesWater(hub, from, msg.to)) ||
      hub.duties.linksOf(from).includes(msg.to))
  ) {
    const at = atOf(hub, from);
    const cls = msg.cls === undefined ? {} : { cls: msg.cls };
    send(target, {
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
  send(ws, { t: 'error', code: 'no-peer' });
}

/**
 * A connection that reported anything since the last record leaves its condition behind as a
 * checkpoint; a fighter's leaves nothing, since its fight's settlement writes its records. A lock
 * still asking is no fight yet: its close writes the checkpoint. In the same transaction, a
 * creature that was in the water leaves where it was (`saveLeft`, M12 T10): one row more.
 */
export function saveOnClose(hub: Hub, session: ActiveSession): void {
  const { life, playerId } = session;
  hub.ctx.storage.transactionSync(() => {
    if (life && unsaved(life) && !hub.fights.playerFighting(playerId))
      checkpoint(hub, life, playerId);
    saveLeft(hub, session);
  });
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
  // A socket that never said hello leaves the hellos due.
  hub.seats.forgetHello(ws);
  if (session?.phase === 'queued') {
    keep(hub, ws, { ...session, phase: 'retired' });
    meterSeats(hub);
    if (!replaced) {
      announceQueue(hub);
      hub.rearm().catch(() => {});
    }
  }
  if (session?.phase === 'active') {
    keep(hub, ws, { ...session, phase: 'retired' });
    meterSeats(hub);
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
