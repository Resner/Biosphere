import { parseSignedSeat } from '../ledger/seat-doc';
import { onlyKeys as only } from '../ledger/witness-doc';
import {
  type ClientMsg,
  CROWD_LIST_MAX,
  GOSSIP_MAX,
  type HubMsg,
  INSTANCE_WIRE_MAX,
  type Leaf,
  NAME_RE,
  NEAR_MAX,
  NEAR_MAX_BYTES,
  type NearPeer,
  type PeerEvent,
  type Pos,
  RIDE_NOS,
  SDP_MAX_BYTES,
  SNAPSHOT_RATES,
  SPAWN_WHYS,
  SWARM_MAX,
  WIRE_AOI_MAX,
  WIRE_POS_MAX,
  WIRE_RADIUS_MAX,
  type WorldInfo,
} from './protocol-defs';
import {
  byteLength,
  capped,
  ID_RE,
  isInt,
  isNum,
  isObj,
  isSignalKind,
  isStr,
  isWireClass,
  list,
  MAX_TIME,
  type Obj,
  PLAYER_ID_RE,
  SIG_RE,
} from './protocol-kit';

// Protocol 11 (M11 T2, ADR 0062): the world a welcome names, the directory's `where`, `gone`,
// `near` and `leaf`, seat tickets, and the peer events of gossip, relayed signaling and snapshot
// rates. Protocol 12 (M12 T1, ADR 0064): spawning, riding and crowd instances. Every message here
// is new, so each refuses a field it does not know, at every level it defines. The handlers decide
// what they mean; this only parses.

const isCoord = (v: unknown): v is number => isNum(v) && v >= 0 && v < WIRE_POS_MAX;
const isRadius = (v: unknown): v is number => isNum(v) && v >= 1 && v <= WIRE_RADIUS_MAX;
const isAoi = (v: unknown): v is number => isNum(v) && v >= 1 && v <= WIRE_AOI_MAX;
/** An instance: 0 (the open water) to `INSTANCE_WIRE_MAX`, whole. */
const isInstance = (v: unknown): v is number => isInt(v, 0, INSTANCE_WIRE_MAX);
const oneOf = <T extends string>(xs: readonly T[], v: unknown): v is T =>
  typeof v === 'string' && (xs as readonly string[]).includes(v);

/** A wire position `[x, y, r]`: a centre in the world's reach and a radius of 1 to 4096 wu. */
export function pos(v: unknown): Pos | null {
  if (!Array.isArray(v) || v.length !== 3) return null;
  const [x, y, r] = v;
  return isCoord(x) && isCoord(y) && isRadius(r) ? [x, y, r] : null;
}

/** The world a welcome names: exactly its five fields. */
export function worldInfo(v: unknown): WorldInfo | null {
  if (!isObj(v) || !only(v, ['id', 'seed', 'epoch', 'centre', 'size'])) return null;
  const c = isObj(v.centre) && only(v.centre, ['x', 'y']) ? v.centre : null;
  if (!c || !isNum(c.x) || !isNum(c.y)) return null;
  if (!isStr(v.id, ID_RE) || !isStr(v.seed, ID_RE) || !isInt(v.epoch, 0, MAX_TIME)) return null;
  if (!isNum(v.size) || v.size <= 0 || v.size > WIRE_POS_MAX) return null;
  return { id: v.id, seed: v.seed, epoch: v.epoch, centre: { x: c.x, y: c.y }, size: v.size };
}

function leaf(v: unknown): Leaf | null {
  if (!isObj(v) || !only(v, ['x', 'y', 'size'])) return null;
  return isInt(v.x, 0, COORD_INT_MAX) &&
    isInt(v.y, 0, COORD_INT_MAX) &&
    isInt(v.size, 1, WIRE_POS_MAX)
    ? { x: v.x, y: v.y, size: v.size }
    : null;
}

function nearPeer(v: unknown): NearPeer | null {
  if (!isObj(v) || !only(v, ['id', 'name', 'x', 'y', 'r', 'age', 'n'])) return null;
  return isStr(v.id, PLAYER_ID_RE) &&
    isStr(v.name, NAME_RE) &&
    isCoord(v.x) &&
    isCoord(v.y) &&
    isRadius(v.r) &&
    isInt(v.age, 0, MAX_TIME) &&
    isInstance(v.n)
    ? { id: v.id, name: v.name, x: v.x, y: v.y, r: v.r, age: v.age, n: v.n }
    : null;
}

const COORD_INT_MAX = WIRE_POS_MAX - 1;

function point(v: unknown): [number, number] | null {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const [x, y] = v;
  return isCoord(x) && isCoord(y) ? [x, y] : null;
}

function gossipEntry(v: unknown): [string, number, number, number, number] | null {
  if (!Array.isArray(v) || v.length !== 5) return null;
  const at = pos(v.slice(1, 4));
  const n = v[4];
  return isStr(v[0], PLAYER_ID_RE) && at && isInstance(n) ? [v[0], ...at, n] : null;
}

/** A `where`'s crowd: 1 to `CROWD_LIST_MAX` distinct player ids. */
function crowdList(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const ids = list(v, CROWD_LIST_MAX, (id) => (isStr(id, PLAYER_ID_RE) ? id : null));
  return ids && distinct(ids, (id) => id) ? ids : null;
}

/** Whether no two entries share an id. */
const distinct = <T>(xs: readonly T[], id: (x: T) => string) =>
  new Set(xs.map(id)).size === xs.length;

/** The protocol 11 and 12 messages a client sends, or null (also for any other `t`). */
export function worldClientMsg(o: Obj, raw: string): ClientMsg | null {
  switch (o.t) {
    case 'where': {
      const crowd = o.crowd === undefined ? undefined : crowdList(o.crowd);
      return only(o, ['t', 'x', 'y', 'r', 'aoi', 'crowd']) &&
        crowd !== null &&
        isCoord(o.x) &&
        isCoord(o.y) &&
        isRadius(o.r) &&
        isAoi(o.aoi)
        ? capped(raw, { t: 'where', x: o.x, y: o.y, r: o.r, aoi: o.aoi, ...(crowd && { crowd }) })
        : null;
    }
    case 'gone':
      return only(o, ['t']) ? capped(raw, { t: 'gone' }) : null;
    case 'spawn':
      return only(o, ['t', 'r', 'aoi']) && isRadius(o.r) && isAoi(o.aoi)
        ? capped(raw, { t: 'spawn', r: o.r, aoi: o.aoi })
        : null;
    case 'ride':
      return only(o, ['t']) ? capped(raw, { t: 'ride' }) : null;
    default:
      return null;
  }
}

/** The protocol 11 and 12 messages the hub sends, or null (also for any other `t`). */
export function worldHubMsg(o: Obj, raw: string): HubMsg | null {
  switch (o.t) {
    case 'near': {
      if (!only(o, ['t', 'leaf', 'peers', 'swarm'])) return null;
      const at = leaf(o.leaf);
      const peers = list(o.peers, NEAR_MAX, nearPeer);
      const swarm = list(o.swarm, SWARM_MAX, point);
      return at && peers && swarm && distinct(peers, (p) => p.id)
        ? capped(raw, { t: 'near', leaf: at, peers, swarm }, NEAR_MAX_BYTES)
        : null;
    }
    case 'leaf': {
      const at = only(o, ['t', 'leaf']) ? leaf(o.leaf) : null;
      return at ? capped(raw, { t: 'leaf', leaf: at }) : null;
    }
    case 'seat': {
      const ticket = only(o, ['t', 'ticket']) ? parseSignedSeat(o.ticket) : null;
      return ticket ? capped(raw, { t: 'seat', ticket }) : null;
    }
    case 'spawn':
      return only(o, ['t', 'x', 'y', 'why', 'protect']) &&
        isCoord(o.x) &&
        isCoord(o.y) &&
        oneOf(SPAWN_WHYS, o.why) &&
        typeof o.protect === 'boolean'
        ? capped(raw, { t: 'spawn', x: o.x, y: o.y, why: o.why, protect: o.protect })
        : null;
    case 'ride-no':
      return only(o, ['t', 'why']) && oneOf(RIDE_NOS, o.why)
        ? capped(raw, { t: 'ride-no', why: o.why })
        : null;
    case 'instance':
      return only(o, ['t', 'n']) && isInstance(o.n) ? capped(raw, { t: 'instance', n: o.n }) : null;
    default:
      return null;
  }
}

/** The protocol 11 and 12 peer events, or null (also for any other `t`). The caller caps the size. */
export function worldPeerEvent(o: Obj): PeerEvent | null {
  switch (o.t) {
    case 'hello': {
      const ticket = only(o, ['t', 'ticket', 'n']) ? parseSignedSeat(o.ticket) : null;
      return ticket && isInstance(o.n) ? { t: 'hello', ticket, n: o.n } : null;
    }
    case 'instance':
      return only(o, ['t', 'n']) && isInstance(o.n) ? { t: 'instance', n: o.n } : null;
    case 'peers': {
      const entries = only(o, ['t', 'list']) ? list(o.list, GOSSIP_MAX, gossipEntry) : null;
      return entries && distinct(entries, (e) => e[0]) ? { t: 'peers', list: entries } : null;
    }
    case 'relay': {
      if (!only(o, ['t', 'from', 'to', 'kind', 'sdp', 'cls', 'at', 'pos', 'sig'])) return null;
      const at = pos(o.pos);
      return at &&
        isStr(o.from, PLAYER_ID_RE) &&
        isStr(o.to, PLAYER_ID_RE) &&
        isSignalKind(o.kind) &&
        typeof o.sdp === 'string' &&
        // A refusal carries no description; an offer or answer always does.
        (o.kind === 'refuse' ? o.sdp.length === 0 : o.sdp.length > 0) &&
        byteLength(o.sdp) <= SDP_MAX_BYTES &&
        isWireClass(o.cls) &&
        isInt(o.at, 0, MAX_TIME) &&
        isStr(o.sig, SIG_RE)
        ? {
            t: 'relay',
            from: o.from,
            to: o.to,
            kind: o.kind,
            sdp: o.sdp,
            cls: o.cls,
            at: o.at,
            pos: at,
            sig: o.sig,
          }
        : null;
    }
    case 'rate': {
      const hz = only(o, ['t', 'hz']) ? SNAPSHOT_RATES.find((r) => r === o.hz) : undefined;
      return hz === undefined ? null : { t: 'rate', hz };
    }
    default:
      return null;
  }
}
