import type { Beacon } from '../ledger/drand';
import type { FightLog } from '../ledger/settlement';
import {
  type DutyKind,
  onlyKeys,
  parseDutyEvent,
  parseSignedAttestation,
  type WitnessData,
} from '../ledger/witness-doc';
import {
  type AuditCase,
  BATCH_MAX_BYTES,
  BATCH_MAX_FRAMES,
  type ClientMsg,
  DUTY_HISTORY_FRAMES,
  DUTY_MAX_BYTES,
  type DutyEndWhy,
  type DutyHistory,
  ENC_MAX_FIGHTERS,
  ENC_MAX_FRAME,
  type HubMsg,
  type PeerEvent,
  type SignedCommit,
} from './protocol-defs';
import { parseBeacon, signedCommit, storedRecord } from './protocol-docs';
import {
  encStartOf,
  fighterInfo,
  isFrame,
  MIN_FIGHTERS,
  signedSettlement,
  U32_MAX,
} from './protocol-encounter';
import {
  capped,
  GENOME_DATA_RE,
  HEX64_RE,
  ID_RE,
  isInt,
  isObj,
  isStr,
  list,
  MAX_TICK,
  type Obj,
  PLAYER_ID_RE,
  SIG_RE,
} from './protocol-kit';

// Protocol 10 (ADR 0058, M10 T2): witness duties, a witness referee's batches, a fighter's disputes,
// an auditor's attestations, and the signed inputs and frames on a duty link. Every message here is
// new, so unlike the older parsers each refuses a field it does not know, at every level it defines.
// The handlers (T4, T5, T8) check signatures, positions and logs; this only parses.

const DUTY_ENDS: Record<DutyEndWhy, true> = {
  done: true,
  'taken-back': true,
  replaced: true,
  struck: true,
};

/** True when `o` has no key outside `keys`. */
const only = onlyKeys;

/** An input code, or null where the autopilot plays. */
const code = (v: unknown): number | null | undefined =>
  v === null || isInt(v, 0, U32_MAX) ? v : undefined;

/** A frame's inputs: `min` to `ENC_MAX_FIGHTERS` slots, each a code or null. */
function frameInputs(v: unknown, min = 1): (number | null)[] | null {
  if (!Array.isArray(v) || v.length < min || v.length > ENC_MAX_FIGHTERS) return null;
  const out: (number | null)[] = [];
  for (const x of v) {
    const c = code(x);
    if (c === undefined) return null;
    out.push(c);
  }
  return out;
}

/** A fighter's signed frame (`dispute`, `wframe`): `enc`, `f`, `i` and `sig`, no other field but `t`. */
function signedFrame(o: Obj): { enc: string; f: number; i: (number | null)[]; sig: string } | null {
  const i = only(o, ['t', 'enc', 'f', 'i', 'sig']) ? frameInputs(o.i) : null;
  return i && isStr(o.enc, HEX64_RE) && isFrame(o.f) && isStr(o.sig, SIG_RE)
    ? { enc: o.enc, f: o.f, i, sig: o.sig }
    : null;
}

/** The signatures of one batch frame: one exactly where its input is not null. */
function frameSigs(v: unknown, inputs: readonly (number | null)[]): (string | null)[] | null {
  if (!Array.isArray(v) || v.length !== inputs.length) return null;
  const out: (string | null)[] = [];
  for (const [slot, sig] of v.entries()) {
    if (inputs[slot] === null ? sig !== null : !isStr(sig, SIG_RE)) return null;
    out.push(sig as string | null);
  }
  return out;
}

function batch(o: Obj): ClientMsg | null {
  if (!only(o, ['t', 'enc', 'f', 'i', 's', 'end'])) return null;
  if (!isStr(o.enc, HEX64_RE) || !isFrame(o.f) || typeof o.end !== 'boolean') return null;
  const i = list(o.i, BATCH_MAX_FRAMES, frameInputs);
  if (!i || i.length === 0 || o.f + i.length - 1 > ENC_MAX_FRAME) return null;
  if (!Array.isArray(o.s) || o.s.length !== i.length) return null;
  const s: (string | null)[][] = [];
  for (const [k, inputs] of i.entries()) {
    const sigs = frameSigs(o.s[k], inputs);
    if (!sigs) return null;
    s.push(sigs);
  }
  return { t: 'batch', enc: o.enc, f: o.f, i, s, end: o.end };
}

/** The witness messages a client sends, or null (also for any other `t`). */
export function witnessClientMsg(o: Obj, raw: string): ClientMsg | null {
  switch (o.t) {
    case 'avail':
      return only(o, ['t', 'on']) && typeof o.on === 'boolean'
        ? capped(raw, { t: 'avail', on: o.on })
        : null;
    case 'duty-ok':
    case 'duty-no':
      return only(o, ['t', 'event']) && parseDutyEvent(o.event)
        ? capped(raw, { t: o.t, event: o.event as string })
        : null;
    case 'batch':
      return capped(raw, batch(o), BATCH_MAX_BYTES);
    case 'dispute': {
      const x = signedFrame(o);
      return x ? capped(raw, { t: 'dispute', ...x }) : null;
    }
    case 'attest': {
      const signed = only(o, ['t', 'signed']) ? parseSignedAttestation(o.signed) : null;
      return signed ? capped(raw, { t: 'attest', signed }) : null;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Duties

/** The witness commitment of `event`, the beacon of its round and the position in its pool, or null. */
function dutyBase(
  o: Obj,
  event: string,
): { position: number; commit: SignedCommit; beacon: Beacon } | null {
  const commit = signedCommit(o.commit);
  const beacon = parseBeacon(o.beacon);
  if (!commit || !beacon || commit.commitment.kind !== 'witness') return null;
  const data = commit.commitment.data as unknown as WitnessData;
  if (data.event !== event || beacon.round !== commit.commitment.round) return null;
  return isInt(o.position, 0, data.pool.length - 1)
    ? { position: o.position, commit, beacon }
    : null;
}

/** A referee duty's history: frames from 0 in order, and at most 2 joins, each due no earlier than the frames before it. */
function history(v: unknown): DutyHistory[] | null {
  const max = DUTY_HISTORY_FRAMES + ENC_MAX_FIGHTERS - MIN_FIGHTERS;
  if (!Array.isArray(v) || v.length > max) return null;
  const out: DutyHistory[] = [];
  let frames = 0;
  let joins = 0;
  for (const h of v) {
    if (!isObj(h) || !isFrame(h.f)) return null;
    if (h.t === 'enc-frame' && only(h, ['t', 'f', 'i'])) {
      const i = frameInputs(h.i, MIN_FIGHTERS);
      if (!i || h.f !== frames || ++frames > DUTY_HISTORY_FRAMES) return null;
      out.push({ t: 'enc-frame', f: h.f, i });
    } else if (h.t === 'enc-join' && only(h, ['t', 'f', 'fighter'])) {
      const fighter = fighterInfo(h.fighter);
      if (!fighter || h.f < frames || ++joins > ENC_MAX_FIGHTERS - MIN_FIGHTERS) return null;
      out.push({ t: 'enc-join', f: h.f, fighter });
    } else return null;
  }
  return out;
}

const isGenome = (v: unknown): v is string => isStr(v, GENOME_DATA_RE);

/** A pair of items, or null. */
function two<T>(v: unknown, item: (x: unknown) => T | null): [T, T] | null {
  const out = Array.isArray(v) && v.length === 2 ? list(v, 2, item) : null;
  return out ? [out[0] as T, out[1] as T] : null;
}

function fightLog(v: unknown, enc: string): FightLog | null {
  if (!isObj(v) || !only(v, ['pondSeed', 'start', 'joins', 'frames'])) return null;
  const start = isObj(v.start) ? encStartOf(v.start) : null;
  const joins = list(v.joins, ENC_MAX_FIGHTERS - MIN_FIGHTERS, (j) => {
    const fighter = isObj(j) ? fighterInfo(j.fighter) : null;
    return fighter && isObj(j) && j.t === 'enc-join' && j.enc === enc && isFrame(j.f)
      ? { t: 'enc-join' as const, enc, f: j.f, fighter }
      : null;
  });
  const frames = list(v.frames, ENC_MAX_FRAME + 1, (f) => frameInputs(f, MIN_FIGHTERS));
  return start && start.enc === enc && joins && frames && isStr(v.pondSeed, ID_RE)
    ? { pondSeed: v.pondSeed, start, joins, frames }
    : null;
}

/** An audit's case for an event of `kind` with id `id`, or null. */
function auditCase(v: unknown, kind: DutyKind, id: string): AuditCase | null {
  if (!isObj(v)) return null;
  if (kind === 'enc' && v.kind === 'enc' && only(v, ['kind', 'log', 'settlement'])) {
    const log = fightLog(v.log, id);
    const settlement = signedSettlement(v.settlement);
    return log && settlement?.settlement.enc === id ? { kind: 'enc', log, settlement } : null;
  }
  const commitment = signedCommit(v.commitment);
  if (kind === 'genesis' && v.kind === 'genesis') {
    const record = storedRecord(v.record);
    return only(v, ['kind', 'commitment', 'record', 'genome']) &&
      commitment?.commitment.kind === 'genesis' &&
      record &&
      isGenome(v.genome)
      ? { kind: 'genesis', commitment, record, genome: v.genome }
      : null;
  }
  if (kind === 'mating' && v.kind === 'mating') {
    const births = two(v.births, storedRecord);
    const mates = two(v.mates, storedRecord);
    const parents = two(v.parents, (p) => (isGenome(p) ? p : null));
    return only(v, ['kind', 'commitment', 'births', 'mates', 'parents']) &&
      commitment?.commitment.kind === 'mate' &&
      births &&
      mates &&
      parents
      ? { kind: 'mating', commitment, births, mates, parents }
      : null;
  }
  return null;
}

const REFEREE_KEYS = ['pondSeed', 'fighters', 'start', 'history'];
const BASE_KEYS = ['t', 'event', 'role', 'position', 'commit', 'beacon'];

function duty(o: Obj): HubMsg | null {
  const ev = parseDutyEvent(o.event);
  if (!ev) return null;
  const event = o.event as string;
  const base = dutyBase(o, event);
  if (!base) return null;
  if (o.role === 'auditor') {
    const audit = only(o, [...BASE_KEYS, 'audit']) ? auditCase(o.audit, ev.kind, ev.id) : null;
    return audit ? { t: 'duty', event, role: 'auditor', ...base, audit } : null;
  }
  if (o.role !== 'referee' || ev.kind !== 'enc' || !only(o, [...BASE_KEYS, ...REFEREE_KEYS]))
    return null;
  const start = isObj(o.start) ? encStartOf(o.start) : null;
  const fighters = list(o.fighters, ENC_MAX_FIGHTERS, (p) => (isStr(p, PLAYER_ID_RE) ? p : null));
  const past = history(o.history);
  return start?.enc === ev.id &&
    fighters &&
    fighters.length >= MIN_FIGHTERS &&
    new Set(fighters).size === fighters.length &&
    past &&
    isStr(o.pondSeed, ID_RE)
    ? {
        t: 'duty',
        event,
        role: 'referee',
        ...base,
        pondSeed: o.pondSeed,
        fighters,
        start,
        history: past,
      }
    : null;
}

/** The witness messages the hub sends, or null (also for any other `t`). */
export function witnessHubMsg(o: Obj, raw: string): HubMsg | null {
  switch (o.t) {
    case 'duty':
      return capped(raw, duty(o), DUTY_MAX_BYTES);
    case 'duty-end':
      return only(o, ['t', 'event', 'why']) &&
        parseDutyEvent(o.event) &&
        typeof o.why === 'string' &&
        Object.hasOwn(DUTY_ENDS, o.why)
        ? capped(raw, { t: 'duty-end', event: o.event as string, why: o.why as DutyEndWhy })
        : null;
    case 'duty-peer':
      return only(o, ['t', 'enc', 'peer', 'on']) &&
        isStr(o.enc, HEX64_RE) &&
        isStr(o.peer, PLAYER_ID_RE) &&
        typeof o.on === 'boolean'
        ? capped(raw, { t: 'duty-peer', enc: o.enc, peer: o.peer, on: o.on })
        : null;
    case 'enc-referee':
      return only(o, ['t', 'enc', 'from', 'by']) &&
        isStr(o.enc, HEX64_RE) &&
        isFrame(o.from) &&
        (o.by === 'authority' || isStr(o.by, PLAYER_ID_RE))
        ? capped(raw, { t: 'enc-referee', enc: o.enc, from: o.from, by: o.by as string })
        : null;
    default:
      return null;
  }
}

/** The witness events on a duty link, or null (also for any other `t`). The caller caps the size (`EVENT_MAX_BYTES`). */
export function witnessPeerEvent(o: Obj): PeerEvent | null {
  switch (o.t) {
    case 'finput':
      return only(o, ['t', 'enc', 'f', 'i', 'sig']) &&
        isStr(o.enc, HEX64_RE) &&
        isFrame(o.f) &&
        isInt(o.i, 0, U32_MAX) &&
        isStr(o.sig, SIG_RE)
        ? { t: 'finput', enc: o.enc, f: o.f, i: o.i, sig: o.sig }
        : null;
    case 'wframe': {
      const x = signedFrame(o);
      return x ? { t: 'wframe', ...x } : null;
    }
    case 'probe':
      return only(o, ['t', 'n', 'back']) && isInt(o.n, 0, MAX_TICK) && typeof o.back === 'boolean'
        ? { t: 'probe', n: o.n, back: o.back }
        : null;
    default:
      return null;
  }
}
