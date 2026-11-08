// Where a creature enters the water (M12 T4, ADR 0064): the authority answers a `spawn` with a
// place from `placement.ts`, puts the member in the directory there at once, and anchors every
// binding, so the first report under it must lie near where the hub put the creature.

import { HUNDREDTHS } from '../src/ledger/gates';
import { aoiRadius } from '../src/net/aoi';
import type { ClientMsg, HubMsg, SpawnWhy } from '../src/net/protocol';
import { createRng, seedFromBytes } from '../src/sim/prng';
import { RULES } from '../src/sim/rules';
import { reachSince } from './directory';
import { pondTick } from './engage';
import type { Lock } from './fights';
import { type LifeState, protectionEnds } from './life';
import { type Placed, place, SPAWN_RECENT_MS, type Spawner } from './placement';
import { type ActiveSession, activeSessions, type Hub, type Session, sendIfOpen } from './socket';
import { bindingOf, tellMoved, type WhereAt, whereIn } from './where';
import { worldRow } from './world';

/** The hub keeps at most this many recent spawns, in memory (a wake starts again with none). */
export const RECENT_SPAWNS_MAX = 256;

/** A resume comes back where its creature left the water when that was less than this ago (M12 T10). */
export const BACK_WITHIN_MS = 10 * 60_000;

/**
 * Where a binding must begin (ADR 0064): the place a spawn gave, a promoted child's parent's last
 * report, or a returning fighter's place in its fight. The first report under `bind` must lie
 * within `WHERE_SPEED_WU` × the seconds since `t`, plus `WHERE_JUMP_WU`.
 */
export interface Anchor {
  x: number;
  y: number;
  t: number;
  bind: string;
}

/** The answer a binding got, so a repeat gets the same place. */
export interface Spawned {
  x: number;
  y: number;
  why: SpawnWhy;
  protect: boolean;
  bind: string;
}

/** A spawn the hub gave lately: the recent-spawn clearance keeps the next ones off it. */
export interface RecentSpawn {
  x: number;
  y: number;
  r: number;
  aoi: number;
  t: number;
}

/** The creature entering the water: its life's size when it has one, else what the message states. */
export function spawnerOf(life: LifeState | undefined, msg: { r: number; aoi: number }): Spawner {
  if (!life) return { r: msg.r, adultR: msg.r, aoi: msg.aoi };
  const r = Math.sqrt(Math.max(1, life.biomass / HUNDREDTHS));
  const adultR = Math.max(r, Math.sqrt(life.maxBiomass));
  return { r, adultR, aoi: aoiRadius(r, adultR) };
}

/** Every other member of the directory, by its last report (each with its instance). */
export function othersOf(hub: Hub, self: string): Placed[] {
  const out: Placed[] = [];
  for (const [, s] of activeSessions(hub)) {
    if (s.playerId === self) continue;
    const m = hub.directory.member(s.playerId);
    if (m)
      out.push({ id: m.id, x: m.x, y: m.y, r: m.r, aoi: m.aoi, n: hub.crowds.instanceOf(m.id) });
  }
  return out;
}

/** Notes a spawn the hub gave, keeping the newest `RECENT_SPAWNS_MAX` of the last minute. */
export function remember(hub: Hub, s: RecentSpawn): void {
  // Appended in clock order, so the expired ones are at the front.
  while (hub.spawns[0] && s.t - hub.spawns[0].t >= SPAWN_RECENT_MS) hub.spawns.shift();
  hub.spawns.push(s);
  if (hub.spawns.length > RECENT_SPAWNS_MAX) hub.spawns.shift();
}

const answerOf = (s: Spawned): HubMsg => ({
  t: 'spawn',
  x: s.x,
  y: s.y,
  why: s.why,
  protect: s.protect,
});

/**
 * Answers a `spawn` from a seated session (ADR 0064). A locked creature is refused `spawn`: its
 * page goes back into the fight. A repeat under the same binding gets the same place. A resume of
 * the creature that left the water under `BACK_WITHIN_MS` ago comes `back` there (M12 T10).
 * Otherwise `place()` decides, over the directory's other members and the hub's recent spawns. A
 * genesis or a restore is protected from the answer; a resume and a practice cell are not. The
 * answer anchors the binding and puts the member in the directory there at once, as a report
 * would. Writes no row.
 */
export function spawn(
  hub: Hub,
  ws: WebSocket,
  session: ActiveSession,
  msg: ClientMsg & { t: 'spawn' },
): void {
  if (hub.fights.playerLocked(session.playerId)) {
    sendIfOpen(ws, { t: 'refused', reason: 'spawn' });
    return;
  }
  const bind = bindingOf(session.life);
  if (session.spawned?.bind === bind) {
    sendIfOpen(ws, answerOf(session.spawned));
    return;
  }
  const now = hub.clock.now();
  const spawner = spawnerOf(session.life, msg);
  const protect = session.life !== undefined && session.protectBind === bind;
  // A resume of the creature that left the water lately comes back there (M12 T10).
  const back = protect ? null : leftPlace(hub, session, now);
  const at = back ?? placeFor(hub, session.playerId, spawner, now);
  const why: SpawnWhy = back ? 'back' : 'placed';
  const spawned: Spawned = { x: at.x, y: at.y, why, protect, bind };
  remember(hub, { x: at.x, y: at.y, r: spawner.r, aoi: spawner.aoi, t: now });
  const where: WhereAt = { x: at.x, y: at.y, r: spawner.r, aoi: spawner.aoi, t: now, bind };
  const next: ActiveSession = {
    ...session,
    spawned,
    anchor: { x: at.x, y: at.y, t: now, bind },
    ...(protect ? { protectedUntil: protectionEnds(now), protectBind: undefined } : {}),
  };
  const moved = whereIn(hub, ws, next, where);
  sendIfOpen(ws, answerOf(spawned));
  tellMoved(hub, moved);
}

/** Where `place()` puts the spawner, over the directory's other members and the recent spawns. */
function placeFor(hub: Hub, self: string, spawner: Spawner, now: number): { x: number; y: number } {
  const row = worldRow(hub);
  return place({
    members: othersOf(hub, self),
    recent: hub.spawns,
    spawner,
    centre: { x: row.cx, y: row.cy },
    world: { seed: row.seed, size: RULES.world.size, tick: Math.max(0, pondTick(now, row.epoch)) },
    now,
    rng: createRng(seedFromBytes(crypto.getRandomValues(new Uint8Array(16))), 'spawn'),
  });
}

/** The creature a binding (`creature:startT`, `bindingOf`) was made for. */
const creatureOf = (bind: string): string => bind.slice(0, bind.indexOf(':'));

interface LeftRow extends Record<string, SqlStorageValue> {
  left_x: number | null;
  left_y: number | null;
  left_at: number | null;
  left_creature: string | null;
}

/**
 * Where the session's creature left the water less than `BACK_WITHIN_MS` ago (M12 T10): as this
 * socket's `gone` kept it (`Session.left`), else as the player row's last close wrote it. Null
 * for another creature's place, an older one, or none.
 */
export function leftPlace(
  hub: Hub,
  session: ActiveSession,
  now: number,
): { x: number; y: number } | null {
  const creature = session.life?.creature;
  if (!creature) return null;
  const own = session.left;
  const recent = (t: number) => now - t < BACK_WITHIN_MS;
  if (own && creatureOf(own.bind) === creature && recent(own.t)) return own;
  const row = hub.ctx.storage.sql
    .exec<LeftRow>(
      'SELECT left_x, left_y, left_at, left_creature FROM players WHERE id = ?',
      session.playerId,
    )
    .toArray()[0];
  if (row?.left_creature !== creature || row.left_at === null || !recent(row.left_at)) return null;
  const { left_x: x, left_y: y } = row;
  return x !== null && y !== null && hub.directory.inside(x, y) ? { x, y } : null;
}

/**
 * Writes where the session's creature left the water (M12 T10): its last report, or the one `gone`
 * kept, made under one of that creature's bindings, with that report's time. One row; nothing for
 * a session with no living creature, or whose last place belongs to another creature. The caller
 * runs it in the transaction of the close's checkpoint (`saveOnClose`).
 */
export function saveLeft(hub: Hub, session: ActiveSession): void {
  const { life } = session;
  const at = session.where ?? session.left;
  if (!life || life.over || !at || creatureOf(at.bind) !== life.creature) return;
  leftAt(hub, session.playerId, life.creature, at);
}

/** Stores a creature's place out of the water on its player's row (one row). */
export function leftAt(
  hub: Hub,
  player: string,
  creature: string,
  at: { x: number; y: number; t: number },
): void {
  const cursor = hub.ctx.storage.sql.exec(
    'UPDATE players SET left_x = ?, left_y = ?, left_at = ?, left_creature = ? WHERE id = ?',
    at.x,
    at.y,
    at.t,
    creature,
    player,
  );
  cursor.toArray();
  hub.ledger.rowsWritten += cursor.rowsWritten;
}

/**
 * Whether a report under `bind` may be taken by its anchor (ADR 0064). Only the first report since
 * the anchor is checked: a report past the bound is dropped and flagged `teleport` once per
 * creature; under a binding with no anchor yet it is dropped. The caller counts a drop. Fixture
 * mode takes both, for debug teleports.
 */
export function anchorHolds(
  hub: Hub,
  session: ActiveSession,
  msg: { x: number; y: number },
  bind: string,
  now: number,
): boolean {
  if (hub.env.DRAND_SOURCE === 'fixture') return true;
  const { anchor, where: last } = session;
  const fresh = anchor?.bind === bind;
  // Reported under this binding since its anchor: the jump check against that report decides.
  if (last?.bind === bind && (!fresh || last.t > anchor.t)) return true;
  if (!fresh) return false;
  if (Math.hypot(msg.x - anchor.x, msg.y - anchor.y) <= reachSince(now - anchor.t)) return true;
  if (session.life) {
    hub.ledger.audit.raise('teleport', {
      owner: session.playerId,
      creature: session.life.creature,
      t: now,
    });
  }
  return false;
}

/** An anchor for `life`'s binding at the session's last report (in the water, or as it left it). */
export function anchorAtLast(
  session: Pick<Session & { phase: 'active' }, 'where' | 'left'>,
  life: LifeState | undefined,
): Anchor | undefined {
  const last = session.where ?? session.left;
  return last ? { x: last.x, y: last.y, t: last.t, bind: bindingOf(life) } : undefined;
}

/** An anchor for a fighter returning to its running fight: its place in the authority's encounter. */
export function fightAnchor(
  lock: Lock | undefined,
  player: string,
  life: LifeState | undefined,
  now: number,
): Anchor | undefined {
  const body = lock?.fight?.enc.fighters.find((f) => f.player === player)?.body;
  return body ? { x: body.x, y: body.y, t: now, bind: bindingOf(life) } : undefined;
}
