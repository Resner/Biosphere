import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js';
import type { EncJoin, EncStart } from '../net/encounter-start';
import type { RefereeSpan } from '../net/handover';
import type { FighterInfo } from '../net/protocol-defs';
import { survivedOutcome } from '../sim/encounter/types';
import { type Canonical, canonicalize, hashWithDomain } from './canonical';
import { fromBase64Url, isPlayerId, verify } from './identity';
import {
  AUTH_DOMAIN,
  authorityKeyId,
  authorityPublicKey,
  authoritySign,
  HEX64,
  type LedgerRecord,
  type PubKey,
  type StoredRecord,
} from './record';
import { isHex64, onlyKeys, POOL_MAX } from './witness-doc';

// A settled encounter's document (ADR 0054): what the fight was, countersigned by the authority over
// a Merkle root of its frames. Canonical JSON of integers and strings: an absent cause or slot is an
// absent key. The protocol (`enc-end.settlement`, protocol 8) carries it.

/** One slot's result: its outcome and final condition (hundredths, rounded down). `by` and `eggBy` are slots. */
export interface SettledFighter {
  player: string;
  creature: string;
  outcome: string;
  cause?: string;
  by?: number;
  frame: number;
  egg: 'none' | 'kept' | 'eaten';
  eggBy?: number;
  biomass: number;
  energy: number;
  health: number;
  reward: number;
}

/** Who referees a fight from frame `from` on: `'authority'` or a witness's player id, with its place in the order (ADR 0058). */
export type { RefereeSpan } from '../net/handover';

/** The most referee spans a settlement holds: the authority's, and up to 3 witnesses each taken back. */
export const REFEREE_SPANS_MAX = 8;

/** Fields both versions share. `start` and `joins` hash the start and join messages, `root` the frames, `hash` is `hashEncounter` at the end. */
interface SettlementBase {
  kind: 'settlement';
  rules: number;
  enc: string;
  pondSeed: string;
  start: string;
  joins: string[];
  frames: number;
  root: string;
  hash: string;
  results: SettledFighter[];
  t: number;
}

/** Version 1 (M8 to M9): every frame refereed by the authority. It still parses and verifies, as authority-only. */
export interface SettlementV1 extends SettlementBase {
  v: 1;
  referee: 'authority';
}

/**
 * Version 2 (ADR 0058): who refereed which frames, and the witness commitment (`duty`, its id, or
 * `''` with an empty pool). Keys appear in the order `canonicalize` sorts them anyway.
 */
export interface SettlementV2 extends SettlementBase {
  v: 2;
  referees: RefereeSpan[];
  duty: string;
}

export type Settlement = SettlementV1 | SettlementV2;

/** A settlement's referee spans: version 1's is the authority from frame 0. */
export function refereesOf(s: Settlement): RefereeSpan[] {
  return s.v === 2 ? s.referees.map((r) => ({ ...r })) : [{ by: AUTHORITY, from: 0 }];
}

/**
 * Why a settlement's spans are not a fight's (ADR 0058); empty when they are. Never throws:
 * - `spans-start`: the first is not the authority's from frame 0;
 * - `spans-order`: a span's `from` is not past the one before it;
 * - `spans-frames`: a later span starts at or past the fight's last frame;
 * - `spans-position`: a witness's span without its place in the order, or the authority's with one.
 */
export function refereeSpanProblems(s: Settlement): string[] {
  const spans = refereesOf(s);
  const problems = new Set<string>();
  const [first] = spans;
  if (first?.by !== AUTHORITY || first.from !== 0) problems.add('spans-start');
  for (const [i, span] of spans.entries()) {
    const before = spans[i - 1];
    if (before && !(span.from > before.from)) problems.add('spans-order');
    if (i > 0 && span.from >= s.frames) problems.add('spans-frames');
    if ((span.by === AUTHORITY) !== (span.position === undefined)) problems.add('spans-position');
  }
  return [...problems];
}

/**
 * Referee spans from untrusted JSON, shapes only (whether they make sense is
 * `refereeSpanProblems`'s question): 1 to `REFEREE_SPANS_MAX` of `{ by, from, position? }`, `by`
 * `'authority'` or a player id, `from` a frame, `position` a place in a pool. Null otherwise.
 */
export function parseRefereeSpans(v: unknown): RefereeSpan[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > REFEREE_SPANS_MAX) return null;
  const out: RefereeSpan[] = [];
  for (const x of v) {
    if (typeof x !== 'object' || x === null || Array.isArray(x)) return null;
    const o = x as Record<string, unknown>;
    if (!onlyKeys(o, ['by', 'from', 'position'])) return null;
    const { by, from, position } = o;
    if (typeof by !== 'string' || (by !== AUTHORITY && !isPlayerId(by))) return null;
    if (!Number.isInteger(from) || (from as number) < 0 || (from as number) > 0xffff) return null;
    if (position === undefined) {
      out.push({ by, from: from as number });
      continue;
    }
    if (!Number.isInteger(position) || (position as number) < 0) return null;
    if ((position as number) >= POOL_MAX) return null;
    out.push({ by, from: from as number, position: position as number });
  }
  return out;
}

/** A settlement's `duty`: a witness commitment's id, or `''`. */
export const isDuty = (v: unknown): v is string => v === '' || isHex64(v);

/** The settlement with its hash (`bs/settle/v1`) and the authority's countersignature over it. */
export interface SignedSettlement {
  settlement: Settlement;
  hash: string;
  authSig: string;
  keyId: string;
}

/** The fight as the authority logged it (ADR 0053): its pond, its start and joins as sent, and every finalized frame. */
export interface FightLog {
  pondSeed: string;
  start: EncStart;
  joins: EncJoin[];
  /** `frames[f][slot]`: the u32 input code, or null for the fallback marker. */
  frames: (number | null)[][];
}

/** The authority's name in a referee span (`src/net/handover.ts`'s `AUTHORITY`, which the verifier must not import). */
const AUTHORITY = 'authority';

const SETTLE_DOMAIN = 'bs/settle/v1';
const START_DOMAIN = 'bs/enc/start/v1';
const JOIN_DOMAIN = 'bs/enc/join/v1';
const FRAME_DOMAIN = 'bs/enc/frame/v1';

const FALLBACK = 0xff;
const FRAME_TAG = new TextEncoder().encode(FRAME_DOMAIN);

/** A frame's leaf: `'bs/enc/frame/v1' ‖ u16 frame ‖ u8 width ‖` per slot `0xFF`, or `0x00` and the u32 input. */
export function frameLeaf(f: number, inputs: readonly (number | null)[]): Uint8Array {
  if (!Number.isInteger(f) || f < 0 || f > 0xffff) throw new RangeError(`bad frame ${f}`);
  if (inputs.length > 0xff) throw new RangeError('too many slots');
  const out = new Uint8Array(FRAME_TAG.length + 3 + inputs.length * 5);
  out.set(FRAME_TAG);
  const view = new DataView(out.buffer);
  let at = FRAME_TAG.length;
  view.setUint16(at, f);
  view.setUint8(at + 2, inputs.length);
  at += 3;
  for (const code of inputs) {
    if (code === null) {
      out[at++] = FALLBACK;
      continue;
    }
    if (!Number.isInteger(code) || code < 0 || code > 0xffffffff)
      throw new RangeError(`bad input ${code}`);
    out[at] = 0;
    view.setUint32(at + 1, code);
    at += 5;
  }
  return out.subarray(0, at);
}

// RFC 6962 §2.1: leaves hash under a 0x00 prefix, nodes under 0x01, and a tree of n > 1 leaves
// splits at the largest power of two below n. The empty tree is SHA-256 of nothing.

const leafHash = (leaf: Uint8Array): Uint8Array => sha256(concatBytes(Uint8Array.of(0), leaf));
const nodeHash = (left: Uint8Array, right: Uint8Array): Uint8Array =>
  sha256(concatBytes(Uint8Array.of(1), left, right));

/** The largest power of two below `n` (n > 1). */
function split(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

function treeHash(hashes: readonly Uint8Array[]): Uint8Array {
  if (hashes.length === 0) return sha256(new Uint8Array(0));
  if (hashes.length === 1) return hashes[0] as Uint8Array;
  const k = split(hashes.length);
  return nodeHash(treeHash(hashes.slice(0, k)), treeHash(hashes.slice(k)));
}

/** The RFC 6962 Merkle tree hash of `leaves`, as hex. */
export function merkleRoot(leaves: readonly Uint8Array[]): string {
  return bytesToHex(treeHash(leaves.map(leafHash)));
}

/** The Merkle root over a fight's input frames. */
export const framesRoot = (frames: readonly (readonly (number | null)[])[]): string =>
  merkleRoot(frames.map((inputs, f) => frameLeaf(f, inputs)));

/** The audit path of leaf `index` (RFC 6962 §2.1.1), as hex, from the leaf up. */
export function merkleProof(leaves: readonly Uint8Array[], index: number): string[] {
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length)
    throw new RangeError(`no leaf ${index}`);
  const path = (hashes: readonly Uint8Array[], m: number): Uint8Array[] => {
    if (hashes.length <= 1) return [];
    const k = split(hashes.length);
    return m < k
      ? [...path(hashes.slice(0, k), m), treeHash(hashes.slice(k))]
      : [...path(hashes.slice(k), m - k), treeHash(hashes.slice(0, k))];
  };
  return path(leaves.map(leafHash), index).map(bytesToHex);
}

/** Whether `proof` places `leaf` at `index` of a `count`-leaf tree with this root (RFC 9162 §2.1.3.2). Never throws. */
export function verifyProof(
  root: string,
  leaf: Uint8Array,
  index: number,
  count: number,
  proof: readonly string[],
): boolean {
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || index < 0 || index >= count)
    return false;
  if (!HEX64.test(root) || proof.some((p) => typeof p !== 'string' || !HEX64.test(p))) return false;
  let fn = index;
  let sn = count - 1;
  let r = leafHash(leaf);
  for (const p of proof) {
    if (sn === 0) return false;
    const sibling = hexToBytes(p);
    if (fn % 2 === 1 || fn === sn) {
      r = nodeHash(sibling, r);
      while (fn % 2 === 0 && fn !== 0) {
        fn = Math.floor(fn / 2);
        sn = Math.floor(sn / 2);
      }
    } else {
      r = nodeHash(r, sibling);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return sn === 0 && bytesToHex(r) === root;
}

/** A double as the 16 hex digits of its IEEE-754 bits, so canonical JSON stays integers and strings. */
export function f64Hex(x: number): string {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  return bytesToHex(new Uint8Array(view.buffer));
}

/** A fighter's info in a hash: every number as its bits, a flag as 0 or 1. */
function fighterCanon(info: FighterInfo): Canonical {
  const out: Record<string, Canonical> = {};
  for (const [key, value] of Object.entries(info)) {
    out[key] =
      typeof value === 'number' ? f64Hex(value) : typeof value === 'boolean' ? +value : value;
  }
  return out;
}

/** The hash of an `enc-start` in pond `pondSeed` (`bs/enc/start/v1`); `t0`, `at` and `round` are integers. */
export function startHash(pondSeed: string, start: EncStart): string {
  return hashWithDomain(
    START_DOMAIN,
    canonicalize({
      pondSeed,
      enc: start.enc,
      seed: start.seed,
      round: start.round,
      t0: start.t0,
      at: start.at,
      fighters: start.fighters.map(fighterCanon),
    }),
  );
}

/** The hash of an `enc-join` (`bs/enc/join/v1`); its frame is an integer. */
export function joinHash(join: EncJoin): string {
  return hashWithDomain(
    JOIN_DOMAIN,
    canonicalize({ enc: join.enc, f: join.f, fighter: fighterCanon(join.fighter) }),
  );
}

/** The document's hash (`bs/settle/v1`), which the authority countersigns. */
export function settlementHash(s: Settlement): string {
  return hashWithDomain(SETTLE_DOMAIN, canonicalize(s as unknown as Canonical));
}

/** The document with its hash and the authority's countersignature (`bs/auth/v1`, like a record's). */
export function signSettlement(secret: Uint8Array, settlement: Settlement): SignedSettlement {
  const hash = settlementHash(settlement);
  return {
    settlement,
    hash,
    authSig: authoritySign(secret, hash),
    keyId: authorityKeyId(authorityPublicKey(secret)),
  };
}

/**
 * Whether the countersignature holds, as `checkStored` checks a record's: `key` for a key id no
 * listed key derives, `signature` for a hash that is not the document's or a signature that fails.
 * Empty when it holds. Never throws.
 */
export function checkSettlementSig(s: SignedSettlement, keys: readonly PubKey[]): string[] {
  try {
    const key = keys.find((k) => k.id === s.keyId && authorityKeyId(k.publicKey) === k.id);
    if (!key) return ['key'];
    const sig = typeof s.authSig === 'string' ? fromBase64Url(s.authSig) : null;
    return typeof s.hash === 'string' &&
      HEX64.test(s.hash) &&
      s.hash === settlementHash(s.settlement) &&
      sig !== null &&
      verify(key.publicKey, AUTH_DOMAIN, hexToBytes(s.hash), sig)
      ? []
      : ['signature'];
  } catch {
    return ['signature'];
  }
}

/**
 * What the fighters' records must agree on with the settlement (ADR 0054). Every record whose body
 * names the encounter is checked against its fighter's result: a survivor's `encounter` record
 * (outcome, frames, condition, reward), a dead fighter's `death` (cause, biomass, killer), and a
 * pending child's `death` by an eaten egg (its carrier's player and the eater). Problems are
 * `record:<index>:<field>`; empty when every record agrees. Records of other fights are ignored.
 */
export function checkSettledRecords(s: Settlement, records: readonly StoredRecord[]): string[] {
  const problems: string[] = [];
  for (const [i, { record: r }] of records.entries()) {
    if (r.body.enc !== s.enc) continue;
    for (const field of disagreements(s, r)) problems.push(`record:${i}:${field}`);
  }
  return problems;
}

/** The fields in which one record of the encounter disagrees with its fighter's result. */
function disagreements(s: Settlement, r: LedgerRecord): string[] {
  const b = r.body;
  const bad: string[] = [];
  const creatureAt = (slot: number | undefined): string | undefined =>
    slot === undefined ? undefined : s.results[slot]?.creature;
  if (r.rules !== s.rules) bad.push('rules');
  const result = s.results.find((x) => x.creature === r.creature);
  if (!result) {
    // A pending child dies with its carrier's eaten egg.
    const carrier = s.results.find((x) => x.player === r.owner && x.egg === 'eaten');
    if (r.kind !== 'death' || b.cause !== 'eaten' || !carrier) return [...bad, 'creature'];
    return b.by === creatureAt(carrier.eggBy) ? bad : [...bad, 'by'];
  }
  if (r.owner !== result.player) bad.push('player');
  if (survivedOutcome(result.outcome)) {
    if (r.kind !== 'encounter') return [...bad, 'kind'];
    if (b.outcome !== result.outcome) bad.push('outcome');
    if (b.frames !== result.frame) bad.push('frames');
    for (const key of ['biomass', 'energy', 'health', 'reward'] as const) {
      if (b[key] !== result[key]) bad.push(key);
    }
    return bad;
  }
  if (r.kind !== 'death') return [...bad, 'kind'];
  if (b.cause !== (result.cause ?? 'killed')) bad.push('cause');
  if (b.biomass !== result.biomass) bad.push('biomass');
  if (b.by !== creatureAt(result.by)) bad.push('by');
  return bad;
}
