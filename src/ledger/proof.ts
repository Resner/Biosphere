import { GENOME_TEXT_LENGTH } from '../genome/codec';
import type { SignedCommit } from '../net/protocol-defs';
import {
  byteLength,
  ID_RE,
  isObj,
  isStr,
  KEY_ID_RE,
  list,
  MAX_CONDITION,
  type Obj,
  PLAYER_ID_RE,
  SIG_RE,
} from '../net/protocol-kit';
import { FIGHTER_WORTHS } from '../sim/encounter/types';
import { type Canonical, canonicalize } from './canonical';
import type { Beacon } from './drand';
import type { Scales } from './gates';
import type { Commitment } from './genesis';
import { isPlayerId } from './identity';
import { HEX64, type LedgerRecord, recordProblems, type StoredRecord } from './record';
import {
  type FightLog,
  refereeTail,
  type SettledFighter,
  type Settlement,
  type SignedSettlement,
} from './settlement';
import { parseSignedAttestation, type SignedAttestation } from './witness-doc';

// Proof bundles (ADR 0055): what a verifier needs to check a creature's history without trusting
// anyone, as the authority serves it (`GET /v1/proof/<creature>`), and a fight's log and settlement
// (`GET /v1/fight/<enc>`). Both arrive as untrusted JSON: the parsers cap every list and string,
// rebuild every object from checked fields, and never throw. Pure and shared: no DOM, no Node APIs.

export const PROOF_MAX_CREATURES = 64;
/** The most a bundle's JSON may weigh, in UTF-8 bytes. */
export const PROOF_MAX_BYTES = 524_288;
/** The most a fight proof's JSON may weigh: a 90 s fight of four is far below it. */
export const FIGHT_PROOF_MAX_BYTES = 524_288;

/** The caps of a bundle's lists, so a hostile bundle cannot make the verifier work without end. */
export const PROOF_CAPS = Object.freeze({
  records: 4096,
  keys: 512,
  commits: 1024,
  beacons: 1024,
  settlements: 1024,
  flags: 1024,
  more: 2 * PROOF_MAX_CREATURES,
  witnessCommits: 1024,
  attestations: 2048,
});

/** An authority key as `/v1/pubkeys` lists it: in force for records from `from` (ms). */
export interface AuthorityKey {
  id: string;
  publicKey: string;
  from: number;
}

/** One of the authority's notes on a held creature (the kinds are the audit's, T8). */
export interface AuditFlag {
  creature: string;
  kind: string;
  t: number;
}

/**
 * Version 2 (ADR 0058) adds the witness documents. A version 1 bundle parses as one with both
 * lists empty: its events show as authority-only.
 */
export interface ProofBundle {
  v: 2;
  kind: 'proof';
  subject: string;
  world: { epoch: number; rules: number; scales: Scales };
  keys: AuthorityKey[];
  /** The subject first, then its ancestors nearest first. */
  creatures: { id: string; genome: string }[];
  /**
   * Per creature from seq 0 with no gap: the subject's whole chain, an ancestor's up to the record
   * that ties it to its descendant.
   */
  records: StoredRecord[];
  /** Every genesis and mating commitment a record names. */
  commits: SignedCommit[];
  /** Every committed round. */
  beacons: Beacon[];
  /** Every encounter a record names. */
  settlements: SignedSettlement[];
  flags: AuditFlag[];
  /** Parents of held creatures that are not held. */
  more: string[];
  /** The witness commitments (kind `witness`, owner `''`) of the held fights, matings and geneses it still keeps. */
  witnessCommits: SignedCommit[];
  /** Every attestation it holds for those events. */
  attestations: SignedAttestation[];
  /** When the authority served it. */
  t: number;
}

/** A fight's settlement and its log, null once the log is pruned. */
export interface FightProof {
  settlement: SignedSettlement;
  log: FightLog | null;
}

const BEACON_SIG = /^[0-9a-f]{96}$/;
/** A fight's end state (`hashEncounter`): 64 bits as hex. */
const STATE_HASH = /^[0-9a-f]{16}$/;
/** A genome's text: base64url of its bytes (595 characters). */
const GENOME_TEXT = new RegExp(`^[A-Za-z0-9_-]{${GENOME_TEXT_LENGTH}}$`);
/** A flag's kind or a fighter's cause or outcome: a short lower-case word. */
const WORD = /^[a-z][a-z0-9:-]{0,31}$/;
/** A fight has at most 4 slots; a log at most this many frames (a 90 s fight is 900). */
const MAX_SLOTS = 4;
const MAX_FRAMES = 4096;
const POS_MAX = 8192;
const U32_MAX = 0xffffffff;
/** The JSON of a commitment's request data: two signed mate asks fit well within it. */
const DATA_MAX_BYTES = 2048;

const uint = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number =>
  Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max;
const hex = (v: unknown): v is string => isStr(v, HEX64);
const num = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
/** Exactly these keys, and at most these optional ones. */
const keysIn = (o: Obj, required: readonly string[], optional: readonly string[] = []): boolean =>
  required.every((k) => Object.hasOwn(o, k)) &&
  Object.keys(o).every((k) => required.includes(k) || optional.includes(k));

/** The value of untrusted JSON text, or the value itself, when its JSON is within `max` bytes. */
function within(json: unknown, max: number): unknown {
  if (typeof json === 'string') {
    // A UTF-8 byte is at most one UTF-16 unit: a longer text is over the cap however it encodes.
    if (json.length > max || byteLength(json) > max) return undefined;
    return JSON.parse(json);
  }
  const text = JSON.stringify(json);
  return typeof text === 'string' && byteLength(text) <= max ? json : undefined;
}

function scales(v: unknown): Scales | null {
  return isObj(v) &&
    keysIn(v, ['lifespan', 'mating']) &&
    num(v.lifespan, Number.MIN_VALUE, 1) &&
    num(v.mating, Number.MIN_VALUE, 1)
    ? { lifespan: v.lifespan, mating: v.mating }
    : null;
}

function key(v: unknown): AuthorityKey | null {
  return isObj(v) &&
    keysIn(v, ['id', 'publicKey', 'from']) &&
    isStr(v.id, KEY_ID_RE) &&
    isStr(v.publicKey, PLAYER_ID_RE) &&
    uint(v.from)
    ? { id: v.id, publicKey: v.publicKey, from: v.from }
    : null;
}

/** Authority keys from untrusted JSON: a list, or `GET /v1/pubkeys`'s `{ keys }`. Null when any is malformed. */
export function parseAuthorityKeys(v: unknown): AuthorityKey[] | null {
  return list(isObj(v) ? v.keys : v, PROOF_CAPS.keys, key);
}

function creature(v: unknown): { id: string; genome: string } | null {
  return isObj(v) && keysIn(v, ['id', 'genome']) && hex(v.id) && isStr(v.genome, GENOME_TEXT)
    ? { id: v.id, genome: v.genome }
    : null;
}

/** A countersigned document's signature fields. */
const signed = (v: Obj): boolean => isStr(v.authSig, SIG_RE) && isStr(v.keyId, KEY_ID_RE);

function storedRecord(v: unknown): StoredRecord | null {
  if (!isObj(v) || !keysIn(v, ['record', 'hash', 'ownerSig', 'authSig', 'keyId'])) return null;
  if (!hex(v.hash) || !signed(v) || !(v.ownerSig === null || isStr(v.ownerSig, SIG_RE)))
    return null;
  if (recordProblems(v.record).length > 0) return null;
  const r = v.record as LedgerRecord;
  // Its body passed `bodyProblems` and `canonicalize`: plain objects of integers and strings.
  const body = JSON.parse(canonicalize(r.body)) as LedgerRecord['body'];
  const record: LedgerRecord = {
    v: 1,
    rules: r.rules,
    kind: r.kind,
    creature: r.creature,
    seq: r.seq,
    prev: r.prev,
    owner: r.owner,
    t: r.t,
    body,
  };
  return {
    record,
    hash: v.hash,
    ownerSig: v.ownerSig as string | null,
    authSig: v.authSig as string,
    keyId: v.keyId as string,
  };
}

/**
 * A countersigned commitment: in `commits` a genesis's or a mating's, owned by its player; in
 * `witnessCommits` a witness commitment, which the authority makes for itself (owner `''`).
 */
function signedCommit(v: unknown, witness = false): SignedCommit | null {
  if (!isObj(v) || !keysIn(v, ['commitment', 'authSig', 'keyId']) || !signed(v)) return null;
  const c = v.commitment;
  if (!isObj(c) || !keysIn(c, ['v', 'kind', 'owner', 'round', 'req', 't', 'data'])) return null;
  if (c.v !== 1 || typeof c.kind !== 'string') return null;
  if (witness ? c.kind !== 'witness' || c.owner !== '' : c.kind !== 'genesis' && c.kind !== 'mate')
    return null;
  if (typeof c.owner !== 'string' || !(witness || isPlayerId(c.owner))) return null;
  if (!uint(c.round) || c.round < 1 || !hex(c.req) || !uint(c.t)) return null;
  // The request data is checked by `checkGenesis`, `checkBirth` and `witnessDataProblems`; here it only has to hash.
  let data: Canonical;
  try {
    const text = canonicalize(c.data as Canonical);
    if (byteLength(text) > DATA_MAX_BYTES) return null;
    data = JSON.parse(text) as Canonical;
  } catch {
    return null;
  }
  const commitment: Commitment = {
    v: 1,
    kind: c.kind,
    owner: c.owner,
    round: c.round,
    req: c.req,
    t: c.t,
    data,
  };
  return { commitment, authSig: v.authSig as string, keyId: v.keyId as string };
}

function beacon(v: unknown): Beacon | null {
  return isObj(v) &&
    keysIn(v, ['round', 'signature']) &&
    uint(v.round) &&
    v.round >= 1 &&
    isStr(v.signature, BEACON_SIG)
    ? { round: v.round, signature: v.signature }
    : null;
}

const EGGS: readonly string[] = ['none', 'kept', 'eaten'];
const RESULT_KEYS = [
  'player',
  'creature',
  'outcome',
  'frame',
  'egg',
  'biomass',
  'energy',
  'health',
  'reward',
];

function settledFighter(v: unknown): SettledFighter | null {
  if (!isObj(v) || !keysIn(v, RESULT_KEYS, ['cause', 'by', 'eggBy'])) return null;
  const optional = (k: string, ok: (x: unknown) => boolean) => !Object.hasOwn(v, k) || ok(v[k]);
  const slot = (x: unknown) => uint(x, MAX_SLOTS - 1);
  if (
    !isStr(v.player, PLAYER_ID_RE) ||
    !hex(v.creature) ||
    !isStr(v.outcome, WORD) ||
    !optional('cause', (x) => isStr(x, WORD)) ||
    !optional('by', slot) ||
    !uint(v.frame, U32_MAX) ||
    typeof v.egg !== 'string' ||
    !EGGS.includes(v.egg) ||
    !optional('eggBy', slot) ||
    !uint(v.biomass) ||
    !uint(v.energy) ||
    !uint(v.health) ||
    !uint(v.reward)
  ) {
    return null;
  }
  return {
    player: v.player,
    creature: v.creature,
    outcome: v.outcome,
    ...(Object.hasOwn(v, 'cause') ? { cause: v.cause as string } : {}),
    ...(Object.hasOwn(v, 'by') ? { by: v.by as number } : {}),
    frame: v.frame,
    egg: v.egg as SettledFighter['egg'],
    ...(Object.hasOwn(v, 'eggBy') ? { eggBy: v.eggBy as number } : {}),
    biomass: v.biomass,
    energy: v.energy,
    health: v.health,
    reward: v.reward,
  };
}

const SETTLEMENT_KEYS = [
  'v',
  'kind',
  'rules',
  'enc',
  'pondSeed',
  'start',
  'joins',
  'frames',
  'root',
  'hash',
  'results',
  't',
];

/** A settlement of either version: version 1's `referee`, or version 2's `referees` and `duty`. */
function settlementDoc(s: unknown): Settlement | null {
  if (!isObj(s)) return null;
  const v2 = s.v === 2;
  if (!keysIn(s, [...SETTLEMENT_KEYS, ...(v2 ? ['referees', 'duty'] : ['referee'])])) return null;
  const joins = list(s.joins, MAX_SLOTS, (x) => (hex(x) ? x : null));
  const results = list(s.results, MAX_SLOTS, settledFighter);
  if (
    s.kind !== 'settlement' ||
    !uint(s.rules) ||
    !hex(s.enc) ||
    !isStr(s.pondSeed, ID_RE) ||
    !hex(s.start) ||
    !joins ||
    !uint(s.frames, MAX_FRAMES) ||
    !hex(s.root) ||
    !isStr(s.hash, STATE_HASH) ||
    !results ||
    !uint(s.t)
  ) {
    return null;
  }
  const base = {
    kind: 'settlement' as const,
    rules: s.rules,
    enc: s.enc,
    pondSeed: s.pondSeed,
    start: s.start,
    joins,
    frames: s.frames,
    root: s.root,
    hash: s.hash,
    results,
    t: s.t,
  };
  const tail = refereeTail(s);
  return tail && { ...base, ...tail };
}

function signedSettlement(v: unknown): SignedSettlement | null {
  if (!isObj(v) || !keysIn(v, ['settlement', 'hash', 'authSig', 'keyId'])) return null;
  if (!hex(v.hash) || !signed(v)) return null;
  const settlement = settlementDoc(v.settlement);
  return settlement
    ? { settlement, hash: v.hash, authSig: v.authSig as string, keyId: v.keyId as string }
    : null;
}

function flag(v: unknown): AuditFlag | null {
  return isObj(v) &&
    keysIn(v, ['creature', 'kind', 't']) &&
    hex(v.creature) &&
    isStr(v.kind, WORD) &&
    uint(v.t)
    ? { creature: v.creature, kind: v.kind, t: v.t }
    : null;
}

const BUNDLE_KEYS = [
  'v',
  'kind',
  'subject',
  'world',
  'keys',
  'creatures',
  'records',
  'commits',
  'beacons',
  'settlements',
  'flags',
  'more',
  't',
];
const BUNDLE_V2_KEYS = [...BUNDLE_KEYS, 'witnessCommits', 'attestations'];

function bundle(v: unknown): ProofBundle | null {
  if (!isObj(v) || v.kind !== 'proof') return null;
  // Version 1 has no witness lists; version 2 has both.
  if (v.v === 1 ? !keysIn(v, BUNDLE_KEYS) : v.v !== 2 || !keysIn(v, BUNDLE_V2_KEYS)) return null;
  const w = v.world;
  const world =
    isObj(w) && keysIn(w, ['epoch', 'rules', 'scales']) && uint(w.epoch) && uint(w.rules)
      ? scales(w.scales)
      : null;
  if (!world || !hex(v.subject) || !uint(v.t)) return null;
  const creatures = list(v.creatures, PROOF_MAX_CREATURES, creature);
  if (!creatures || creatures.length === 0) return null;
  const keys = list(v.keys, PROOF_CAPS.keys, key);
  const records = list(v.records, PROOF_CAPS.records, storedRecord);
  const commits = list(v.commits, PROOF_CAPS.commits, (x) => signedCommit(x));
  const beacons = list(v.beacons, PROOF_CAPS.beacons, beacon);
  const settlements = list(v.settlements, PROOF_CAPS.settlements, signedSettlement);
  const flags = list(v.flags, PROOF_CAPS.flags, flag);
  const more = list(v.more, PROOF_CAPS.more, (x) => (hex(x) ? x : null));
  const v1 = v.v === 1;
  const witnessCommits = v1
    ? []
    : list(v.witnessCommits, PROOF_CAPS.witnessCommits, (x) => signedCommit(x, true));
  const attestations = v1
    ? []
    : list(v.attestations, PROOF_CAPS.attestations, parseSignedAttestation);
  if (!keys || !records || !commits || !beacons || !settlements || !flags || !more) return null;
  if (!witnessCommits || !attestations) return null;
  return {
    v: 2,
    kind: 'proof',
    subject: v.subject,
    world: { epoch: (w as Obj).epoch as number, rules: (w as Obj).rules as number, scales: world },
    keys,
    creatures,
    records,
    commits,
    beacons,
    settlements,
    flags,
    more,
    witnessCommits,
    attestations,
    t: v.t,
  };
}

/**
 * A proof bundle from untrusted JSON (its text, or the value `JSON.parse` made of it), or null: a
 * bundle over `PROOF_MAX_BYTES`, a list over its cap, a malformed id, key, signature or genome
 * text, an unknown field, or a record `recordProblems` refuses. It only checks shapes: whether the
 * history holds is `verifyLineage`'s question. Never throws.
 */
export function parseProofBundle(json: unknown): ProofBundle | null {
  try {
    return bundle(within(json, PROOF_MAX_BYTES));
  } catch {
    return null;
  }
}

function fighterInfo(v: unknown): FightLog['start']['fighters'][number] | null {
  const fields = ['player', 'creature', 'genome', 'x', 'y', 'vx', 'vy', 'heading'];
  const more = ['biomass', 'energy', 'health', 'elder', 'egg', 'worth'];
  if (!isObj(v) || !keysIn(v, [...fields, ...more])) return null;
  const condition = (x: unknown) => num(x, 0, MAX_CONDITION);
  if (
    !isStr(v.player, PLAYER_ID_RE) ||
    !hex(v.creature) ||
    !isStr(v.genome, GENOME_TEXT) ||
    !num(v.x, 0, POS_MAX) ||
    !num(v.y, 0, POS_MAX) ||
    !num(v.vx, -POS_MAX, POS_MAX) ||
    !num(v.vy, -POS_MAX, POS_MAX) ||
    !num(v.heading, -2 * Math.PI, 2 * Math.PI) ||
    !condition(v.biomass) ||
    !condition(v.energy) ||
    !condition(v.health) ||
    typeof v.elder !== 'boolean' ||
    typeof v.egg !== 'boolean' ||
    typeof v.worth !== 'number' ||
    !FIGHTER_WORTHS.includes(v.worth)
  ) {
    return null;
  }
  return {
    player: v.player,
    creature: v.creature,
    genome: v.genome,
    x: v.x,
    y: v.y,
    vx: v.vx,
    vy: v.vy,
    heading: v.heading,
    biomass: v.biomass,
    energy: v.energy,
    health: v.health,
    elder: v.elder,
    egg: v.egg,
    worth: v.worth,
  };
}

function fightLog(v: unknown): FightLog | null {
  if (!isObj(v) || !keysIn(v, ['pondSeed', 'start', 'joins', 'frames'])) return null;
  const s = v.start;
  if (!isStr(v.pondSeed, ID_RE) || !isObj(s)) return null;
  if (!keysIn(s, ['t', 'enc', 'seed', 'round', 't0', 'at', 'fighters']) || s.t !== 'enc-start')
    return null;
  const fighters = list(s.fighters, MAX_SLOTS, fighterInfo);
  if (
    !fighters ||
    fighters.length < 2 ||
    !hex(s.enc) ||
    !hex(s.seed) ||
    !uint(s.round, U32_MAX) ||
    !uint(s.t0, U32_MAX) ||
    !uint(s.at)
  ) {
    return null;
  }
  const enc = s.enc;
  const joins = list(v.joins, MAX_SLOTS, (j) => {
    if (!isObj(j) || !keysIn(j, ['t', 'enc', 'f', 'fighter']) || j.t !== 'enc-join') return null;
    const fighter = fighterInfo(j.fighter);
    return fighter && j.enc === enc && uint(j.f, MAX_FRAMES)
      ? { t: 'enc-join' as const, enc, f: j.f, fighter }
      : null;
  });
  const frames = list(v.frames, MAX_FRAMES, (row) =>
    list(row, MAX_SLOTS, (x) => (x === null || uint(x, U32_MAX) ? { x } : null)),
  );
  if (!joins || !frames) return null;
  return {
    pondSeed: v.pondSeed,
    start: {
      t: 'enc-start',
      enc,
      seed: s.seed,
      round: s.round,
      t0: s.t0,
      at: s.at,
      fighters,
    },
    joins,
    frames: frames.map((row) => row.map(({ x }) => x as number | null)),
  };
}

/** A fight's proof from untrusted JSON (text or value), or null. Never throws. */
export function parseFightProof(json: unknown): FightProof | null {
  try {
    const v = within(json, FIGHT_PROOF_MAX_BYTES);
    if (!isObj(v) || !keysIn(v, ['settlement', 'log'])) return null;
    const settlement = signedSettlement(v.settlement);
    const log = v.log === null ? null : fightLog(v.log);
    return settlement && (v.log === null || log) ? { settlement, log } : null;
  } catch {
    return null;
  }
}
