import { fromBase64Url, isPlayerId } from './identity';
import { HEX64 } from './record';

// The witness documents' shapes and parsers (ADR 0058), with no key checks: the wire's parsers
// (`src/net/protocol-witness.ts`) use them, and the app shell must not load `@noble/curves`
// statically (`key-verify.ts`; `drand.test.ts` guards it). `witness.ts` re-exports all of it.

export const POOL_MAX = 16;

export type DutyKind = 'enc' | 'mating' | 'genesis';
export type DutyRole = 'referee' | 'auditor';

// Not `net/protocol-defs`'s SIGNATURE_BYTES: the verifier shares this file and never imports `src/net`.
const SIGNATURE_BYTES = 64;
const CODE = /^[a-z0-9:_-]{1,64}$/;
const EVENT = /^(enc|mating|genesis):([0-9a-f]{64})$/;

export const isHex64 = (v: unknown): v is string => typeof v === 'string' && HEX64.test(v);
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
export const onlyKeys = (v: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(v).every((k) => keys.includes(k));

/** The event a duty serves: `'enc:<64 hex>'`, `'mating:…'` or `'genesis:…'`. */
export function dutyEvent(kind: DutyKind, id: string): string {
  const event = `${kind}:${id}`;
  if (!EVENT.test(event)) throw new RangeError(`not a duty event: ${event}`);
  return event;
}

export function parseDutyEvent(s: unknown): { kind: DutyKind; id: string } | null {
  const m = typeof s === 'string' ? EVENT.exec(s) : null;
  return m ? { kind: m[1] as DutyKind, id: m[2] as string } : null;
}

/** A `witness` commitment's data (`Beacons.commit('witness', '', data, { round })`). */
export interface WitnessData {
  event: string;
  /** Player ids, sorted, unique, 1 to `POOL_MAX` of them. */
  pool: string[];
}

/** Why `v` is no witness commitment's data; empty when it is one. Never throws. */
export function witnessDataProblems(v: unknown): string[] {
  if (!isRecord(v)) return ['data'];
  const problems = Object.keys(v)
    .filter((k) => k !== 'event' && k !== 'pool')
    .map((k) => `unknown:${k}`);
  if (!parseDutyEvent(v.event)) problems.push('event');
  const pool = v.pool;
  if (!Array.isArray(pool)) return [...problems, 'pool'];
  if (pool.length === 0 || pool.length > POOL_MAX) return [...problems, 'pool-size'];
  if (!pool.every((id) => typeof id === 'string' && isPlayerId(id))) problems.push('pool-id');
  else if (!pool.every((id, i) => i === 0 || (pool[i - 1] as string) < id))
    problems.push('pool-order');
  return problems;
}

/** A signature's 64 bytes from base64url, or null. */
export function sigBytes(sig: unknown): Uint8Array | null {
  const bytes = typeof sig === 'string' ? fromBase64Url(sig) : null;
  return bytes?.length === SIGNATURE_BYTES ? bytes : null;
}

export interface Attestation {
  v: 1;
  kind: 'attest';
  /** `dutyEvent(…)` */
  event: string;
  /** The witness commitment's id. */
  duty: string;
  /** The witness's place in `witnessOrder`. */
  position: number;
  /** Its player id. */
  witness: string;
  /** The settlement's hash, the genesis record's hash, or `birthSubject(slot 0, slot 1)`. */
  subject: string;
  agree: boolean;
  /** The auditor's first problem; only when `agree` is false. */
  code?: string;
}

/** Ed25519 by the witness, domain `bs/attest/v1`, base64url. */
export interface SignedAttestation {
  attestation: Attestation;
  sig: string;
}

const ATTEST_KEYS = [
  'v',
  'kind',
  'event',
  'duty',
  'position',
  'witness',
  'subject',
  'agree',
  'code',
];

/** A signed attestation rebuilt from untrusted JSON, or null. Refuses unknown fields; never throws. */
export function parseSignedAttestation(v: unknown): SignedAttestation | null {
  try {
    if (!isRecord(v) || !onlyKeys(v, ['attestation', 'sig'])) return null;
    const a = v.attestation;
    if (!isRecord(a) || !onlyKeys(a, ATTEST_KEYS) || !sigBytes(v.sig)) return null;
    const { position, agree, code } = a;
    if (a.v !== 1 || a.kind !== 'attest' || !parseDutyEvent(a.event)) return null;
    if (!isHex64(a.duty)) return null;
    if (!isHex64(a.subject)) return null;
    if (typeof a.witness !== 'string' || !isPlayerId(a.witness)) return null;
    if (!Number.isInteger(position) || (position as number) < 0) return null;
    if ((position as number) >= POOL_MAX || typeof agree !== 'boolean') return null;
    if (code !== undefined && (agree || typeof code !== 'string' || !CODE.test(code))) return null;
    const attestation: Attestation = {
      v: 1,
      kind: 'attest',
      event: a.event as string,
      duty: a.duty,
      position: position as number,
      witness: a.witness,
      subject: a.subject,
      agree,
    };
    if (code !== undefined) attestation.code = code as string;
    return { attestation, sig: v.sig as string };
  } catch {
    return null;
  }
}
