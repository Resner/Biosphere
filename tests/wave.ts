// The population wave (M12 T9): 5 players, then 300, then 20, on the headless harness
// (`tests/aoi-harness.ts`, ADR 0062), judged by eight gates. It judges grouping, not cost (M13): no
// sockets, no WebRTC. `npm run sim:wave` writes `docs/perf/wave.md` from it, and a scaled wave is a
// `heavyTest` against the same gates.

import { createRng, type Rng, seedFromString } from '../src/sim/prng';
import { CENTRE, RIDE_AFTER_FIGHT_MS, runScenario } from './aoi-harness';
import { type Gate, pct, sum } from './aoi-scenarios';
import type { Box, ClientSpec, FightSpec, RunResult, Scenario } from './aoi-types';
import type { WaveParams } from './wave-record';

const MIN = 60_000;

/** A wave's shape: players and times (ms). The gate windows follow from it. */
export interface WaveShape {
  name: string;
  /** Players in the first stretch, the peak population and the players left at the end. */
  first: number;
  peak: number;
  rest: number;
  /** The first stretch ends here; the rest join one every `joinEvery` ms after it. */
  firstUntil: number;
  joinEvery: number;
  /** Players leave at random between these times, down to `rest`. */
  fallFrom: number;
  fallUntil: number;
  /** The peak window, where the fights and the crowded share are judged. */
  peakFrom: number;
  peakUntil: number;
  /** The gates wait this long after the fall for the water to regroup and the crowds to end. */
  regroupAfter: number;
  crowdsGoneAfter: number;
  end: number;
}

/** The wave of the spec: 5 → 300 → 20, 24 simulated minutes. */
export const FULL_WAVE: WaveShape = {
  name: 'wave',
  first: 5,
  peak: 300,
  rest: 20,
  firstUntil: 2 * MIN,
  joinEvery: 2000,
  fallFrom: 14 * MIN,
  fallUntil: 18 * MIN,
  peakFrom: 8 * MIN,
  peakUntil: 14 * MIN,
  regroupAfter: 4 * MIN,
  crowdsGoneAfter: 2 * MIN,
  end: 24 * MIN,
};

/** The scaled wave of the `heavyTest`: 5 → 60 → 10 over 8 minutes, the waits after the fall shortened to fit. */
export const SCALED_WAVE: WaveShape = {
  name: 'wave (scaled)',
  first: 5,
  peak: 60,
  rest: 10,
  firstUntil: MIN,
  joinEvery: 2500,
  fallFrom: 3.5 * MIN,
  fallUntil: 4.5 * MIN,
  peakFrom: 2.5 * MIN,
  peakUntil: 3.5 * MIN,
  regroupAfter: 2.5 * MIN,
  crowdsGoneAfter: MIN,
  end: 8 * MIN,
};

/** Pairs of comparable players fight each minute of the peak, for this long. */
export const FIGHT_MS = 30_000;
export const FIGHTS_PER_MINUTE = 3;
/** A share of the players are restored with a T1 ancestor's size. */
const T1_SHARE = 0.1;
const T0_R: [number, number] = [12, 28];
const T1_R: [number, number] = [40, 110];

const WORLD_BOX: Box = {
  x0: CENTRE - 30_000,
  y0: CENTRE - 30_000,
  x1: CENTRE + 30_000,
  y1: CENTRE + 30_000,
};

/** The wave as a harness scenario: everyone enters by `place()`, wanders, and rides when alone. */
export function waveScenario(seed: string, shape: WaveShape = FULL_WAVE): Scenario {
  const rng = createRng(seedFromString(`wave|${shape.name}|${seed}`), 'layout');
  const players: ClientSpec[] = [];
  for (let i = 0; i < shape.peak; i++) {
    const spawnAt =
      i < shape.first
        ? Math.round((i * shape.firstUntil) / shape.first)
        : shape.firstUntil + (i - shape.first) * shape.joinEvery;
    players.push(player(rng, `p${i}`, spawnAt));
  }
  // The fall: a random subset leaves at random times, down to the players that remain.
  const order = players.map((p) => p.id);
  for (let i = order.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [order[i], order[j]] = [order[j] as string, order[i] as string];
  }
  const leavers = new Set(order.slice(0, shape.peak - shape.rest));
  for (const p of players) {
    if (leavers.has(p.id)) p.leaveAt = Math.round(rng.range(shape.fallFrom, shape.fallUntil));
  }
  const fights = fightsFor(rng, players, shape);
  const wave: WaveParams = {
    peakFrom: shape.peakFrom,
    peakUntil: shape.peakUntil,
    regroupFrom: shape.fallUntil + shape.regroupAfter,
    crowdsGoneAt: shape.fallUntil + shape.crowdsGoneAfter,
  };
  return {
    name: shape.name,
    seconds: shape.end / 1000,
    clients: players,
    fights,
    ride: true,
    instances: true,
    wave,
  };
}

function player(rng: Rng, id: string, spawnAt: number): ClientSpec {
  const [lo, hi] = rng.next() < T1_SHARE ? T1_R : T0_R;
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
      box: WORLD_BOX,
    },
  };
}

/**
 * `FIGHTS_PER_MINUTE` fights at the start of each minute of the peak, 10 s in: an attacker is named
 * and the harness picks its opponent as an engage does (the nearest comparable creature that shares
 * its water). An attacker is in the water the whole fight and not named twice in a row.
 */
function fightsFor(rng: Rng, players: ClientSpec[], shape: WaveShape): FightSpec[] {
  const fights: FightSpec[] = [];
  const used = new Set<string>();
  for (let from = shape.peakFrom + 10_000; from + FIGHT_MS <= shape.peakUntil; from += MIN) {
    const until = from + FIGHT_MS;
    const here = players.filter(
      (p) => p.spawnAt + 20_000 <= from && (p.leaveAt === undefined || p.leaveAt > until),
    );
    for (let k = 0; k < FIGHTS_PER_MINUTE && here.length > 0; k++) {
      const free = here.filter((p) => !used.has(p.id));
      const pick = (free.length > 0 ? free : here)[rng.int(0, (free.length || here.length) - 1)];
      if (!pick) break;
      used.add(pick.id);
      fights.push({ from, until, fighters: [pick.id], witnesses: [], engage: true });
    }
  }
  return fights;
}

export function runWave(seed: string, shape: WaveShape = FULL_WAVE): RunResult {
  return runScenario(waveScenario(seed, shape), seed);
}

// ---- the gates ----

export const TOGETHER_P50_MS = 3000;
export const TOGETHER_P95_MS = 5000;
export const NEWCOMER_P95_MS = 15_000;
export const REGROUPED_SHARE = 0.9;
export const PEAK_CROWDED_SHARE = 0.01;
export const LINK_CAP = 32;
export const WAVE_MSG_MEDIAN = 6;
export const WAVE_MSG_P95 = 12;

const examples = (runs: RunResult[], key: keyof RunResult['violations']) =>
  runs
    .flatMap((r) => r.examples[key].map((e) => `${r.seed}: ${e}`))
    .slice(0, 3)
    .join('; ');

const secs = (ms: number) => (ms / 1000).toFixed(2);

/** The eight gates over a wave's runs (several seeds are pooled). */
export function waveGates(runs: RunResult[]): Gate[] {
  const waves = runs.map((r) => r.wave).filter((w) => w !== undefined);
  const v = (k: keyof RunResult['violations']) => sum(runs, (r) => r.violations[k]);
  const arrivals = waves.flatMap((w) => w.arrivals);
  // A newcomer never linked counts as unlinked forever.
  const ms = (x: number | null) => x ?? Number.POSITIVE_INFINITY;

  const clearance = v('clearance');
  const fallbacks = sum(runs, (r) => r.spawnFallbacks);

  const grouped = arrivals.filter((a) => !a.ride && a.tier === 0 && a.groupSize > 0);
  const groupLink = grouped.map((a) => ms(a.groupLinkMs));
  const newcomers = arrivals.filter((a) => !a.ride).map((a) => ms(a.linkMs));
  const g50 = pct(groupLink, 0.5);
  const g95 = pct(groupLink, 0.95);
  const n95 = pct(newcomers, 0.95);
  const togetherOk = g50 <= TOGETHER_P50_MS && g95 <= TOGETHER_P95_MS && n95 <= NEWCOMER_P95_MS;

  const edge = arrivals.filter((a) => a.groupSize > 0);
  const far = edge.filter((a) => a.fallback !== 'none' || (a.beyondEdge ?? 0) > 0);
  const farMost = Math.max(0, ...edge.map((a) => a.beyondEdge ?? 0));

  const samples = waves.flatMap((w) => w.regroup);
  const worst = Math.min(
    1,
    ...samples.filter((s) => s.eligible > 0).map((s) => s.linked / s.eligible),
  );
  const regroupOk = samples.length > 0 && worst >= REGROUPED_SHARE;

  const peakSeconds = sum(runs, (r) => r.wave?.peakSeconds ?? 0);
  const crowdedShare =
    peakSeconds === 0 ? 0 : sum(runs, (r) => r.wave?.peakCrowded ?? 0) / peakSeconds;
  const maxHeld = Math.max(...runs.map((r) => r.maxHeld));
  const crowdsLeft = Math.max(0, ...waves.map((w) => w.crowdsLeft));
  const boundedOk = crowdedShare <= PEAK_CROWDED_SHARE && maxHeld <= LINK_CAP && crowdsLeft === 0;

  // A rider is never a fighter, nor within 120 s of the end of its fight.
  const badRides = waves.flatMap((w) =>
    w.rides.filter((ride) =>
      w.fights.some(
        (f) =>
          f.fighters.includes(ride.id) &&
          ride.t >= f.from &&
          ride.t < f.until + RIDE_AFTER_FIGHT_MS,
      ),
    ),
  );
  const fightWater = v('fightWater');

  const perMinute = runs.flatMap((r) => r.perMinute);
  const median = pct(perMinute, 0.5);
  const p95 = pct(perMinute, 0.95);

  const fights = sum(runs, (r) => r.wave?.fights.filter((f) => f.fighters.length > 1).length ?? 0);
  const rides = sum(runs, (r) => r.rides);

  return [
    {
      n: 1,
      name: 'Clearance: every spawn and ride arrival keeps its distance, in the depth band',
      ok: clearance === 0,
      detail: `${arrivals.length} arrivals (${fallbacks} fell back to the spawn centre), ${clearance} violations${clearance === 0 ? '' : `: ${examples(runs, 'clearance')}`}`,
    },
    {
      n: 2,
      name: `Together: a T0 newcomer with a group linked to it within ${TOGETHER_P50_MS / 1000} s (median), ${TOGETHER_P95_MS / 1000} s (p95); every newcomer within ${NEWCOMER_P95_MS / 1000} s (p95)`,
      ok: togetherOk,
      detail: `${grouped.length} T0 newcomers with a group: median ${secs(g50)} s, p95 ${secs(g95)} s; ${newcomers.length} newcomers: p95 ${secs(n95)} s`,
    },
    {
      n: 3,
      name: "At the group's edge: every spawn that found a group lies within its radius plus twice the clearance of its centroid",
      ok: far.length === 0,
      detail: `${edge.length} spawns and rides with a group, ${far.length} too far or at the centre (the farthest ${Math.round(farMost)} wu past the edge)`,
    },
    {
      n: 4,
      name: `Regrouped: from the wait after the fall, at least ${REGROUPED_SHARE * 100}% of the players hold a link to a creature they can link with`,
      ok: regroupOk,
      detail:
        samples.length === 0
          ? 'no samples'
          : `${samples.length} samples, the worst ${(100 * worst).toFixed(0)}%`,
    },
    {
      n: 5,
      name: `Bounded: at the peak at most ${PEAK_CROWDED_SHARE * 100}% of client-seconds crowded, never more than ${LINK_CAP} links; no crowd left after the fall`,
      ok: boundedOk,
      detail: `${(100 * crowdedShare).toFixed(2)}% crowded at the peak, ${maxHeld} links at most, ${crowdsLeft} crowds left`,
    },
    {
      n: 6,
      name: 'No hidden creature: no pair that shares water and can interact is left unlinked',
      ok: v('hidden') === 0,
      detail: `${v('hidden')} violations${v('hidden') === 0 ? '' : `: ${examples(runs, 'hidden')}`}`,
    },
    {
      n: 7,
      name: 'Integrity: no fighter changes instance, fighters share water, no ride by a fighter or within 120 s of its fight',
      ok: fightWater === 0 && badRides.length === 0,
      detail: `${fights} fights, ${rides} rides, ${fightWater} water violations, ${badRides.length} rides by fighters${fightWater === 0 ? '' : `: ${examples(runs, 'fightWater')}`}`,
    },
    {
      n: 8,
      name: `Budget: incoming authority messages per player-minute at most ${WAVE_MSG_MEDIAN} (median) and ${WAVE_MSG_P95} (p95) after a player's first minute`,
      ok: median <= WAVE_MSG_MEDIAN && p95 <= WAVE_MSG_P95,
      detail: `median ${median}, p95 ${p95} over ${perMinute.length} player-minutes`,
    },
  ];
}
