// The directory on the hub (M11 T6, ADR 0062): `where` and `gone`, the rebuild on a wake, and the
// directory's other uses: the signal relay's reach, courts' distance, carrion notices and the E2E
// view. `worker/directory.ts` holds the tree itself, with no Hub. Beside it run the crowd instances
// (M12 T5, ADR 0064, `worker/crowds.ts`): every report goes to `hub.crowds` too, one timer settles
// what falls due, and whoever doesn't share water is kept apart wherever the hub decides.

import { queryRadius } from '../src/net/aoi';
import { INSTANCE_MAX, OPEN_WATER, sameWater } from '../src/net/instance';
import type { ClientMsg, Leaf, Pos } from '../src/net/protocol';
import { RULES } from '../src/sim/rules';
import { type CrowdContext, type CrowdMember, Crowds, type Moved, QUIET_MS } from './crowds';
import {
  CARRION_NOTICE_WU,
  COURT_NEAR_WU,
  Directory,
  type DirMember,
  LEAF_MAX,
  RELAY_SLACK_WU,
  WHERE_JUMP_WU,
  WHERE_SPEED_WU,
} from './directory';
import type { LifeState } from './life';
import { askLive } from './mating';
import {
  type ActiveSession,
  activeSessions,
  type Hub,
  type Session,
  seated,
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

/** An instance's fill: 16, or `INSTANCE_MAX` (1–16) in fixture mode, so a few E2E pages make a crowd. */
export function instanceMaxOf(env: { DRAND_SOURCE?: string; INSTANCE_MAX?: string }): number {
  const n = env.DRAND_SOURCE === 'fixture' ? Number(env.INSTANCE_MAX) : Number.NaN;
  return Number.isInteger(n) && n >= 1 && n <= INSTANCE_MAX ? n : INSTANCE_MAX;
}

/** How long a crowd stays quiet before it merges: 30 s, or `QUIET_MS` (at least 500) in fixture mode. */
export function quietMsOf(env: { DRAND_SOURCE?: string; QUIET_MS?: string }): number {
  const n = env.DRAND_SOURCE === 'fixture' ? Number(env.QUIET_MS) : Number.NaN;
  return Number.isInteger(n) && n >= 500 ? n : QUIET_MS;
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

/** The crowds as the sockets' attachments hold them (each member's crowd and instance): what a woken object starts from. */
export function rebuildCrowds(hub: Pick<Hub, 'ctx' | 'env' | 'clock'>): Crowds {
  const crowds = new Crowds({ instanceMax: instanceMaxOf(hub.env), quietMs: quietMsOf(hub.env) });
  const members: { m: CrowdMember; crowd: number; n: number }[] = [];
  for (const ws of hub.ctx.getWebSockets()) {
    const s = sessionOf(ws);
    if (s?.phase !== 'active' || !s.where) continue;
    const { x, y, r } = s.where;
    members.push({ m: { id: s.playerId, x, y, r }, crowd: s.crowd?.id ?? 0, n: s.crowd?.n ?? 0 });
  }
  crowds.restore(members, hub.clock.now());
  return crowds;
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

/**
 * What the crowds need of the hub: `locked` and the fight's other fighters from `hub.fights`, the
 * court partners (either way) from the attachments, read once per call, and `around` from the
 * directory.
 */
function crowdContext(hub: Hub): CrowdContext {
  let courts: Map<string, string[]> | null = null;
  return {
    locked: (id) => hub.fights.playerLocked(id),
    partners: (id) => {
      courts ??= courtPairs(hub);
      const fellows = hub.fights.ofPlayer(id)?.players.filter((p) => p !== id) ?? [];
      const court = courts.get(id);
      return court ? [...fellows, ...court] : fellows;
    },
    around: (x, y, radius) =>
      hub.directory.around(x, y, radius).flatMap((id) => {
        const m = hub.directory.member(id);
        return m ? [{ id, x: m.x, y: m.y, r: m.r }] : [];
      }),
  };
}

/** Each player's live court partners, both ways. */
function courtPairs(hub: Hub): Map<string, string[]> {
  const pairs = new Map<string, string[]>();
  const add = (a: string, b: string) => pairs.set(a, [...(pairs.get(a) ?? []), b]);
  const now = Date.now();
  for (const [, s] of activeSessions(hub)) {
    if (s.court && 'ask' in s.court && askLive(s.court.sentAt, now)) {
      add(s.playerId, s.court.ask.partner);
      add(s.court.ask.partner, s.playerId);
    }
  }
  return pairs;
}

/** Tells each member whose instance changed its new one (`instance`), and keeps it in its attachment. */
function tellInstances(hub: Hub, moved: readonly Moved[]): void {
  if (moved.length === 0) return;
  const ids = new Set(moved.map((m) => m.id));
  for (const [ws, s] of activeSessions(hub)) {
    if (!ids.has(s.playerId)) continue;
    const n = hub.crowds.instanceOf(s.playerId);
    const crowd = n === OPEN_WATER ? undefined : { id: hub.crowds.crowdOf(s.playerId), n };
    ws.serializeAttachment({ ...s, crowd } satisfies Session);
    sendIfOpen(ws, { t: 'instance', n });
  }
}

/**
 * Sets the crowds' one timer for `crowds.due()` (a one-shot on `hub.clock`), or clears it. A timer
 * held for the same time or earlier stays: it fires, settles what is due and arms the next one, so
 * a report that only pushes the due time out costs no new timer.
 */
export function armCrowds(hub: Hub): void {
  const at = hub.crowds.due();
  const held = hub.crowdTimer;
  if (held && at !== null && held.at <= at) return;
  if (held) hub.clock.cancel(held.handle);
  hub.crowdTimer = null;
  if (at === null) return;
  const handle = hub.clock.after(Math.max(0, at - hub.clock.now()), () => {
    hub.crowdTimer = null;
    const now = hub.clock.now();
    const ctx = crowdContext(hub);
    releaseKept(hub, now, ctx);
    tellInstances(hub, hub.crowds.settle(now, ctx));
    armCrowds(hub);
  });
  hub.crowdTimer = { at, handle };
}

/** A member leaves the crowds: the others that strayed with it hear theirs, and a socket still open hears 0. */
function leaveCrowds(hub: Hub, ws: WebSocket | null, id: string, now: number, ctx: CrowdContext) {
  const was = hub.crowds.instanceOf(id);
  tellInstances(hub, hub.crowds.remove(id, now, ctx));
  if (!ws) return;
  const s = sessionOf(ws);
  if (s?.phase === 'active' && s.crowd) {
    ws.serializeAttachment({ ...s, crowd: undefined } satisfies Session);
  }
  if (was !== OPEN_WATER) sendIfOpen(ws, { t: 'instance', n: OPEN_WATER });
}

/**
 * The fighters kept out of the water once their fight is over: one with no seat, or seated with no
 * creature in the water, leaves the crowds; one back in the water is a member as any other.
 */
function releaseKept(hub: Hub, now: number, ctx: CrowdContext): void {
  for (const id of hub.crowdsKept) {
    if (hub.fights.playerLocked(id)) continue;
    hub.crowdsKept.delete(id);
    const found = seated(hub, id);
    if (!found?.[1].where) leaveCrowds(hub, found?.[0] ?? null, id, now, ctx);
  }
}

/**
 * A seated session's crowd: a fighter signing in again during its fight takes back its instance,
 * which the crowds kept, or after a wake the instance of a fellow fighter in a crowd. It hears it.
 */
export function reseatCrowd(hub: Hub, ws: WebSocket, player: string): void {
  hub.crowdsKept.delete(player);
  const lock = hub.fights.ofPlayer(player);
  if (lock?.fight && hub.crowds.instanceOf(player) === OPEN_WATER) {
    for (const p of lock.players) {
      const [crowd, m] = [hub.crowds.crowdOf(p), hub.directory.member(p)];
      if (p === player || crowd === 0 || !m) continue;
      const n = hub.crowds.instanceOf(p);
      hub.crowds.restore(
        [{ m: { id: player, x: m.x, y: m.y, r: m.r }, crowd, n }],
        hub.clock.now(),
      );
      break;
    }
  }
  const n = hub.crowds.instanceOf(player);
  const s = sessionOf(ws);
  if (n === OPEN_WATER || s?.phase !== 'active') return;
  ws.serializeAttachment({ ...s, crowd: { id: hub.crowds.crowdOf(player), n } } satisfies Session);
  sendIfOpen(ws, { t: 'instance', n });
  armCrowds(hub);
}

/** Whether two players share water: the same instance, or either in the open water. */
export function sharesWater(hub: Hub, a: string, b: string): boolean {
  return sameWater(hub.crowds.instanceOf(a), hub.crowds.instanceOf(b));
}

/** A `where`'s crowd list with every id that isn't seated dropped (the sender's own stays), or null. */
function seatedCrowd(
  hub: Hub,
  self: string,
  crowd: readonly string[] | undefined,
): string[] | null {
  if (!crowd) return null;
  const here = new Set<string>([self]);
  for (const [, s] of activeSessions(hub)) here.add(s.playerId);
  return crowd.filter((id) => here.has(id));
}

/**
 * A report: the directory takes it, and so do the crowds (with its crowd list, the ids not seated
 * dropped), then it is answered with `near` by the water it shares; members whose leaf a split or
 * merge changed hear `leaf`, and those whose instance changed `instance`. A centre outside the
 * world, or a jump further than `WHERE_SPEED_WU` × the seconds since the last report plus
 * `WHERE_JUMP_WU`, is dropped and counted, unless the life was bound anew since (or in fixture
 * mode). Writes no SQLite row.
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
  const ctx = crowdContext(hub);
  releaseKept(hub, now, ctx);
  const self = { id: session.playerId, x: at.x, y: at.y, r: at.r };
  const crowd = seatedCrowd(hub, session.playerId, msg.crowd);
  tellInstances(hub, hub.crowds.report(self, crowd, now, ctx));
  armCrowds(hub);
  const near = hub.directory.near(session.playerId, now, (id) => hub.crowds.instanceOf(id));
  if (near) sendIfOpen(ws, { t: 'near', ...near });
  tellMoved(hub, moved);
}

/**
 * No creature in the water (or a closed socket): the member leaves the directory and its crowd,
 * except a fighter, whose instance is kept while its fight runs (`crowdsKept`).
 */
export function gone(hub: Hub, ws: WebSocket | null, session: ActiveSession): void {
  const id = session.playerId;
  if (ws && session.where)
    ws.serializeAttachment({ ...session, where: undefined } satisfies Session);
  tellMoved(hub, hub.directory.remove(id));
  if (hub.fights.playerLocked(id) && hub.crowds.instanceOf(id) !== OPEN_WATER) {
    hub.crowdsKept.add(id);
    return;
  }
  leaveCrowds(hub, ws, id, hub.clock.now(), crowdContext(hub));
  armCrowds(hub);
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
  const reach = Math.max(queryRadius(ma.aoi), queryRadius(mb.aoi)) + RELAY_SLACK_WU;
  return Math.hypot(ma.x - mb.x, ma.y - mb.y) <= reach;
}

/** Counts a relayed signal by its (unordered) pair, for `GET /v1/e2e/directory`. The latest 1,024 pairs are kept, so it cannot grow without bound. */
export function countRelay(hub: Hub, a: string, b: string): void {
  const key = a < b ? `${a}:${b}` : `${b}:${a}`;
  const n = hub.relays.get(key);
  if (n === undefined && hub.relays.size >= 1024)
    hub.relays.delete(hub.relays.keys().next().value as string);
  hub.relays.set(key, (n ?? 0) + 1);
}

/**
 * Whether a court between two players is out of reach: the directory alone decides (M11 T14), so
 * it is unless the directory places both within 12,288 wu and they share water (M12 T5).
 */
export function courtTooFar(hub: Hub, a: string, b: string): boolean {
  const d = hub.directory.distance(a, b);
  return d === null || d > COURT_NEAR_WU || !sharesWater(hub, a, b);
}

/** The players the directory places within 10,000 wu of a kill that share water with its victim: its carrion is told to them too. */
export function carrionNoticed(hub: Hub, x: number, y: number, victim: string): Set<string> {
  const n = hub.crowds.instanceOf(victim);
  return new Set(
    hub.directory
      .around(x, y, CARRION_NOTICE_WU)
      .filter((id) => sameWater(n, hub.crowds.instanceOf(id))),
  );
}

/**
 * The directory as `GET /v1/e2e/directory` shows it: the leaves, each member's leaf, report and
 * instance, the relays by pair, and the crowds (M12 T5).
 */
export interface DirectoryView {
  leaves: { leaf: Leaf; members: number }[];
  members: (DirMember & { leaf: Leaf; n: number })[];
  relays: Record<string, number>;
  crowds: ReturnType<Crowds['view']>;
}

export function directoryView(hub: Hub): DirectoryView {
  const members: DirectoryView['members'] = [];
  for (const [, s] of activeSessions(hub)) {
    const m = hub.directory.member(s.playerId);
    const leaf = hub.directory.leafOf(s.playerId);
    if (m && leaf) members.push({ ...m, leaf, n: hub.crowds.instanceOf(s.playerId) });
  }
  return {
    leaves: hub.directory.leaves(),
    members,
    relays: Object.fromEntries(hub.relays),
    crowds: hub.crowds.view(),
  };
}
