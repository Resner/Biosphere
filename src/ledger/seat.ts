// Seat tickets (M11, ADR 0062): the authority's countersigned word that a player holds a seat in
// the world under a name, valid for 15 minutes. Each side of a peer link shows its ticket in the
// link's first event (`hello`), so a peer can trust a name and a seat without asking the hub.
// T2 fixes the shapes and the parser; T7 adds the signing and the checks. No `@noble/curves` here:
// the wire's parsers import this module.

export const SEAT_TTL_MS = 900_000;
/** A fresh ticket goes out after the first `pong` this long after the last ticket. */
export const SEAT_RENEW_MS = 600_000;

export interface Seat {
  v: 1;
  kind: 'seat';
  player: string;
  name: string;
  world: string;
  /** When the authority issued it, and until when it holds (`t + SEAT_TTL_MS`), in ms. */
  t: number;
  until: number;
}

export interface SignedSeat {
  seat: Seat;
  authSig: string;
  keyId: string;
}

// The wire's own patterns (`src/net/protocol-kit.ts`, `NAME_RE`), kept here so the ledger needs
// nothing from `src/net` at run time.
const PLAYER_ID = /^[A-Za-z0-9_-]{43}$/;
const NAME = /^[A-Za-z0-9_-]{3,16}$/;
const WORLD_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SIG = /^[A-Za-z0-9_-]{86}$/;
const KEY_ID = /^[A-Za-z0-9_-]{8}$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const only = (o: Obj, keys: readonly string[]) => Object.keys(o).every((k) => keys.includes(k));
const isStr = (v: unknown, re: RegExp): v is string => typeof v === 'string' && re.test(v);
const isTime = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

const SEAT_KEYS = ['v', 'kind', 'player', 'name', 'world', 't', 'until'] as const;
const SIGNED_KEYS = ['seat', 'authSig', 'keyId'] as const;

/** A ticket from untrusted JSON, rebuilt from its checked fields; null for anything else. Never throws. */
export function parseSignedSeat(v: unknown): SignedSeat | null {
  if (!isObj(v) || !only(v, SIGNED_KEYS) || !isStr(v.authSig, SIG) || !isStr(v.keyId, KEY_ID))
    return null;
  const s = v.seat;
  if (!isObj(s) || !only(s, SEAT_KEYS) || s.v !== 1 || s.kind !== 'seat') return null;
  if (!isStr(s.player, PLAYER_ID) || !isStr(s.name, NAME) || !isStr(s.world, WORLD_ID)) return null;
  if (!isTime(s.t) || !isTime(s.until) || s.until < s.t) return null;
  return {
    seat: {
      v: 1,
      kind: 'seat',
      player: s.player,
      name: s.name,
      world: s.world,
      t: s.t,
      until: s.until,
    },
    authSig: v.authSig,
    keyId: v.keyId,
  };
}
