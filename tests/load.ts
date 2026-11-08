// The load scenario (M13 T5): up to 10,000 players on the headless harness (`tests/aoi-harness.ts`),
// filled over ten minutes, held for six with churn, judged by six gates. It judges what the world
// costs at that size: messages per player-minute, placement, grouping, the link cap and fights. No
// sockets, no WebRTC. `npm run sim:load` writes `docs/perf/load.md` from it, and a scaled run is a
// `heavyTest` against the same gates.

import { createRng, type Rng, seedFromString } from '../src/sim/prng';
import { CENTRE, runScenario } from './aoi-harness';
import type { Meter } from './aoi-meter';
import { type Gate, pct } from './aoi-scenarios';
import type { Box, ClientSpec, FightSpec, RunResult, Scenario } from './aoi-types';
import {
  EDGE_CLEARANCES,
  FIGHT_MS,
  LINK_CAP,
  PEAK_CROWDED_SHARE,
  TOGETHER_P50_MS,
  TOGETHER_P95_MS,
} from './wave';

const MIN = 60_000;
/** The world's half-width less its spawn edge: 131,072 − 2,048. */
const WORLD_HALF = CENTRE - 2048;
/** The wave's density (300 players in a 60,000 wu square), as far as the world allows. */
export const boxFor = (players: number): number =>
  Math.min(WORLD_HALF, 30_000 * Math.sqrt(players / 300));

/** A load run's shape: players and times (ms). */
export interface LoadShape {
  name: string;
  /** The population held. */
  players: number;
  /** Players in the first stretch; the rest join evenly until `fillUntil`. */
  first: number;
  firstUntil: number;
  fillUntil: number;
  /** The hold: the population stays whole, each leaver replaced at once. */
  holdFrom: number;
  holdUntil: number;
  /** Mean of the exponential session of a player (ms). */
  meanSession: number;
  /** In each minute of the hold, one fight per this many players. */
  playersPerFight: number;
  /** The pair checks run every this many ticks, on this share of the clients. */
  pairsEvery: number;
  pairSample: number;
  /** The bandwidth readings run every this many ticks. */
  rateEvery: number;
  /** Players wander within this half-width of the spawn centre (wu). */
  boxHalf: number;
}

/** The spec's scenario: 10,000 players, 16 simulated minutes. */
export const FULL_LOAD: LoadShape = {
  name: 'load',
  players: 10_000,
  first: 10,
  firstUntil: MIN,
  fillUntil: 10 * MIN,
  holdFrom: 10 * MIN,
  holdUntil: 16 * MIN,
  meanSession: 30 * MIN,
  playersPerFight: 100,
  pairsEvery: 10,
  pairSample: 1,
  rateEvery: 10,
  boxHalf: WORLD_HALF,
};

/**
 * The scaled run of the `heavyTest`: 100 players filled over 3 minutes and held for 6. A quicker fill
 * leaves the world still forming its groups through the hold, and the budget gate fails on the joins
 * of the fill, not on the hold.
 */
export const SCALED_LOAD: LoadShape = {
  name: 'load (scaled)',
  players: 100,
  first: 10,
  firstUntil: 20_000,
  fillUntil: 3 * MIN,
  holdFrom: 3 * MIN,
  holdUntil: 9 * MIN,
  meanSession: 30 * MIN,
  playersPerFight: 20,
  pairsEvery: 2,
  pairSample: 1,
  rateEvery: 5,
  boxHalf: boxFor(100),
};

const T1_SHARE = 0.09;
const T2_SHARE = 0.01;
const T0_R: [number, number] = [12, 28];
const T1_R: [number, number] = [40, 110];
const T2_R: [number, number] = [140, 400];

function player(rng: Rng, id: string, spawnAt: number, half: number): ClientSpec {
  const box: Box = { x0: CENTRE - half, y0: CENTRE - half, x1: CENTRE + half, y1: CENTRE + half };
  const roll = rng.next();
  const [lo, hi] = roll < T2_SHARE ? T2_R : roll < T2_SHARE + T1_SHARE ? T1_R : T0_R;
  const r = rng.range(lo, hi);
  return {
    id,
    x: CENTRE,
    y: CENTRE,
    r,
    adultR: r,
    spawnAt,
    place: true,
    walk: {
      heading: rng.range(0, 2 * Math.PI),
      speed: rng.range(40, 105),
      turn: 1.5,
      dash: true,
      box,
    },
  };
}

/** An exponential draw with this mean. */
const exponential = (rng: Rng, mean: number): number => -mean * Math.log(1 - rng.next());

/**
 * The players of a run, in the order they join: the fill (`first` in the first stretch, the rest
 * evenly after it), then, through the hold, a newcomer at each leaver's leave. A player's session is
 * exponential; in the fill nobody leaves (the hold starts the clocks, which an exponential session
 * allows without changing the rate).
 */
export function loadPlayers(rng: Rng, shape: LoadShape): ClientSpec[] {
  const players: ClientSpec[] = [];
  const rest = shape.players - shape.first;
  for (let i = 0; i < shape.players; i++) {
    const spawnAt =
      i < shape.first
        ? Math.round((i * shape.firstUntil) / shape.first)
        : Math.round(
            shape.firstUntil + ((i - shape.first) * (shape.fillUntil - shape.firstUntil)) / rest,
          );
    const p = player(rng, `p${i}`, spawnAt, shape.boxHalf);
    p.leaveAt = shape.holdFrom + Math.round(exponential(rng, shape.meanSession));
    players.push(p);
  }
  // Each leaver inside the hold is replaced at once by a newcomer, whose own session follows. The
  // leaves are kept sorted; a newcomer's leave lies later than the one it replaces.
  const leaves = players.map((p) => p.leaveAt as number).sort((a, b) => a - b);
  let next = shape.players;
  for (let k = 0; k < leaves.length; k++) {
    const at = leaves[k] as number;
    if (at >= shape.holdUntil) break;
    const p = player(rng, `p${next++}`, at, shape.boxHalf);
    const leaveAt = at + Math.round(exponential(rng, shape.meanSession));
    p.leaveAt = leaveAt;
    players.push(p);
    let i = leaves.length;
    leaves.push(leaveAt);
    while (i > k + 1 && (leaves[i - 1] as number) > leaveAt) {
      leaves[i] = leaves[i - 1] as number;
      i--;
    }
    leaves[i] = leaveAt;
  }
  // A leave long after the run's end is no leave at all.
  for (const p of players) {
    if ((p.leaveAt as number) >= shape.holdUntil + MIN) delete p.leaveAt;
  }
  return players;
}

/** In each minute of the hold, `players / playersPerFight` attackers engage at 10 s into it, for `FIGHT_MS`. */
function fightsFor(rng: Rng, players: ClientSpec[], shape: LoadShape): FightSpec[] {
  const fights: FightSpec[] = [];
  const used = new Set<string>();
  const perMinute = Math.max(1, Math.round(shape.players / shape.playersPerFight));
  for (let from = shape.holdFrom + 10_000; from + FIGHT_MS <= shape.holdUntil; from += MIN) {
    const until = from + FIGHT_MS;
    const here = players.filter(
      (p) => p.spawnAt + 20_000 <= from && (p.leaveAt === undefined || p.leaveAt > until),
    );
    for (let k = 0; k < perMinute && here.length > 0; k++) {
      // An attacker is not named twice while others are free.
      const free = here.filter((p) => !used.has(p.id));
      const pool = free.length > 0 ? free : here;
      const pick = pool[rng.int(0, pool.length - 1)];
      if (!pick) break;
      used.add(pick.id);
      fights.push({ from, until, fighters: [pick.id], witnesses: [], engage: true });
    }
  }
  return fights;
}

export function loadScenario(
  seed: string,
  shape: LoadShape = FULL_LOAD,
  meter?: Meter,
  progress?: Scenario['progress'],
): Scenario {
  const rng = createRng(seedFromString(`load|${shape.name}|${seed}`), 'layout');
  const clients = loadPlayers(rng, shape);
  return {
    name: shape.name,
    seconds: shape.holdUntil / 1000,
    clients,
    fights: fightsFor(rng, clients, shape),
    ride: true,
    instances: true,
    pairsEvery: shape.pairsEvery,
    pairSample: shape.pairSample,
    rateEvery: shape.rateEvery,
    ...(meter ? { meter } : {}),
    ...(progress ? { progress } : {}),
    wave: {
      peakFrom: shape.holdFrom,
      peakUntil: shape.holdUntil,
      regroupFrom: Number.POSITIVE_INFINITY,
      crowdsGoneAt: Number.POSITIVE_INFINITY,
      holdFrom: shape.holdFrom,
      holdUntil: shape.holdUntil,
    },
  };
}

export function runLoad(
  seed: string,
  shape: LoadShape = FULL_LOAD,
  meter?: Meter,
  progress?: Scenario['progress'],
): RunResult {
  return runScenario(loadScenario(seed, shape, meter, progress), seed);
}

// ---- the gates ----

/**
 * The budget's tail at 10,000 (ADR 0070): the median at most 8 and the p95 at most the Worker's own
 * 20 messages a player-minute (one request-equivalent). The wave's 6 and 12 (ADR 0066) stay the wave's.
 */
export const LOAD_MSG_MEDIAN = 8;
export const LOAD_MSG_P95 = 20;
/** Hidden-creature seconds allowed per million client-seconds (ADR 0070). */
export const LOAD_HIDDEN_PER_MILLION = 1;
export const LOAD_JOIN_P95 = 100;
export const LOAD_MSG_MEAN = 12;

const examples = (r: RunResult, key: keyof RunResult['violations']) =>
  r.examples[key].slice(0, 3).join('; ');
const secs = (ms: number) => (ms / 1000).toFixed(2);

/** The six gates over one run. */
export function loadGates(run: RunResult): Gate[] {
  const w = run.wave;
  if (!w) throw new Error('a load run records the wave');
  const v = (k: keyof RunResult['violations']) => run.violations[k];

  const steady = w.holdSteady;
  const median = pct(steady, 0.5);
  const p95 = pct(steady, 0.95);
  const join = pct(w.holdJoin, 0.95);
  const mean = w.holdMinutes === 0 ? 0 : w.holdMessages / w.holdMinutes;
  const budgetOk =
    steady.length > 0 &&
    median <= LOAD_MSG_MEDIAN &&
    p95 <= LOAD_MSG_P95 &&
    (w.holdJoin.length === 0 || join <= LOAD_JOIN_P95) &&
    mean <= LOAD_MSG_MEAN;

  const arrivals = w.arrivals;
  const edge = arrivals.filter((a) => a.groupSize > 0);
  const far = edge.filter(
    (a) => a.fallback !== 'none' || (a.edgeClearances ?? 0) > EDGE_CLEARANCES,
  );
  const placementOk = v('clearance') === 0 && run.spawnFallbacks === 0 && far.length === 0;

  const ms = (x: number | null) => x ?? Number.POSITIVE_INFINITY;
  const grouped = arrivals.filter((a) => !a.ride && a.tier === 0 && a.groupSize > 0);
  const groupLink = grouped.map((a) => ms(a.groupLinkMs));
  const g50 = pct(groupLink, 0.5);
  const g95 = pct(groupLink, 0.95);
  const togetherOk = g50 <= TOGETHER_P50_MS && g95 <= TOGETHER_P95_MS;

  const crowdedShare = run.clientLate === 0 ? 0 : run.crowdedLate / run.clientLate;
  const boundedOk = run.maxHeld <= LINK_CAP && crowdedShare <= PEAK_CROWDED_SHARE;

  const hiddenAllowed = Math.floor((LOAD_HIDDEN_PER_MILLION * run.clientSeconds) / 1e6);
  const fights = w.fights.filter((f) => f.fighters.length > 1).length;

  return [
    {
      n: 1,
      name: `Budget: in the hold, after a player's first minute, at most ${LOAD_MSG_MEDIAN} world messages per player-minute (median) and ${LOAD_MSG_P95} (p95); in a joiner's first minute at most ${LOAD_JOIN_P95} (p95); the hold's mean, churn included, at most ${LOAD_MSG_MEAN}`,
      ok: budgetOk,
      detail: `${steady.length} players: median ${median.toFixed(1)}, p95 ${p95.toFixed(1)}; ${w.holdJoin.length} joiners: first minute p95 ${join.toFixed(0)}; mean ${mean.toFixed(1)} over ${Math.round(w.holdMinutes)} player-minutes`,
    },
    {
      n: 2,
      name: `Placement: no clearance violation, no fall back to the spawn centre, every spawn with a group within the group's reach plus ${EDGE_CLEARANCES} clearances`,
      ok: placementOk,
      detail: `${run.spawns} spawns and rides: ${v('clearance')} clearance violations${v('clearance') === 0 ? '' : ` (${examples(run, 'clearance')})`}, ${run.spawnFallbacks} fell back, ${far.length} of ${edge.length} with a group too far`,
    },
    {
      n: 3,
      name: `Together: a T0 newcomer with a group is linked to one of its members within ${TOGETHER_P50_MS / 1000} s (median) and ${TOGETHER_P95_MS / 1000} s (p95)`,
      ok: togetherOk,
      detail: `${grouped.length} newcomers: median ${secs(g50)} s, p95 ${secs(g95)} s`,
    },
    {
      n: 4,
      name: `Bounded: never more than ${LINK_CAP} links, and at most ${PEAK_CROWDED_SHARE * 100}% of client-seconds crowded after a client's first 10 s`,
      ok: boundedOk,
      detail: `${run.maxHeld} links at most, ${(100 * crowdedShare).toFixed(2)}% crowded`,
    },
    {
      n: 5,
      name: `No hidden creature: a pair that shares water and can interact is left unlinked for at most ${LOAD_HIDDEN_PER_MILLION} second in a million client-seconds`,
      ok: v('hidden') <= hiddenAllowed,
      detail: `${v('hidden')} violations in ${(run.clientSeconds / 1e6).toFixed(1)} million client-seconds (at most ${hiddenAllowed})${v('hidden') === 0 ? '' : `: ${examples(run, 'hidden')}`}`,
    },
    {
      n: 6,
      name: 'Integrity: fighters share water and keep their instance through their fights',
      ok: v('fightWater') === 0,
      detail: `${fights} fights, ${v('fightWater')} violations${v('fightWater') === 0 ? '' : `: ${examples(run, 'fightWater')}`}`,
    },
  ];
}
