import {
  type ClientMsg,
  ENC_END_MAX_BYTES,
  ENC_MAX_FIGHTERS,
  ENC_MAX_FRAME,
  ENC_START_MAX_BYTES,
  type FighterInfo,
  type FighterOutcome,
  type HubMsg,
  isCause,
  type SignedSnap,
} from './protocol-defs';
import {
  capped,
  GENOME_DATA_RE,
  HEX64_RE,
  isInt,
  isNum,
  isObj,
  isStr,
  list,
  MAX_CONDITION,
  MAX_TICK,
  MAX_TIME,
  type Obj,
  PLAYER_ID_RE,
  SIG_RE,
} from './protocol-kit';

// Protocol 7's encounter messages (ADR 0050, M7). Every number is finite and in range, ids are hex
// and player ids well-formed; anything else parses as null.

/** A lock id: 8 to 32 random bytes as hex. */
const LOCK_RE = /^[0-9a-f]{16,64}$/;
/** The 25 snapshot bytes in base64url. */
const SNAP_RE = /^[A-Za-z0-9_-]{34}$/;
/** Positions lie in the world (the snapshot covers 0 to 8192 wu), velocities within a snapshot's range. */
const POS_MAX = 8192;
const VEL_MAX = 8192;
const HEADING_MAX = 2 * Math.PI;
/** Far above any carrion piece's body (a body's radius stays in the hundreds of wu). */
const RADIUS_MAX = 10_000;
const MIN_FIGHTERS = 2;
const U32_MAX = 0xffffffff;

const inRange = (v: unknown, min: number, max: number): v is number =>
  isNum(v) && v >= min && v <= max;
const isFrame = (v: unknown): v is number => isInt(v, 0, ENC_MAX_FRAME);
const isSlot = (v: unknown): v is number => isInt(v, 0, ENC_MAX_FIGHTERS - 1);
const isPos = (v: unknown): v is number => inRange(v, 0, POS_MAX);
const isCondition = (v: unknown): v is number => inRange(v, 0, MAX_CONDITION);

function signedSnap(v: unknown): SignedSnap | null {
  return isObj(v) && isStr(v.snap, SNAP_RE) && isStr(v.sig, SIG_RE)
    ? { snap: v.snap, sig: v.sig }
    : null;
}

/** The fields a fighter's start and its outcome share, or null. */
function fighterState(v: Obj): Omit<FighterInfo, 'genome' | 'elder' | 'egg'> | null {
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

function fighterInfo(v: unknown): FighterInfo | null {
  const state = isObj(v) ? fighterState(v) : null;
  return state &&
    isObj(v) &&
    isStr(v.genome, GENOME_DATA_RE) &&
    typeof v.elder === 'boolean' &&
    typeof v.egg === 'boolean'
    ? { ...state, genome: v.genome, elder: v.elder, egg: v.egg }
    : null;
}

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
      return mine && isStr(o.lock, LOCK_RE)
        ? capped(raw, { t: 'lock-state', lock: o.lock, mine })
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

/** The encounter messages the hub sends, or null (also for any other `t`). */
export function encounterHubMsg(o: Obj, raw: string): HubMsg | null {
  switch (o.t) {
    case 'lock-ask':
      return isStr(o.lock, LOCK_RE) ? capped(raw, { t: 'lock-ask', lock: o.lock }) : null;
    case 'enc-start': {
      const fighters = perSlot(o.fighters, fighterInfo);
      return fighters &&
        isStr(o.enc, HEX64_RE) &&
        isStr(o.seed, HEX64_RE) &&
        isInt(o.round, 0, MAX_TICK) &&
        isInt(o.t0, 0, MAX_TICK) &&
        isInt(o.at, 0, MAX_TIME)
        ? capped(
            raw,
            {
              t: 'enc-start',
              enc: o.enc,
              seed: o.seed,
              round: o.round,
              t0: o.t0,
              at: o.at,
              fighters,
            },
            ENC_START_MAX_BYTES,
          )
        : null;
    }
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
      return fighters && isStr(o.enc, HEX64_RE) && isFrame(o.f) && isStr(o.hash, HEX64_RE)
        ? capped(
            raw,
            { t: 'enc-end', enc: o.enc, f: o.f, hash: o.hash, fighters },
            ENC_END_MAX_BYTES,
          )
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
