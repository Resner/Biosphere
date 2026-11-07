import {
  refereeTail,
  type SettledFighter,
  type Settlement,
  type SignedSettlement,
} from '../ledger/settlement';
import { FIGHTER_WORTHS } from '../sim/encounter/types';
import {
  type ClientMsg,
  ENC_END_MAX_BYTES,
  ENC_MAX_FIGHTERS,
  ENC_MAX_FRAME,
  ENC_START_MAX_BYTES,
  type FighterInfo,
  type FighterOutcome,
  type FighterState,
  type FightReport,
  type HubMsg,
  isCause,
  NAME_RE,
  SEEN_MAX,
  type SignedSnap,
  SNAPSHOT_BYTES,
} from './protocol-defs';
import {
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

// The encounter messages (ADR 0050, M7), with protocol 8's worth, settlement and away report (ADRs
// 0053 and 0054). Every number is finite and in range, ids are hex and player ids well-formed;
// anything else parses as null.

/** A lock id: 8 to 32 random bytes as hex. */
const LOCK_RE = /^[0-9a-f]{16,64}$/;
/** The 29 snapshot bytes in base64url, unpadded (39 characters). */
const SNAP_RE = new RegExp(`^[A-Za-z0-9_-]{${Math.ceil((SNAPSHOT_BYTES * 4) / 3)}}$`);
/** An encounter's state hash (`hashEncounter`): 16 hex characters. */
const STATE_HASH_RE = /^[0-9a-f]{16}$/;
/** Positions lie in the world (the snapshot covers 0 to 8192 wu), velocities within a snapshot's range. */
const POS_MAX = 8192;
const VEL_MAX = 8192;
const HEADING_MAX = 2 * Math.PI;
/** Far above any carrion piece's body (a body's radius stays in the hundreds of wu). */
const RADIUS_MAX = 10_000;
export const MIN_FIGHTERS = 2;
export const U32_MAX = 0xffffffff;

const inRange = (v: unknown, min: number, max: number): v is number =>
  isNum(v) && v >= min && v <= max;
export const isFrame = (v: unknown): v is number => isInt(v, 0, ENC_MAX_FRAME);
const isSlot = (v: unknown): v is number => isInt(v, 0, ENC_MAX_FIGHTERS - 1);
const isPos = (v: unknown): v is number => inRange(v, 0, POS_MAX);
const isCondition = (v: unknown): v is number => inRange(v, 0, MAX_CONDITION);

export function signedSnap(v: unknown): SignedSnap | null {
  return isObj(v) && isStr(v.snap, SNAP_RE) && isStr(v.sig, SIG_RE)
    ? { snap: v.snap, sig: v.sig }
    : null;
}

/** The fields a fighter's start and its outcome share, or null. */
function fighterState(v: Obj): FighterState | null {
  return isStr(v.player, PLAYER_ID_RE) &&
    isStr(v.creature, HEX64_RE) &&
    isPos(v.x) &&
    isPos(v.y) &&
    inRange(v.vx, -VEL_MAX, VEL_MAX) &&
    inRange(v.vy, -VEL_MAX, VEL_MAX) &&
    inRange(v.heading, -HEADING_MAX, HEADING_MAX) &&
    isCondition(v.biomass) &&
    isCondition(v.energy) &&
    isCondition(v.health)
    ? {
        player: v.player,
        creature: v.creature,
        x: v.x,
        y: v.y,
        vx: v.vx,
        vy: v.vy,
        heading: v.heading,
        biomass: v.biomass,
        energy: v.energy,
        health: v.health,
      }
    : null;
}

export function fighterInfo(v: unknown): FighterInfo | null {
  const state = isObj(v) ? fighterState(v) : null;
  return state &&
    isObj(v) &&
    isStr(v.genome, GENOME_DATA_RE) &&
    typeof v.elder === 'boolean' &&
    typeof v.egg === 'boolean' &&
    isWorth(v.worth)
    ? { ...state, genome: v.genome, elder: v.elder, egg: v.egg, worth: v.worth }
    : null;
}

/** A worth as prey: exactly one of 1, 0.5, …, 2^-7. */
const isWorth = (v: unknown): v is number => typeof v === 'number' && FIGHTER_WORTHS.includes(v);

const OUTCOMES: Record<FighterOutcome['outcome'], true> = {
  killed: true,
  died: true,
  escaped: true,
  stood: true,
};
const EGGS: Record<FighterOutcome['egg'], true> = { none: true, kept: true, eaten: true };
const isKey = <K extends string>(table: Record<K, true>, v: unknown): v is K =>
  typeof v === 'string' && Object.hasOwn(table, v);

function fighterOutcome(v: unknown): FighterOutcome | null {
  const state = isObj(v) ? fighterState(v) : null;
  return state &&
    isObj(v) &&
    isKey(OUTCOMES, v.outcome) &&
    (v.cause === null || isCause(v.cause)) &&
    (v.by === null || isSlot(v.by)) &&
    isKey(EGGS, v.egg) &&
    (v.eggBy === null || isSlot(v.eggBy))
    ? { ...state, outcome: v.outcome, cause: v.cause, by: v.by, egg: v.egg, eggBy: v.eggBy }
    : null;
}

/** A list of 2 to 4 items (one per fighter slot), or null. */
function perSlot<T>(v: unknown, item: (x: unknown) => T | null): T[] | null {
  const out = list(v, ENC_MAX_FIGHTERS, item);
  return out && out.length >= MIN_FIGHTERS ? out : null;
}

/** A frame bundle's entry: an input code, or the fallback marker null. */
const bundleInput = (v: unknown): { code: number | null } | null =>
  v === null || isInt(v, 0, U32_MAX) ? { code: v } : null;

/** The encounter messages a client sends, or null (also for any other `t`). */
export function encounterClientMsg(o: Obj, raw: string): ClientMsg | null {
  switch (o.t) {
    case 'engage': {
      const mine = signedSnap(o.mine);
      const theirs = signedSnap(o.theirs);
      return mine && theirs && isStr(o.target, PLAYER_ID_RE)
        ? capped(raw, { t: 'engage', target: o.target, mine, theirs })
        : null;
    }
    case 'lock-state': {
      const mine = signedSnap(o.mine);
      // The target's copies of the attacker's last signed snapshots (M10 T11), when it sends them.
      const seen = o.seen === undefined ? undefined : list(o.seen, SEEN_MAX, signedSnap);
      return mine && isStr(o.lock, LOCK_RE) && seen !== null
        ? capped(raw, { t: 'lock-state', lock: o.lock, mine, ...(seen ? { seen } : {}) })
        : null;
    }
    case 'input':
      return isStr(o.enc, HEX64_RE) && isFrame(o.f) && isInt(o.i, 0, U32_MAX)
        ? capped(raw, { t: 'input', enc: o.enc, f: o.f, i: o.i })
        : null;
    default:
      return null;
  }
}

/** An `enc-start` message's fields, or null; the caller caps its size. */
export function encStartOf(o: Obj): EncStartMsg | null {
  const fighters = perSlot(o.fighters, fighterInfo);
  return fighters &&
    o.t === 'enc-start' &&
    isStr(o.enc, HEX64_RE) &&
    isStr(o.seed, HEX64_RE) &&
    isInt(o.round, 0, MAX_TICK) &&
    isInt(o.t0, 0, MAX_TICK) &&
    isInt(o.at, 0, MAX_TIME)
    ? { t: 'enc-start', enc: o.enc, seed: o.seed, round: o.round, t0: o.t0, at: o.at, fighters }
    : null;
}

type EncStartMsg = Extract<HubMsg, { t: 'enc-start' }>;

/** The encounter messages the hub sends, or null (also for any other `t`). */
export function encounterHubMsg(o: Obj, raw: string): HubMsg | null {
  switch (o.t) {
    case 'lock-ask':
      return isStr(o.lock, LOCK_RE) && isStr(o.by, PLAYER_ID_RE)
        ? capped(raw, { t: 'lock-ask', lock: o.lock, by: o.by })
        : null;
    case 'enc-start':
      return capped(raw, encStartOf(o), ENC_START_MAX_BYTES);
    case 'enc-frame': {
      const inputs = perSlot(o.i, bundleInput);
      return inputs && isStr(o.enc, HEX64_RE) && isFrame(o.f)
        ? capped(raw, { t: 'enc-frame', enc: o.enc, f: o.f, i: inputs.map((x) => x.code) })
        : null;
    }
    case 'enc-join': {
      const fighter = fighterInfo(o.fighter);
      return fighter && isStr(o.enc, HEX64_RE) && isFrame(o.f)
        ? capped(raw, { t: 'enc-join', enc: o.enc, f: o.f, fighter })
        : null;
    }
    case 'enc-end': {
      const fighters = perSlot(o.fighters, fighterOutcome);
      if (!fighters || !isStr(o.enc, HEX64_RE) || !isFrame(o.f) || !isStr(o.hash, STATE_HASH_RE))
        return null;
      const msg = { t: 'enc-end' as const, enc: o.enc, f: o.f, hash: o.hash, fighters };
      if (o.settlement === undefined) return capped(raw, msg, ENC_END_MAX_BYTES);
      const settlement = signedSettlement(o.settlement);
      const doc = settlement?.settlement;
      // The document settles this very fight: its encounter, its end state and one result per slot.
      return doc &&
        doc.enc === o.enc &&
        doc.hash === o.hash &&
        doc.results.length === fighters.length
        ? capped(raw, { ...msg, settlement }, ENC_END_MAX_BYTES)
        : null;
    }
    case 'carrion':
      return isStr(o.enc, HEX64_RE) &&
        isPos(o.x) &&
        isPos(o.y) &&
        isCondition(o.biomass) &&
        isNum(o.radius) &&
        o.radius > 0 &&
        o.radius <= RADIUS_MAX &&
        isInt(o.tick, 0, MAX_TICK)
        ? capped(raw, {
            t: 'carrion',
            enc: o.enc,
            x: o.x,
            y: o.y,
            biomass: o.biomass,
            radius: o.radius,
            tick: o.tick,
          })
        : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Protocol 8: the signed settlement (ADR 0054) and what `life` says about fights (ADR 0053).

/** A count of hundredths in a settled result. */
const isHundredths = (v: unknown): v is number => isInt(v, 0, MAX_CONDITION);

function settledFighter(v: unknown): SettledFighter | null {
  if (
    !isObj(v) ||
    !isStr(v.player, PLAYER_ID_RE) ||
    !isStr(v.creature, HEX64_RE) ||
    !isKey(OUTCOMES, v.outcome) ||
    !(v.cause === undefined || isCause(v.cause)) ||
    !(v.by === undefined || isSlot(v.by)) ||
    !isFrame(v.frame) ||
    !isKey(EGGS, v.egg) ||
    !(v.eggBy === undefined || isSlot(v.eggBy)) ||
    !isHundredths(v.biomass) ||
    !isHundredths(v.energy) ||
    !isHundredths(v.health) ||
    !isHundredths(v.reward)
  )
    return null;
  // Canonical JSON: an absent cause or slot is an absent key.
  return {
    player: v.player,
    creature: v.creature,
    outcome: v.outcome,
    ...(v.cause === undefined ? {} : { cause: v.cause }),
    ...(v.by === undefined ? {} : { by: v.by }),
    frame: v.frame,
    egg: v.egg,
    ...(v.eggBy === undefined ? {} : { eggBy: v.eggBy }),
    biomass: v.biomass,
    energy: v.energy,
    health: v.health,
    reward: v.reward,
  };
}

/** A settlement of either version (ADR 0058): version 1's `referee: 'authority'`, or version 2's spans and duty. */
function settlementDoc(v: unknown): Settlement | null {
  if (!isObj(v)) return null;
  const results = perSlot(v.results, settledFighter);
  const joins = list(v.joins, ENC_MAX_FIGHTERS - MIN_FIGHTERS, (j) =>
    isStr(j, HEX64_RE) ? j : null,
  );
  if (
    !results ||
    !joins ||
    // Every slot past the starters is a join.
    joins.length > results.length - MIN_FIGHTERS ||
    v.kind !== 'settlement' ||
    !isInt(v.rules, 0, MAX_TICK) ||
    !isStr(v.enc, HEX64_RE) ||
    !isStr(v.pondSeed, ID_RE) ||
    !isStr(v.start, HEX64_RE) ||
    !isInt(v.frames, 0, ENC_MAX_FRAME + 1) ||
    !isStr(v.root, HEX64_RE) ||
    !isStr(v.hash, STATE_HASH_RE) ||
    !isInt(v.t, 0, MAX_TIME)
  )
    return null;
  const base = {
    kind: 'settlement' as const,
    rules: v.rules,
    enc: v.enc,
    pondSeed: v.pondSeed,
    start: v.start,
    joins,
    frames: v.frames,
    root: v.root,
    hash: v.hash,
    results,
    t: v.t,
  };
  const tail = refereeTail(v);
  return tail && { ...base, ...tail };
}

export function signedSettlement(v: unknown): SignedSettlement | null {
  if (!isObj(v)) return null;
  const settlement = settlementDoc(v.settlement);
  return settlement &&
    isStr(v.hash, HEX64_RE) &&
    isStr(v.authSig, SIG_RE) &&
    isStr(v.keyId, KEY_ID_RE)
    ? { settlement, hash: v.hash, authSig: v.authSig, keyId: v.keyId }
    : null;
}

/** A player name in a report, or null for none. */
const isNameOrNull = (v: unknown): v is string | null => v === null || isStr(v, NAME_RE);

export function fightReport(v: unknown): FightReport | null {
  return isObj(v) &&
    isStr(v.enc, HEX64_RE) &&
    isKey(OUTCOMES, v.outcome) &&
    (v.cause === null || isCause(v.cause)) &&
    isNameOrNull(v.by) &&
    isKey(EGGS, v.egg) &&
    isNameOrNull(v.eggBy) &&
    isFrame(v.frames)
    ? {
        enc: v.enc,
        outcome: v.outcome,
        cause: v.cause,
        by: v.by,
        egg: v.egg,
        eggBy: v.eggBy,
        frames: v.frames,
      }
    : null;
}

/**
 * A `life` message's fight fields: the running encounter its creature is locked in and the report of
 * a fight settled while the player was away, each when present. Null when either is malformed.
 */
export function lifeFight(o: Obj): { fight?: string; report?: FightReport } | null {
  if (o.fight !== undefined && !isStr(o.fight, HEX64_RE)) return null;
  const report = o.report === undefined ? undefined : fightReport(o.report);
  if (report === null) return null;
  return {
    ...(o.fight === undefined ? {} : { fight: o.fight }),
    ...(report ? { report } : {}),
  };
}
