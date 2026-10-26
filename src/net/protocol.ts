import type { Canonical } from '../ledger/canonical';
import type { Beacon } from '../ledger/drand';
import type { Commitment, GenesisAsk } from '../ledger/genesis';
import type { StoredRecord } from '../ledger/record';

/** Wire protocol shared by clients and the Worker. No DOM or Node APIs. */
export const PROTOCOL_VERSION = 1;

/** Hub WebSocket close codes. */
export const CLOSE_REPLACED = 4001;
export const CLOSE_BAD_HELLO = 4002;
export const CLOSE_RATE_LIMITED = 4003;
export const CLOSE_ORIGIN = 4004;

/** Size caps in UTF-8 bytes. A `signal` carries an SDP of up to `SDP_MAX_BYTES`, so it gets more room. */
export const HUB_MAX_BYTES = 4096;
/** A welcome lists up to 23 members plus ICE servers with long TURN credentials (about 4.8 KB at worst). */
export const WELCOME_MAX_BYTES = 8192;
export const SIGNAL_MAX_BYTES = 12288;
export const SDP_MAX_BYTES = 8192;
/** A `genesis` carries a record, a commitment, a beacon and a genome text. */
export const GENESIS_MAX_BYTES = 8192;
export const EVENT_MAX_BYTES = 2048;
export const SNAPSHOT_BYTES = 25;
/** The snapshot layout version, the last byte of every snapshot. */
export const SNAPSHOT_VERSION = 2;

export const CHAT_MAX_CHARS = 140;
export const CONSUMED_MAX_ENTRIES = 40;
/** Parts of a whole pond's consumed set: 32 x 32 cells x 10 slots at 40 entries per part. */
export const CONSUMED_MAX_PARTS = 256;
export const EMOTE_COUNT = 6;
export const PING_KINDS = 4;

export const NAME_RE = /^[A-Za-z0-9_-]{3,16}$/;
const PLAYER_ID_RE = /^[A-Za-z0-9_-]{43}$/;
/** An Ed25519 signature (64 bytes) in base64url. */
const SIG_RE = /^[A-Za-z0-9_-]{86}$/;
/** The hub's challenge nonce: 16 bytes, 22 base64url characters. */
export const NONCE_BYTES = 16;
const NONCE_RE = /^[A-Za-z0-9_-]{22}$/;
const SLOT_RE = /^[A-Za-z0-9_]{1,24}$/;
const CODE_RE = /^[a-z0-9-]{1,32}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Genome text: base64url, and short enough that its event stays within `EVENT_MAX_BYTES`. */
export const GENOME_DATA_MAX_CHARS = 1900;
const GENOME_DATA_RE = new RegExp(`^[A-Za-z0-9_-]{1,${GENOME_DATA_MAX_CHARS}}$`);
const HEX64_RE = /^[0-9a-f]{64}$/;
/** A drand quicknet signature: 48 bytes of hex. */
const BEACON_SIG_RE = /^[0-9a-f]{96}$/;
/** An authority key id: 6 bytes of base64url. */
const KEY_ID_RE = /^[A-Za-z0-9_-]{8}$/;
const REASON_RE = /^[a-z0-9:-]{1,48}$/;
/** The most a record body may nest and hold, so a hostile body stays small. */
const BODY_MAX_DEPTH = 4;
const BODY_MAX_ENTRIES = 32;
const BODY_MAX_STRING = 256;

export interface Vec2 {
  x: number;
  y: number;
}

export interface Member {
  playerId: string;
  name: string;
}

/** Joiner `i` of a pond spawns at angle `i · SPAWN_GOLDEN_ANGLE` on the spawn ring (DESIGN.md). */
export const SPAWN_GOLDEN_ANGLE = 2.399963;

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface PondInfo {
  id: string;
  seed: string;
  epoch: number;
  centre: Vec2;
  /** The world's side in wu. */
  size: number;
}

/** A commitment with the authority's countersignature over its id. */
export interface SignedCommit {
  commitment: Commitment;
  authSig: string;
  keyId: string;
}

/** The creature a player resumes: its head and condition (hundredths) and its life clock. */
export interface LifeInfo {
  creature: string;
  seq: number;
  genome: string;
  biomass: number;
  energy: number;
  health: number;
  activeMs: number;
  lifespanMs: number;
}

/** Hub WebSocket, client to hub. */
export type ClientMsg =
  | { t: 'hello'; v: 1; playerId: string; name: string; sig: string }
  | { t: 'genesis-request'; nonce: string; sig: string }
  | { t: 'ping'; id: number }
  | { t: 'signal'; to: string; kind: 'offer' | 'answer'; sdp: string }
  | { t: 'leave' };

/** Hub WebSocket, hub to client. */
export type HubMsg =
  | { t: 'challenge'; nonce: string }
  | {
      t: 'welcome';
      pond: PondInfo;
      you: { spawnHint: Vec2 };
      members: Member[];
      ice: IceServer[];
      turn: boolean;
      now: number;
    }
  | { t: 'pong'; id: number; now: number }
  | { t: 'member'; op: 'join' | 'leave'; member: Member }
  | { t: 'signal'; from: string; kind: 'offer' | 'answer'; sdp: string }
  /** After `welcome`: the player's active creature or null, and ms until the next recorded hatch (0 = now). */
  | { t: 'life'; life: LifeInfo | null; genesisIn: number }
  /** A genesis request was accepted: the committed round, and how many hatches are left. */
  | { t: 'commit'; commit: SignedCommit; hatchesLeft: number }
  /** The committed round's beacon exists: everything a client needs to recompute the DNA. */
  | {
      t: 'genesis';
      record: StoredRecord;
      ownerRequest: GenesisAsk;
      commit: SignedCommit;
      beacon: Beacon;
      genome: string;
    }
  | { t: 'refused'; reason: string; genesisIn?: number }
  | { t: 'error'; code: string };

/** Peer `event` channel: JSON, at most `EVENT_MAX_BYTES`. */
export type PeerEvent =
  | { t: 'claim'; slot: string; k: number; tick: number }
  | {
      t: 'consumed';
      part: number;
      of: number;
      entries: [slot: string, k: number, until: number][];
    }
  | { t: 'chat'; text: string }
  /** The sender's genome as base64url text; a receiver checks it against the snapshots' `genomeRef`. */
  | { t: 'genome'; data: string }
  | { t: 'emote'; id: number }
  | { t: 'ping'; kind: number; x: number; y: number };

/** Peer `state` channel. Energy and health are fractions of their maximum, 0 to 1. */
export interface Snapshot {
  seq: number;
  tick: number;
  x: number;
  y: number;
  heading: number;
  vx: number;
  vy: number;
  biomass: number;
  energy: number;
  health: number;
  alive: boolean;
  dashing: boolean;
  /** The first two bytes of the sender's genome hash, as a u16 (see `genomeRefOf`). */
  genomeRef: number;
}

// Snapshot layout (version 2), little endian, 25 bytes:
//  0 seq u16 | 2 tick u32 | 6 x u16 | 8 y u16 | 10 heading u8 | 11 flags u8 |
// 12 vx i16 | 14 vy i16 | 16 biomass u16 | 18 energy u16 | 20 health u16 | 22 genomeRef u16 |
// 24 version u8 (2)
// Positions are in 0.125 wu steps (0 to 8192 wu), heading in 2π/256, velocity in 0.25 wu/s;
// energy and health are fractions of the creature's maximum, in 1/65535. Biomass is quantised on a
// log scale: q = round(log2(biomass) · 65535 / 24) covers 1 to 2^24 (a body can reach 2.4 million),
// so the relative error is at most 2^(12/65535) - 1 = 0.013%; smaller values read back as 1.
// Version 1 snapshots are 24 bytes and fail the length check.
const TAU = 2 * Math.PI;
const POS_STEP = 0.125;
const VEL_STEP = 0.25;
/** log2 of the largest biomass a snapshot carries. */
const BIOMASS_LOG2_MAX = 24;
const HEADING_STEPS = 256;
const FLAG_ALIVE = 1;
const FLAG_DASHING = 2;
const FLAG_MASK = FLAG_ALIVE | FLAG_DASHING;

function quantize(value: number, step: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  const q = Math.round(value / step);
  return Math.max(min, Math.min(max, q));
}

function encodeBiomass(biomass: number): number {
  if (!Number.isFinite(biomass) || biomass <= 1) return 0;
  return Math.min(0xffff, Math.round((Math.log2(biomass) / BIOMASS_LOG2_MAX) * 0xffff));
}

/** The first two bytes of a hex genome hash: the `genomeRef` that a snapshot carries. */
export function genomeRefOf(hash: string): number {
  const ref = Number.parseInt(hash.slice(0, 4), 16);
  return Number.isNaN(ref) ? 0 : ref;
}

export function encodeSnapshot(s: Snapshot): Uint8Array {
  const out = new Uint8Array(SNAPSHOT_BYTES);
  const v = new DataView(out.buffer);
  v.setUint16(0, s.seq & 0xffff, true);
  v.setUint32(2, s.tick >>> 0, true);
  v.setUint16(6, quantize(s.x, POS_STEP, 0, 0xffff), true);
  v.setUint16(8, quantize(s.y, POS_STEP, 0, 0xffff), true);
  const turns = Number.isFinite(s.heading) ? s.heading / TAU : 0;
  v.setUint8(10, Math.round((turns - Math.floor(turns)) * HEADING_STEPS) & (HEADING_STEPS - 1));
  v.setUint8(11, (s.alive ? FLAG_ALIVE : 0) | (s.dashing ? FLAG_DASHING : 0));
  v.setInt16(12, quantize(s.vx, VEL_STEP, -0x8000, 0x7fff), true);
  v.setInt16(14, quantize(s.vy, VEL_STEP, -0x8000, 0x7fff), true);
  v.setUint16(16, encodeBiomass(s.biomass), true);
  v.setUint16(18, quantize(s.energy, 1 / 0xffff, 0, 0xffff), true);
  v.setUint16(20, quantize(s.health, 1 / 0xffff, 0, 0xffff), true);
  v.setUint16(22, s.genomeRef & 0xffff, true);
  v.setUint8(24, SNAPSHOT_VERSION);
  return out;
}

/** Returns null for anything that is not a well-formed snapshot. Never throws. */
export function decodeSnapshot(b: Uint8Array): Snapshot | null {
  if (!(b instanceof Uint8Array) || b.length !== SNAPSHOT_BYTES) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const flags = v.getUint8(11);
  if ((flags & ~FLAG_MASK) !== 0 || v.getUint8(24) !== SNAPSHOT_VERSION) return null;
  return {
    seq: v.getUint16(0, true),
    tick: v.getUint32(2, true),
    x: v.getUint16(6, true) * POS_STEP,
    y: v.getUint16(8, true) * POS_STEP,
    heading: (v.getUint8(10) * TAU) / HEADING_STEPS,
    vx: v.getInt16(12, true) * VEL_STEP,
    vy: v.getInt16(14, true) * VEL_STEP,
    biomass: 2 ** ((v.getUint16(16, true) * BIOMASS_LOG2_MAX) / 0xffff),
    energy: v.getUint16(18, true) / 0xffff,
    health: v.getUint16(20, true) / 0xffff,
    alive: (flags & FLAG_ALIVE) !== 0,
    dashing: (flags & FLAG_DASHING) !== 0,
    genomeRef: v.getUint16(22, true),
  };
}

// ---------------------------------------------------------------------------------------------
// JSON parsing: every message is untrusted, so each parser copies only the fields it knows.

type Obj = Record<string, unknown>;

/** UTF-8 length without TextEncoder, which keeps this module free of runtime APIs. */
export function byteLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** Parses a JSON object, or returns null on bad JSON, a non-object or any `__proto__` key. */
function parseObject(raw: unknown, maxBytes: number): Obj | null {
  // A string longer than the cap in UTF-16 units can still fit in bytes only when it is shorter,
  // so check the cheap bound first.
  if (typeof raw !== 'string' || raw.length > maxBytes || byteLength(raw) > maxBytes) return null;
  let poisoned = false;
  let value: unknown;
  try {
    value = JSON.parse(raw, (key, v) => {
      if (key === '__proto__') poisoned = true;
      return v;
    });
  } catch {
    return null;
  }
  if (poisoned || typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Obj;
}

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown, re: RegExp): v is string => typeof v === 'string' && re.test(v);
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

const MAX_TICK = 0xffffffff;
const MAX_TIME = Number.MAX_SAFE_INTEGER;

function vec(v: unknown): Vec2 | null {
  return isObj(v) && isNum(v.x) && isNum(v.y) ? { x: v.x, y: v.y } : null;
}

function member(v: unknown): Member | null {
  if (!isObj(v) || !isStr(v.playerId, PLAYER_ID_RE) || !isStr(v.name, NAME_RE)) return null;
  return { playerId: v.playerId, name: v.name };
}

function iceServer(v: unknown): IceServer | null {
  if (!isObj(v)) return null;
  const urls = v.urls;
  const okUrl = (u: unknown): u is string =>
    typeof u === 'string' && u.length > 0 && u.length <= 256;
  if (!(okUrl(urls) || (Array.isArray(urls) && urls.length <= 8 && urls.every(okUrl)))) return null;
  const out: IceServer = { urls: Array.isArray(urls) ? [...urls] : urls };
  for (const key of ['username', 'credential'] as const) {
    const field = v[key];
    if (field === undefined) continue;
    if (typeof field !== 'string' || field.length > 512) return null;
    out[key] = field;
  }
  return out;
}

function list<T>(v: unknown, max: number, item: (x: unknown) => T | null): T[] | null {
  if (!Array.isArray(v) || v.length > max) return null;
  const out: T[] = [];
  for (const x of v) {
    const parsed = item(x);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
}

/** True for a well-formed `hello` that speaks another protocol version: worth an `error`, not a silent close. */
export function isOtherVersionHello(raw: string): boolean {
  const o = parseObject(raw, SIGNAL_MAX_BYTES);
  return o !== null && o.t === 'hello' && typeof o.v === 'number' && o.v !== PROTOCOL_VERSION;
}

export function parseClientMsg(raw: string): ClientMsg | null {
  const o = parseObject(raw, SIGNAL_MAX_BYTES);
  if (!o) return null;
  switch (o.t) {
    case 'hello':
      if (o.v !== PROTOCOL_VERSION) return null;
      if (!isStr(o.playerId, PLAYER_ID_RE) || !isStr(o.name, NAME_RE) || !isStr(o.sig, SIG_RE))
        return null;
      return capped(raw, { t: 'hello', v: 1, playerId: o.playerId, name: o.name, sig: o.sig });
    case 'ping':
      return isInt(o.id, 0, MAX_TICK) ? capped(raw, { t: 'ping', id: o.id }) : null;
    case 'signal':
      if (!isStr(o.to, PLAYER_ID_RE) || !isSignalPayload(o)) return null;
      return { t: 'signal', to: o.to, kind: o.kind, sdp: o.sdp };
    case 'leave':
      return capped(raw, { t: 'leave' });
    case 'genesis-request':
      return isStr(o.nonce, NONCE_RE) && isStr(o.sig, SIG_RE)
        ? capped(raw, { t: 'genesis-request', nonce: o.nonce, sig: o.sig })
        : null;
    default:
      return null;
  }
}

export function parseHubMsg(raw: string): HubMsg | null {
  const o = parseObject(raw, SIGNAL_MAX_BYTES);
  if (!o) return null;
  switch (o.t) {
    case 'challenge':
      return isStr(o.nonce, NONCE_RE) ? capped(raw, { t: 'challenge', nonce: o.nonce }) : null;
    case 'welcome':
      return capped(raw, welcome(o), WELCOME_MAX_BYTES);
    case 'pong':
      return isInt(o.id, 0, MAX_TICK) && isInt(o.now, 0, MAX_TIME)
        ? capped(raw, { t: 'pong', id: o.id, now: o.now })
        : null;
    case 'member': {
      const m = member(o.member);
      return (o.op === 'join' || o.op === 'leave') && m
        ? capped(raw, { t: 'member', op: o.op, member: m })
        : null;
    }
    case 'signal':
      if (!isStr(o.from, PLAYER_ID_RE) || !isSignalPayload(o)) return null;
      return { t: 'signal', from: o.from, kind: o.kind, sdp: o.sdp };
    case 'error':
      return isStr(o.code, CODE_RE) ? capped(raw, { t: 'error', code: o.code }) : null;
    case 'life': {
      const life = o.life === null ? null : lifeInfo(o.life);
      return (o.life === null || life) && isInt(o.genesisIn, 0, MAX_TIME)
        ? capped(raw, { t: 'life', life, genesisIn: o.genesisIn })
        : null;
    }
    case 'commit': {
      const commit = signedCommit(o.commit);
      return commit && isInt(o.hatchesLeft, 0, 100)
        ? capped(raw, { t: 'commit', commit, hatchesLeft: o.hatchesLeft })
        : null;
    }
    case 'genesis': {
      const record = storedRecord(o.record);
      const commit = signedCommit(o.commit);
      const ask = genesisAsk(o.ownerRequest);
      const beacon = parseBeacon(o.beacon);
      return record && commit && ask && beacon && isStr(o.genome, GENOME_DATA_RE)
        ? capped(
            raw,
            { t: 'genesis', record, ownerRequest: ask, commit, beacon, genome: o.genome },
            GENESIS_MAX_BYTES,
          )
        : null;
    }
    case 'refused':
      if (!isStr(o.reason, REASON_RE)) return null;
      if (o.genesisIn === undefined) return capped(raw, { t: 'refused', reason: o.reason });
      return isInt(o.genesisIn, 0, MAX_TIME)
        ? capped(raw, { t: 'refused', reason: o.reason, genesisIn: o.genesisIn })
        : null;
    default:
      return null;
  }
}

function genesisAsk(v: unknown): GenesisAsk | null {
  return isObj(v) && isStr(v.nonce, NONCE_RE) && isStr(v.sig, SIG_RE)
    ? { nonce: v.nonce, sig: v.sig }
    : null;
}

function parseBeacon(v: unknown): Beacon | null {
  return isObj(v) && isInt(v.round, 1, MAX_TICK) && isStr(v.signature, BEACON_SIG_RE)
    ? { round: v.round, signature: v.signature }
    : null;
}

function lifeInfo(v: unknown): LifeInfo | null {
  if (
    !isObj(v) ||
    !isStr(v.creature, HEX64_RE) ||
    !isInt(v.seq, 0, MAX_TIME) ||
    !isStr(v.genome, GENOME_DATA_RE) ||
    !isInt(v.biomass, 0, MAX_TIME) ||
    !isInt(v.energy, 0, MAX_TIME) ||
    !isInt(v.health, 0, MAX_TIME) ||
    !isInt(v.activeMs, 0, MAX_TIME) ||
    !isInt(v.lifespanMs, 0, MAX_TIME)
  )
    return null;
  return {
    creature: v.creature,
    seq: v.seq,
    genome: v.genome,
    biomass: v.biomass,
    energy: v.energy,
    health: v.health,
    activeMs: v.activeMs,
    lifespanMs: v.lifespanMs,
  };
}

/** A canonical value (integers and strings only), bounded in depth, size and string length. */
function canonicalValue(v: unknown, depth: number): Canonical | null {
  if (typeof v === 'string') return v.length <= BODY_MAX_STRING ? v : null;
  if (typeof v === 'number') return Number.isSafeInteger(v) ? v : null;
  if (depth >= BODY_MAX_DEPTH) return null;
  if (Array.isArray(v)) {
    return v.length <= BODY_MAX_ENTRIES ? listOf(v, depth) : null;
  }
  if (!isObj(v)) return null;
  const keys = Object.keys(v);
  if (keys.length > BODY_MAX_ENTRIES) return null;
  const out: { [key: string]: Canonical } = {};
  for (const key of keys) {
    const value = canonicalValue(v[key], depth + 1);
    if (value === null || key.length > BODY_MAX_STRING) return null;
    out[key] = value;
  }
  return out;
}

function listOf(v: unknown[], depth: number): Canonical[] | null {
  const out: Canonical[] = [];
  for (const x of v) {
    const value = canonicalValue(x, depth + 1);
    if (value === null) return null;
    out.push(value);
  }
  return out;
}

function signedCommit(v: unknown): SignedCommit | null {
  if (!isObj(v) || !isStr(v.authSig, SIG_RE) || !isStr(v.keyId, KEY_ID_RE)) return null;
  const c = isObj(v.commitment) ? v.commitment : null;
  const data = c ? genesisAsk(c.data) : null;
  if (
    !c ||
    !data ||
    c.v !== 1 ||
    c.kind !== 'genesis' ||
    !isStr(c.owner, PLAYER_ID_RE) ||
    !isInt(c.round, 1, MAX_TICK) ||
    !isStr(c.req, HEX64_RE) ||
    !isInt(c.t, 0, MAX_TIME)
  )
    return null;
  return {
    commitment: { v: 1, kind: 'genesis', owner: c.owner, round: c.round, req: c.req, t: c.t, data },
    authSig: v.authSig,
    keyId: v.keyId,
  };
}

function storedRecord(v: unknown): StoredRecord | null {
  if (!isObj(v) || !isStr(v.hash, HEX64_RE) || !isStr(v.authSig, SIG_RE)) return null;
  if (!isStr(v.keyId, KEY_ID_RE)) return null;
  if (v.ownerSig !== null && !isStr(v.ownerSig, SIG_RE)) return null;
  const r = isObj(v.record) ? v.record : null;
  const body = r ? canonicalValue(r.body, 0) : null;
  if (
    !r ||
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    r.v !== 1 ||
    !isInt(r.rules, 0, MAX_TICK) ||
    (r.kind !== 'genesis' && r.kind !== 'checkpoint' && r.kind !== 'death') ||
    !(r.creature === '' || isStr(r.creature, HEX64_RE)) ||
    !isInt(r.seq, 0, MAX_TIME) ||
    !(r.prev === '' || isStr(r.prev, HEX64_RE)) ||
    !isStr(r.owner, PLAYER_ID_RE) ||
    !isInt(r.t, 0, MAX_TIME)
  )
    return null;
  return {
    record: {
      v: 1,
      rules: r.rules,
      kind: r.kind,
      creature: r.creature as string,
      seq: r.seq,
      prev: r.prev as string,
      owner: r.owner,
      t: r.t,
      body: body as { [key: string]: Canonical },
    },
    hash: v.hash,
    ownerSig: v.ownerSig as string | null,
    authSig: v.authSig,
    keyId: v.keyId,
  };
}

function isSignalPayload(o: Obj): o is Obj & { kind: 'offer' | 'answer'; sdp: string } {
  return (
    (o.kind === 'offer' || o.kind === 'answer') &&
    typeof o.sdp === 'string' &&
    o.sdp.length > 0 &&
    byteLength(o.sdp) <= SIGNAL_MAX_BYTES
  );
}

/** Only signals and the welcome may exceed `HUB_MAX_BYTES`. */
function capped<T extends ClientMsg | HubMsg>(
  raw: string,
  msg: T | null,
  max = HUB_MAX_BYTES,
): T | null {
  return msg !== null && byteLength(raw) <= max ? msg : null;
}

function welcome(o: Obj): HubMsg | null {
  const pond = isObj(o.pond) ? o.pond : null;
  const centre = pond ? vec(pond.centre) : null;
  const hint = isObj(o.you) ? vec(o.you.spawnHint) : null;
  const members = list(o.members, 64, member);
  const ice = list(o.ice, 8, iceServer);
  if (
    !pond ||
    !centre ||
    !hint ||
    !members ||
    !ice ||
    !isStr(pond.id, ID_RE) ||
    !isStr(pond.seed, ID_RE) ||
    !isInt(pond.epoch, 0, MAX_TIME) ||
    !isNum(pond.size) ||
    pond.size <= 0 ||
    typeof o.turn !== 'boolean' ||
    !isInt(o.now, 0, MAX_TIME)
  )
    return null;
  return {
    t: 'welcome',
    pond: { id: pond.id, seed: pond.seed, epoch: pond.epoch, centre, size: pond.size },
    you: { spawnHint: hint },
    members,
    ice,
    turn: o.turn,
    now: o.now,
  };
}

function consumedEntry(v: unknown): [string, number, number] | null {
  if (!Array.isArray(v) || v.length !== 3) return null;
  const [slot, k, until] = v;
  return isStr(slot, SLOT_RE) && isInt(k, 0, MAX_TICK) && isInt(until, 0, MAX_TICK)
    ? [slot, k, until]
    : null;
}

export function parsePeerEvent(raw: string): PeerEvent | null {
  const o = parseObject(raw, EVENT_MAX_BYTES);
  if (!o) return null;
  switch (o.t) {
    case 'claim':
      return isStr(o.slot, SLOT_RE) && isInt(o.k, 0, MAX_TICK) && isInt(o.tick, 0, MAX_TICK)
        ? { t: 'claim', slot: o.slot, k: o.k, tick: o.tick }
        : null;
    case 'consumed': {
      const entries = list(o.entries, CONSUMED_MAX_ENTRIES, consumedEntry);
      return entries && isInt(o.of, 1, CONSUMED_MAX_PARTS) && isInt(o.part, 0, (o.of as number) - 1)
        ? { t: 'consumed', part: o.part, of: o.of as number, entries }
        : null;
    }
    case 'chat':
      return typeof o.text === 'string' && o.text.length > 0 && o.text.length <= CHAT_MAX_CHARS
        ? { t: 'chat', text: o.text }
        : null;
    case 'genome':
      return isStr(o.data, GENOME_DATA_RE) ? { t: 'genome', data: o.data } : null;
    case 'emote':
      return isInt(o.id, 0, EMOTE_COUNT - 1) ? { t: 'emote', id: o.id } : null;
    case 'ping':
      return isInt(o.kind, 0, PING_KINDS - 1) && isNum(o.x) && isNum(o.y)
        ? { t: 'ping', kind: o.kind, x: o.x, y: o.y }
        : null;
    default:
      return null;
  }
}
