import type { GenesisAsk } from '../ledger/ask';
import type { Canonical } from '../ledger/canonical';
import type { Beacon } from '../ledger/drand';
import type { Commitment } from '../ledger/genesis';
import type { MateAsk } from '../ledger/mate-ask';
import type { RecordKind, StoredRecord } from '../ledger/record';
import { witnessDataProblems } from '../ledger/witness-doc';
import type { SignedCommit } from './protocol-defs';
import {
  HEX64_RE,
  isInt,
  isObj,
  isStr,
  KEY_ID_RE,
  MAX_TICK,
  MAX_TIME,
  PLAYER_ID_RE,
  SIG_RE,
} from './protocol-kit';

// The ledger's documents as the wire carries them (records, commitments, beacons, asks), shared by
// `protocol-parse.ts` and `protocol-witness.ts`. Each parser copies only the fields it knows.

export const NONCE_RE = /^[A-Za-z0-9_-]{22}$/;
/** A drand quicknet signature: 48 bytes of hex. */
const BEACON_SIG_RE = /^[0-9a-f]{96}$/;
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
export const isRecordKind = (v: unknown): v is RecordKind =>
  typeof v === 'string' && Object.hasOwn(RECORD_KINDS, v);

export function genesisAsk(v: unknown): GenesisAsk | null {
  return isObj(v) && isStr(v.nonce, NONCE_RE) && isStr(v.sig, SIG_RE)
    ? { nonce: v.nonce, sig: v.sig }
    : null;
}

export function parseBeacon(v: unknown): Beacon | null {
  return isObj(v) && isInt(v.round, 1, MAX_TICK) && isStr(v.signature, BEACON_SIG_RE)
    ? { round: v.round, signature: v.signature }
    : null;
}

/** A signed mate ask, copied field by field. */
export function mateAsk(v: unknown): MateAsk | null {
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
export function canonicalValue(v: unknown, depth: number): Canonical | null {
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

/** A witness commitment's data (ADR 0058): its event and pool, copied, or null. */
function witnessData(v: unknown): Commitment['data'] | null {
  if (!isObj(v) || witnessDataProblems(v).length > 0) return null;
  return { event: v.event as string, pool: [...(v.pool as string[])] };
}

/**
 * A countersigned commitment: a genesis's or a mating's, owned by its player, or a witness
 * commitment (ADR 0058), which the authority makes for itself and so has the owner `''`.
 */
export function signedCommit(v: unknown): SignedCommit | null {
  if (!isObj(v) || !isStr(v.authSig, SIG_RE) || !isStr(v.keyId, KEY_ID_RE)) return null;
  const c = isObj(v.commitment) ? v.commitment : null;
  const witness = c?.kind === 'witness';
  if (
    c?.v !== 1 ||
    !(witness ? c.owner === '' : isStr(c.owner, PLAYER_ID_RE)) ||
    !isInt(c.round, 1, MAX_TICK) ||
    !isStr(c.req, HEX64_RE) ||
    !isInt(c.t, 0, MAX_TIME)
  )
    return null;
  let data: Commitment['data'] | null = null;
  if (c.kind === 'genesis') data = genesisAsk(c.data);
  else if (witness) data = witnessData(c.data);
  else if (c.kind === 'mate' && isObj(c.data)) {
    const [a, b] = [mateAsk(c.data.a), mateAsk(c.data.b)];
    data = a && b ? { a: { ...a }, b: { ...b } } : null;
  }
  if (!data) return null;
  return {
    commitment: {
      v: 1,
      kind: c.kind as string,
      owner: c.owner as string,
      round: c.round,
      req: c.req,
      t: c.t,
      data,
    },
    authSig: v.authSig,
    keyId: v.keyId,
  };
}

export function storedRecord(v: unknown): StoredRecord | null {
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
