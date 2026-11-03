import type { GenesisAsk } from '../ledger/ask';
import type { Canonical } from '../ledger/canonical';
import type { Beacon } from '../ledger/drand';
import type { Commitment } from '../ledger/genesis';
import type { MateAsk } from '../ledger/mate-ask';
import type { RecordKind, RecordRequest, Status, StoredRecord } from '../ledger/record';
import {
  BORN_MAX_BYTES,
  type Born,
  CHAT_MAX_CHARS,
  type ClientMsg,
  CONSUMED_MAX_ENTRIES,
  CONSUMED_MAX_PARTS,
  EMOTE_COUNT,
  EVENT_MAX_BYTES,
  type FallbackInfo,
  GENESIS_MAX_BYTES,
  GENOME_DATA_MAX_CHARS,
  HISTORY_MAX,
  HISTORY_MAX_BYTES,
  HUB_MAX_BYTES,
  type HubMsg,
  type IceServer,
  isCause,
  LINEAGE_MAX,
  LINEAGE_MAX_BYTES,
  type LifeInfo,
  type LineageEntry,
  type Member,
  NAME_RE,
  type PastLife,
  PEDIGREE_MAX,
  type PedigreeNode,
  type PeerEvent,
  PING_KINDS,
  PROTOCOL_VERSION,
  SIGNAL_MAX_BYTES,
  type SignedCommit,
  type Vec2,
  WELCOME_MAX_BYTES,
} from './protocol-defs';
import { encounterClientMsg, encounterHubMsg, lifeFight } from './protocol-encounter';
import {
  byteLength,
  capped,
  GENOME_DATA_RE,
  HEX64_RE,
  ID_RE,
  isInt,
  isNum,
  isObj,
  isStr,
  KEY_ID_RE,
  list,
  MAX_CONDITION,
  MAX_TICK,
  MAX_TIME,
  type Obj,
  PLAYER_ID_RE,
  SIG_RE,
} from './protocol-kit';

export { byteLength };

const NONCE_RE = /^[A-Za-z0-9_-]{22}$/;
const SLOT_RE = /^[A-Za-z0-9_]{1,24}$/;
const CODE_RE = /^[a-z0-9-]{1,32}$/;
/** A drand quicknet signature: 48 bytes of hex. */
const BEACON_SIG_RE = /^[0-9a-f]{96}$/;
/** A species name: two words of letters, as `speciesName` makes them. */
const SPECIES_RE = /^[A-Za-z]{2,40} [A-Za-z]{2,40}$/;
/** Far above any queue the free tier lets build up. */
const MAX_QUEUE = 1_000_000;
const REASON_RE = /^[a-z0-9:-]{1,48}$/;
/** The most a record body may nest and hold, so a hostile body stays small. */
const BODY_MAX_DEPTH = 4;
const BODY_MAX_ENTRIES = 32;
const BODY_MAX_STRING = 256;
/** Every record kind (a `Record`, so a new `RecordKind` fails to compile until it is listed). */
const RECORD_KINDS: Record<RecordKind, true> = {
  genesis: true,
  birth: true,
  checkpoint: true,
  'mate-commit': true,
  promote: true,
  restore: true,
  death: true,
  encounter: true,
};
const isRecordKind = (v: unknown): v is RecordKind =>
  typeof v === 'string' && Object.hasOwn(RECORD_KINDS, v);

const STATUSES: Record<Status, true> = {
  pending: true,
  active: true,
  checkpoint: true,
  dead: true,
};
const isStatus = (v: unknown): v is Status => typeof v === 'string' && Object.hasOwn(STATUSES, v);

// ---------------------------------------------------------------------------------------------
// JSON parsing: every message is untrusted, so each parser copies only the fields it knows.

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
      return capped(raw, {
        t: 'hello',
        v: PROTOCOL_VERSION,
        playerId: o.playerId,
        name: o.name,
        sig: o.sig,
      });
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
    case 'progress':
      return isInt(o.n, 0, MAX_TICK) &&
        isInt(o.ticks, 0, MAX_TICK) &&
        isInt(o.biomass, 0, MAX_CONDITION) &&
        isInt(o.energy, 0, MAX_CONDITION) &&
        isInt(o.health, 0, MAX_CONDITION)
        ? capped(raw, {
            t: 'progress',
            n: o.n,
            ticks: o.ticks,
            biomass: o.biomass,
            energy: o.energy,
            health: o.health,
          })
        : null;
    case 'death':
      return isCause(o.cause) && isInt(o.ticks, 0, MAX_TICK)
        ? capped(raw, { t: 'death', cause: o.cause, ticks: o.ticks })
        : null;
    case 'history':
      return capped(raw, { t: 'history' });
    case 'lineage':
      return capped(raw, { t: 'lineage' });
    case 'promote':
    case 'restore': {
      const request = recordRequest(o.request);
      return request && isStr(o.sig, SIG_RE) ? capped(raw, { t: o.t, request, sig: o.sig }) : null;
    }
    case 'mate-check':
    case 'decline':
      return isStr(o.partner, PLAYER_ID_RE) ? capped(raw, { t: o.t, partner: o.partner }) : null;
    case 'court':
    case 'accept': {
      const ask = mateAsk(o.ask);
      return ask ? capped(raw, { t: o.t, ask }) : null;
    }
    default:
      return encounterClientMsg(o, raw);
  }
}

export function parseHubMsg(raw: string): HubMsg | null {
  const o = parseObject(raw, LINEAGE_MAX_BYTES);
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
      const pending = o.pending === undefined ? undefined : bornOf(o.pending);
      const fallback = o.fallback === undefined ? undefined : fallbackOf(o.fallback);
      if (!(o.life === null || life) || !isInt(o.genesisIn, 0, MAX_TIME) || pending === null) {
        return null;
      }
      if (fallback === null || (o.renewed !== undefined && o.renewed !== true)) return null;
      const fight = lifeFight(o);
      if (!fight) return null;
      return capped(
        raw,
        {
          t: 'life',
          life,
          genesisIn: o.genesisIn,
          ...(pending ? { pending } : {}),
          ...(fallback ? { fallback } : {}),
          ...(o.renewed ? { renewed: true as const } : {}),
          ...fight,
        },
        pending ? BORN_MAX_BYTES : HUB_MAX_BYTES,
      );
    }
    case 'promoted': {
      const life = lifeInfo(o.life);
      const parent = o.parent === null ? null : storedRecord(o.parent);
      return life && (o.parent === null || parent)
        ? capped(raw, { t: 'promoted', life, parent }, GENESIS_MAX_BYTES)
        : null;
    }
    case 'restored': {
      const life = lifeInfo(o.life);
      return life ? capped(raw, { t: 'restored', life }) : null;
    }
    case 'lineage': {
      const creatures = list(o.creatures, LINEAGE_MAX, lineageEntry);
      const pedigree = list(o.pedigree, PEDIGREE_MAX, pedigreeNode);
      return creatures && pedigree
        ? capped(raw, { t: 'lineage', creatures, pedigree }, LINEAGE_MAX_BYTES)
        : null;
    }
    case 'born': {
      const born = bornOf(o);
      return born ? capped(raw, { t: 'born', ...born }, BORN_MAX_BYTES) : null;
    }
    case 'ack':
      return isInt(o.n, 0, MAX_TICK) &&
        isInt(o.activeMs, 0, MAX_TIME) &&
        isInt(o.lifespanMs, 0, MAX_TIME) &&
        isInt(o.matureAtMs, 0, MAX_TIME) &&
        isInt(o.cooldownUntilMs, 0, MAX_TIME)
        ? capped(raw, {
            t: 'ack',
            n: o.n,
            activeMs: o.activeMs,
            lifespanMs: o.lifespanMs,
            matureAtMs: o.matureAtMs,
            cooldownUntilMs: o.cooldownUntilMs,
          })
        : null;
    case 'mate-info':
      return isStr(o.partner, PLAYER_ID_RE) &&
        (o.creature === null || isStr(o.creature, HEX64_RE)) &&
        (o.reason === null || isStr(o.reason, REASON_RE)) &&
        isKinship(o.kinship) &&
        isInt(o.generation, 0, MAX_TICK) &&
        isInt(o.tier, 0, MAX_TICK) &&
        isInt(o.cooldownLeftMs, 0, MAX_TIME)
        ? capped(raw, {
            t: 'mate-info',
            partner: o.partner,
            creature: o.creature,
            reason: o.reason,
            kinship: o.kinship,
            generation: o.generation,
            tier: o.tier,
            cooldownLeftMs: o.cooldownLeftMs,
          })
        : null;
    case 'invite': {
      const ask = mateAsk(o.ask);
      return ask &&
        isStr(o.from, PLAYER_ID_RE) &&
        isKinship(o.kinship) &&
        isInt(o.generation, 0, MAX_TICK)
        ? capped(raw, {
            t: 'invite',
            from: o.from,
            ask,
            kinship: o.kinship,
            generation: o.generation,
          })
        : null;
    }
    case 'declined':
      return isStr(o.by, PLAYER_ID_RE) ? capped(raw, { t: 'declined', by: o.by }) : null;
    case 'mating': {
      const commit = signedCommit(o.commit);
      const record = storedRecord(o.record);
      return commit && record
        ? capped(raw, { t: 'mating', commit, record }, GENESIS_MAX_BYTES)
        : null;
    }
    case 'died': {
      const record = storedRecord(o.record);
      const fallback = o.fallback === undefined ? undefined : fallbackOf(o.fallback);
      if (o.by !== undefined && !isStr(o.by, NAME_RE)) return null;
      return isCause(o.cause) && record && fallback !== null
        ? capped(
            raw,
            {
              t: 'died',
              cause: o.cause,
              record,
              ...(fallback ? { fallback } : {}),
              ...(o.by === undefined ? {} : { by: o.by }),
            },
            GENESIS_MAX_BYTES,
          )
        : null;
    }
    case 'history': {
      if (!Array.isArray(o.lives) || o.lives.length > HISTORY_MAX) return null;
      const lives: PastLife[] = [];
      for (const raw of o.lives) {
        const life = pastLife(raw);
        if (!life) return null;
        lives.push(life);
      }
      return capped(raw, { t: 'history', lives }, HISTORY_MAX_BYTES);
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
    case 'queued':
      return isInt(o.position, 1, MAX_QUEUE) && isInt(o.etaS, 0, MAX_TIME)
        ? capped(raw, { t: 'queued', position: o.position, etaS: o.etaS })
        : null;
    default:
      return encounterHubMsg(o, raw);
  }
}

function pastLife(v: unknown): PastLife | null {
  return isObj(v) &&
    isStr(v.creature, HEX64_RE) &&
    isStr(v.species, SPECIES_RE) &&
    isCause(v.cause) &&
    isInt(v.activeMs, 0, MAX_TIME) &&
    isInt(v.bornT, 0, MAX_TIME) &&
    isInt(v.diedT, 0, MAX_TIME)
    ? {
        creature: v.creature,
        species: v.species,
        cause: v.cause,
        activeMs: v.activeMs,
        bornT: v.bornT,
        diedT: v.diedT,
      }
    : null;
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
    !isInt(v.lifespanMs, 0, MAX_TIME) ||
    !isInt(v.matureAtMs, 0, MAX_TIME) ||
    !isInt(v.cooldownUntilMs, 0, MAX_TIME)
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
    matureAtMs: v.matureAtMs,
    cooldownUntilMs: v.cooldownUntilMs,
  };
}

/** A kinship coefficient: a share between 0 and 1. */
const isKinship = (v: unknown): v is number => isNum(v) && v >= 0 && v <= 1;

/** A signed mate ask, copied field by field. */
function mateAsk(v: unknown): MateAsk | null {
  return isObj(v) &&
    v.v === 1 &&
    v.kind === 'mate' &&
    isStr(v.creature, HEX64_RE) &&
    isStr(v.partner, PLAYER_ID_RE) &&
    isStr(v.partnerCreature, HEX64_RE) &&
    isStr(v.nonce, NONCE_RE) &&
    isStr(v.sig, SIG_RE)
    ? {
        v: 1,
        kind: 'mate',
        creature: v.creature,
        partner: v.partner,
        partnerCreature: v.partnerCreature,
        nonce: v.nonce,
        sig: v.sig,
      }
    : null;
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

function recordRequest(v: unknown): RecordRequest | null {
  if (!isObj(v)) return null;
  const body = canonicalValue(v.body, 0);
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    v.v !== 1 ||
    !isInt(v.rules, 0, MAX_TICK) ||
    !isRecordKind(v.kind) ||
    !isStr(v.creature, HEX64_RE) ||
    !isInt(v.seq, 0, MAX_TIME) ||
    !isStr(v.prev, HEX64_RE) ||
    !isStr(v.owner, PLAYER_ID_RE) ||
    v.t !== undefined
  )
    return null;
  return {
    v: 1,
    rules: v.rules,
    kind: v.kind,
    creature: v.creature,
    seq: v.seq,
    prev: v.prev,
    owner: v.owner,
    body: body as { [key: string]: Canonical },
  };
}

function fallbackOf(v: unknown): FallbackInfo | null {
  if (!isObj(v) || typeof v.pending !== 'boolean') return null;
  if (v.ancestor === null) return { pending: v.pending, ancestor: null };
  const life = lifeInfo(v.ancestor);
  return life && isObj(v.ancestor) && isStr(v.ancestor.hash, HEX64_RE)
    ? { pending: v.pending, ancestor: { ...life, hash: v.ancestor.hash } }
    : null;
}

function lineageEntry(v: unknown): LineageEntry | null {
  if (
    !isObj(v) ||
    !isStr(v.creature, HEX64_RE) ||
    !isStatus(v.status) ||
    !isInt(v.generation, 0, MAX_TICK) ||
    !isStr(v.species, SPECIES_RE) ||
    !isStr(v.genome, GENOME_DATA_RE) ||
    !isInt(v.activeMs, 0, MAX_TIME) ||
    !isInt(v.lifespanMs, 0, MAX_TIME) ||
    !isStr(v.hash, HEX64_RE) ||
    !(v.chainParent === null || isStr(v.chainParent, HEX64_RE))
  )
    return null;
  return {
    creature: v.creature,
    status: v.status,
    generation: v.generation,
    species: v.species,
    genome: v.genome,
    activeMs: v.activeMs,
    lifespanMs: v.lifespanMs,
    hash: v.hash,
    chainParent: v.chainParent,
  };
}

function pedigreeNode(v: unknown): PedigreeNode | null {
  if (
    !isObj(v) ||
    !isStr(v.id, HEX64_RE) ||
    !isStr(v.species, SPECIES_RE) ||
    !isStr(v.genome, GENOME_DATA_RE)
  )
    return null;
  if (v.parents === null) return { id: v.id, parents: null, species: v.species, genome: v.genome };
  const [p0, p1] = Array.isArray(v.parents) && v.parents.length === 2 ? v.parents : [];
  return isStr(p0, HEX64_RE) && isStr(p1, HEX64_RE)
    ? { id: v.id, parents: [p0, p1], species: v.species, genome: v.genome }
    : null;
}

function bornOf(v: unknown): Born | null {
  if (!isObj(v)) return null;
  const record = storedRecord(v.record);
  const commit = signedCommit(v.commit);
  const beacon = parseBeacon(v.beacon);
  const mates = Array.isArray(v.mates) ? v.mates.map(storedRecord) : [];
  const parents = Array.isArray(v.parents) ? v.parents : [];
  if (!record || !commit || !beacon || !isStr(v.genome, GENOME_DATA_RE)) return null;
  if (mates.length !== 2 || parents.length !== 2) return null;
  const [m0, m1] = mates;
  const [p0, p1] = parents;
  if (!m0 || !m1 || !isStr(p0, GENOME_DATA_RE) || !isStr(p1, GENOME_DATA_RE)) return null;
  return { record, commit, beacon, genome: v.genome, parents: [p0, p1], mates: [m0, m1] };
}

function signedCommit(v: unknown): SignedCommit | null {
  if (!isObj(v) || !isStr(v.authSig, SIG_RE) || !isStr(v.keyId, KEY_ID_RE)) return null;
  const c = isObj(v.commitment) ? v.commitment : null;
  if (
    c?.v !== 1 ||
    !isStr(c.owner, PLAYER_ID_RE) ||
    !isInt(c.round, 1, MAX_TICK) ||
    !isStr(c.req, HEX64_RE) ||
    !isInt(c.t, 0, MAX_TIME)
  )
    return null;
  let data: Commitment['data'] | null = null;
  if (c.kind === 'genesis') data = genesisAsk(c.data);
  else if (c.kind === 'mate' && isObj(c.data)) {
    const [a, b] = [mateAsk(c.data.a), mateAsk(c.data.b)];
    data = a && b ? { a: { ...a }, b: { ...b } } : null;
  }
  if (!data || (c.kind !== 'genesis' && c.kind !== 'mate')) return null;
  return {
    commitment: { v: 1, kind: c.kind, owner: c.owner, round: c.round, req: c.req, t: c.t, data },
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
    !isRecordKind(r.kind) ||
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
