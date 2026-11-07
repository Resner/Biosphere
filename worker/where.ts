// The directory on the hub (M11 T6, ADR 0062): `where` and `gone`, the rebuild on a wake, and the
// directory's other uses: the signal relay's reach, courts' distance, carrion notices and the E2E
// view. `worker/directory.ts` holds the tree itself, with no Hub.

import type { ClientMsg, Leaf, Pos } from '../src/net/protocol';
import { RULES } from '../src/sim/rules';
import {
  CARRION_NOTICE_WU,
  COURT_NEAR_WU,
  Directory,
  type DirMember,
  LEAF_MAX,
  queryOf,
  RELAY_SLACK_WU,
  WHERE_JUMP_WU,
  WHERE_SPEED_WU,
} from './directory';
import type { LifeState } from './life';
import {
  type ActiveSession,
  activeSessions,
  type Hub,
  type Session,
  sendIfOpen,
  sessionOf,
} from './socket';

/**
 * A session's last report taken, in its attachment (so a wake rebuilds the directory from the
 * sockets): the centre, radius and AoI (wu), the hub time, and the life binding it was made under.
 */
export interface WhereAt {
  x: number;
  y: number;
  r: number;
  aoi: number;
  t: number;
  bind: string;
}

/** A leaf's member cap: 16, or `LEAF_MAX` (1–16) in fixture mode, so three E2E pages make leaves. */
export function leafMaxOf(env: { DRAND_SOURCE?: string; LEAF_MAX?: string }): number {
  const n = env.DRAND_SOURCE === 'fixture' ? Number(env.LEAF_MAX) : Number.NaN;
  return Number.isInteger(n) && n >= 1 && n <= LEAF_MAX ? n : LEAF_MAX;
}

/** Whether every `where` jump is taken: fixture mode, for debug teleports. */
const jumpsTaken = (env: { DRAND_SOURCE?: string }) => env.DRAND_SOURCE === 'fixture';

/** The binding a report is made under: a genesis, promote, restore or sign-in starts a new one. */
const bindingOf = (life: LifeState | undefined): string =>
  life ? `${life.creature}:${life.startT}` : '';

const memberOf = (s: ActiveSession, at: WhereAt): DirMember => ({
  id: s.playerId,
  name: s.name,
  x: at.x,
  y: at.y,
  r: at.r,
  aoi: at.aoi,
  t: at.t,
});

/** The directory as the sockets' attachments hold it: what a woken object starts from. */
export function rebuildDirectory(
  hub: Pick<Hub, 'ctx' | 'env'>,
  size = RULES.world.size,
): Directory {
  const dir = new Directory(size, { leafMax: leafMaxOf(hub.env) });
  for (const ws of hub.ctx.getWebSockets()) {
    const s = sessionOf(ws);
    if (s?.phase === 'active' && s.where && dir.inside(s.where.x, s.where.y)) {
      dir.report(memberOf(s, s.where));
    }
  }
  return dir;
}

const count = (hub: Hub, t: ClientMsg['t']) => hub.dropped.set(t, (hub.dropped.get(t) ?? 0) + 1);

/** Tells each member a split or merge moved its leaf. */
function tellMoved(hub: Hub, moved: { id: string; leaf: Leaf }[]): void {
  if (moved.length === 0) return;
  const leaves = new Map(moved.map((m) => [m.id, m.leaf]));
  for (const [ws, s] of activeSessions(hub)) {
    const leaf = leaves.get(s.playerId);
    if (leaf) sendIfOpen(ws, { t: 'leaf', leaf });
  }
}

/** The ids of the sessions seated in a pond (the `near` filter until T14). */
function pondOf(hub: Hub, pondId: string): Set<string> {
  const out = new Set<string>();
  for (const [, s] of activeSessions(hub)) if (s.pondId === pondId) out.add(s.playerId);
  return out;
}

/**
 * A report: the directory takes it and answers `near`; members whose leaf a split or merge
 * changed hear `leaf`. A centre outside the world, or a jump further than `WHERE_SPEED_WU` × the
 * seconds since the last report plus `WHERE_JUMP_WU`, is dropped and counted, unless the life was
 * bound anew since (or in fixture mode). Writes no SQLite row.
 */
export function where(
  hub: Hub,
  ws: WebSocket,
  session: ActiveSession,
  msg: ClientMsg & { t: 'where' },
): void {
  const now = hub.clock.now();
  if (!hub.directory.inside(msg.x, msg.y)) {
    count(hub, 'where');
    return;
  }
  const bind = bindingOf(session.life);
  const last = session.where;
  if (last && last.bind === bind && !jumpsTaken(hub.env)) {
    const reach = (WHERE_SPEED_WU * Math.max(0, now - last.t)) / 1000 + WHERE_JUMP_WU;
    if (Math.hypot(msg.x - last.x, msg.y - last.y) > reach) {
      count(hub, 'where');
      return;
    }
  }
  const at: WhereAt = { x: msg.x, y: msg.y, r: msg.r, aoi: msg.aoi, t: now, bind };
  const { moved } = hub.directory.report(memberOf(session, at));
  ws.serializeAttachment({ ...session, where: at } satisfies Session);
  const pond = pondOf(hub, session.pondId);
  const near = hub.directory.near(session.playerId, now, (other) => pond.has(other));
  if (near) sendIfOpen(ws, { t: 'near', ...near });
  tellMoved(hub, moved);
}

/** No creature in the water (or a closed socket): the member leaves the directory. */
export function gone(hub: Hub, ws: WebSocket | null, session: ActiveSession): void {
  if (ws && session.where)
    ws.serializeAttachment({ ...session, where: undefined } satisfies Session);
  tellMoved(hub, hub.directory.remove(session.playerId));
}

/** The sender's directory position as a signal carries it (`at`), when it has reported. */
export function atOf(hub: Hub, player: string): Pos | undefined {
  const m = hub.directory.member(player);
  return m ? [m.x, m.y, m.r] : undefined;
}

/** Whether the directory places two members within reach of a relayed signal: max(their Qs) + 4,096 wu. */
export function relayReach(hub: Hub, a: string, b: string): boolean {
  const [ma, mb] = [hub.directory.member(a), hub.directory.member(b)];
  if (!ma || !mb) return false;
  const reach = Math.max(queryOf(ma.aoi), queryOf(mb.aoi)) + RELAY_SLACK_WU;
  return Math.hypot(ma.x - mb.x, ma.y - mb.y) <= reach;
}

/** Counts a relayed signal by its (unordered) pair, for `GET /v1/e2e/directory`. At most 1,024 pairs are kept, so it cannot grow without bound. */
export function countRelay(hub: Hub, a: string, b: string): void {
  const key = a < b ? `${a}:${b}` : `${b}:${a}`;
  const n = hub.relays.get(key);
  if (n !== undefined || hub.relays.size < 1024) hub.relays.set(key, (n ?? 0) + 1);
}

/**
 * Whether a court between two players is out of reach: the directory places them more than
 * 12,288 wu apart, or knows one of them but not the other. Until clients report (T13) it knows
 * neither, and the pond alone decides, as before.
 */
export function courtTooFar(hub: Hub, a: string, b: string): boolean {
  const [ma, mb] = [hub.directory.member(a), hub.directory.member(b)];
  if (!ma && !mb) return false;
  return !ma || !mb || Math.hypot(ma.x - mb.x, ma.y - mb.y) > COURT_NEAR_WU;
}

/** The players the directory places within 10,000 wu of a kill: its carrion is told to them too. */
export function carrionNoticed(hub: Hub, x: number, y: number): Set<string> {
  return new Set(hub.directory.around(x, y, CARRION_NOTICE_WU));
}

/** The directory as `GET /v1/e2e/directory` shows it: the leaves, each member's leaf and report, and the relays by pair. */
export interface DirectoryView {
  leaves: { leaf: Leaf; members: number }[];
  members: (DirMember & { leaf: Leaf })[];
  relays: Record<string, number>;
}

export function directoryView(hub: Hub): DirectoryView {
  const members: (DirMember & { leaf: Leaf })[] = [];
  for (const [, s] of activeSessions(hub)) {
    const m = hub.directory.member(s.playerId);
    const leaf = hub.directory.leafOf(s.playerId);
    if (m && leaf) members.push({ ...m, leaf });
  }
  return { leaves: hub.directory.leaves(), members, relays: Object.fromEntries(hub.relays) };
}
