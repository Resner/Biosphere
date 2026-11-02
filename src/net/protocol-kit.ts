import { type ClientMsg, GENOME_DATA_MAX_CHARS, HUB_MAX_BYTES, type HubMsg } from './protocol-defs';

// The checks every untrusted-message parser shares (`protocol-parse.ts`, `protocol-encounter.ts`).

export type Obj = Record<string, unknown>;

export const PLAYER_ID_RE = /^[A-Za-z0-9_-]{43}$/;
/** An Ed25519 signature (64 bytes) in base64url. */
export const SIG_RE = /^[A-Za-z0-9_-]{86}$/;
export const HEX64_RE = /^[0-9a-f]{64}$/;
export const GENOME_DATA_RE = new RegExp(`^[A-Za-z0-9_-]{1,${GENOME_DATA_MAX_CHARS}}$`);

export const MAX_TICK = 0xffffffff;
export const MAX_TIME = Number.MAX_SAFE_INTEGER;
/** A condition value in hundredths: far above any body (maxBiomass is a few thousand wu), still safe to multiply. */
export const MAX_CONDITION = 1_000_000_000;

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

export const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
export const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export const isStr = (v: unknown, re: RegExp): v is string => typeof v === 'string' && re.test(v);
export const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function list<T>(v: unknown, max: number, item: (x: unknown) => T | null): T[] | null {
  if (!Array.isArray(v) || v.length > max) return null;
  const out: T[] = [];
  for (const x of v) {
    const parsed = item(x);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
}

/** Only signals and the welcome may exceed `HUB_MAX_BYTES`. */
export function capped<T extends ClientMsg | HubMsg>(
  raw: string,
  msg: T | null,
  max = HUB_MAX_BYTES,
): T | null {
  return msg !== null && byteLength(raw) <= max ? msg : null;
}
