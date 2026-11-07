// The harness's scenarios and gates (M11 T10, ADR 0062): seven worlds laid out by seed, and the eight
// gates a run must meet. `tests/aoi-harness.ts` runs them; the test and `npm run report:aoi` judge them.

import { createRng, type Rng, seedFromString } from '../src/sim/prng';
import {
  type Box,
  CENTRE,
  type ClientSpec,
  type FightSpec,
  type RunResult,
  type Scenario,
  type Walk,
} from './aoi-harness';

export const SCENARIO_NAMES = [
  'friends',
  'sparse',
  'crowd',
  'tiers',
  'streams',
  'traveller',
  'witnesses',
] as const;
export type ScenarioName = (typeof SCENARIO_NAMES)[number];

export interface ScenarioOptions {
  /** Creatures move this many times as fast (the property test runs at 2). */
  speed?: number;
  /** A share of the population and the area, and of the time: smaller worlds for quick runs. */
  scale?: number;
}

/** A radius in each size tier (T0 below 32, T1 below 128, T2 below 512, T3 below 2,048). */
const TIER_R: [number, number][] = [
  [12, 28],
  [40, 110],
  [160, 450],
  [600, 1800],
];

const box = (cx: number, cy: number, w: number, h = w): Box => ({
  x0: cx - w / 2,
  y0: cy - h / 2,
  x1: cx + w / 2,
  y1: cy + h / 2,
});

function wander(rng: Rng, speed: number, b: Box | undefined, dash = true): Walk {
  return {
    heading: rng.range(0, 2 * Math.PI),
    speed: rng.range(40, 105) * speed,
    turn: 1.5,
    dash,
    box: b,
  };
}

function walker(
  rng: Rng,
  id: string,
  tier: number,
  b: Box,
  speed: number,
  spawnAt = 0,
  at?: { x: number; y: number },
): ClientSpec {
  const [lo, hi] = TIER_R[tier] as [number, number];
  const r = rng.range(lo, hi);
  return {
    id,
    x: at?.x ?? rng.range(b.x0, b.x1),
    y: at?.y ?? rng.range(b.y0, b.y1),
    r,
    adultR: r,
    spawnAt,
    walk: wander(rng, speed, b),
  };
}

export function makeScenario(
  name: ScenarioName,
  seed: string,
  opts: ScenarioOptions = {},
): Scenario {
  const speed = opts.speed ?? 1;
  const scale = opts.scale ?? 1;
  const rng = createRng(seedFromString(`layout|${name}|${seed}`), 'layout');
  const n = (count: number) => Math.max(2, Math.round(count * scale));
  switch (name) {
    case 'friends': {
      const around = box(CENTRE, CENTRE, 10_000);
      const clients = Array.from({ length: 6 }, (_, i) => {
        const a = (i / 6) * 2 * Math.PI + rng.range(-0.2, 0.2);
        const at = { x: CENTRE + 2400 * Math.cos(a), y: CENTRE + 2400 * Math.sin(a) };
        return walker(rng, `f${i}`, 0, around, speed, i * 500, at);
      });
      return { name, seconds: 40, clients, friends: true };
    }
    case 'sparse': {
      const side = 40_000 * Math.sqrt(scale);
      const world = box(CENTRE, CENTRE, side);
      const clients = Array.from({ length: n(200) }, (_, i) =>
        walker(rng, `s${i}`, rng.next() < 0.1 ? 1 : 0, world, speed, rng.range(0, 20_000)),
      );
      return { name, seconds: 150, clients };
    }
    case 'crowd': {
      const room = box(CENTRE, CENTRE, 2660);
      const clients = Array.from({ length: 40 }, (_, i) => ({
        ...walker(rng, `c${i}`, 0, room, speed, rng.range(0, 20_000)),
        r: rng.range(14, 26),
        adultR: 26,
      }));
      return { name, seconds: 60, clients };
    }
    case 'tiers': {
      const world = box(CENTRE, CENTRE, 24_000);
      const mix = [30, 10, 5, 2];
      const clients = mix.flatMap((count, tier) =>
        Array.from({ length: count }, (_, i) =>
          walker(rng, `t${tier}_${i}`, tier, world, speed, rng.range(0, 10_000)),
        ),
      );
      // One starter grows across the T0/T1 edge while it swims.
      const grower = clients[0] as ClientSpec;
      grower.r = 28;
      grower.adultR = 40;
      grower.walk.grow = 0.005;
      return { name, seconds: 90, clients };
    }
    case 'streams': {
      const lane = (g: number, i: number): ClientSpec => {
        const gx = (i % 4) * 120;
        const gy = Math.floor(i / 4) * 120;
        const r = rng.range(14, 26);
        return {
          id: `g${g}_${i}`,
          x: CENTRE + (g === 0 ? -3500 + gx : 3500 - gx),
          y: CENTRE + gy,
          r,
          adultR: r,
          spawnAt: rng.range(0, 10_000),
          walk: { heading: g === 0 ? 0 : Math.PI, speed: 105 * speed, turn: 0, dash: true },
        };
      };
      const clients = [0, 1].flatMap((g) => Array.from({ length: 12 }, (_, i) => lane(g, i)));
      return { name, seconds: Math.round(7000 / (105 * speed * 1.1)) + 150, clients };
    }
    case 'traveller': {
      const length = 60_000 * scale;
      const world = box(CENTRE, CENTRE, length + 10_000, 12_000);
      const clients = Array.from({ length: n(100) }, (_, i) =>
        walker(rng, `w${i}`, 0, world, speed, rng.range(0, 20_000)),
      );
      const x0 = CENTRE - length / 2;
      clients.push({
        id: 'traveller',
        x: x0,
        y: CENTRE,
        r: 20,
        adultR: 20,
        spawnAt: 0,
        walk: { heading: 0, speed: 100 * speed, turn: 0, dash: false },
      });
      return { name, seconds: Math.max(130, Math.round(length / (100 * speed)) + 5), clients };
    }
    case 'witnesses': {
      const room = box(CENTRE, CENTRE, 2660);
      const crowd = Array.from({ length: 40 }, (_, i) => ({
        ...walker(rng, `c${i}`, 0, room, speed, rng.range(0, 15_000)),
        r: rng.range(14, 26),
        adultR: 26,
      }));
      const far = box(CENTRE + 20_000, CENTRE, 2000);
      const witnesses = Array.from({ length: 3 }, (_, i) =>
        walker(rng, `w${i}`, 0, far, speed, 1000),
      );
      const fights: FightSpec[] = [0, 1, 2].map((i) => ({
        from: 20_000,
        until: 50_000,
        fighters: [`c${2 * i}`, `c${2 * i + 1}`],
        witnesses: [`w${i}`],
      }));
      return { name, seconds: 60, clients: [...crowd, ...witnesses], fights };
    }
  }
}

// ---- the gates ----

export interface Gate {
  n: number;
  name: string;
  ok: boolean;
  detail: string;
}

export const GATE_CAP = 'The cap';
/** A hatch to a hello: the median within 3 s; one attempt in 20 fails and is retried, so the p95 is 5 s. */
export const FRIENDS_P50_MS = 3000;
export const FRIENDS_P95_MS = 5000;
export const MSG_MEDIAN = 6;
export const MSG_P95 = 12;
/** A creature's first minute: an offer and an answer for each of the 24 links it dials. */
export const JOIN_P95 = 48;
export const RELAY_SHARE = 0.7;
export const GOSSIP_KBPS = 0.3;

export function pct(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] as number;
}

const sum = (runs: RunResult[], f: (r: RunResult) => number) => runs.reduce((s, r) => s + f(r), 0);
const examples = (runs: RunResult[], keys: (keyof RunResult['violations'])[]) =>
  runs
    .flatMap((r) => keys.flatMap((k) => r.examples[k].map((e) => `${r.seed}: ${e}`)))
    .slice(0, 3)
    .join('; ');

/** The eight gates over one scenario's runs (several seeds are pooled). */
export function gatesOf(runs: RunResult[]): Gate[] {
  const v = (k: keyof RunResult['violations']) => sum(runs, (r) => r.violations[k]);
  const name = runs[0]?.scenario ?? '';
  const zero = (n: number, title: string, keys: (keyof RunResult['violations'])[]): Gate => {
    const count = keys.reduce((s, k) => s + v(k), 0);
    return {
      n,
      name: title,
      ok: count === 0,
      detail: count === 0 ? '0 violations' : `${count} violations: ${examples(runs, keys)}`,
    };
  };
  const friends = runs.flatMap((r) => r.friendMs);
  const perMinute = runs.flatMap((r) => r.perMinute);
  const join = pct(
    runs.flatMap((r) => r.joinMinute),
    0.95,
  );
  const lateLinks = sum(runs, (r) => r.lateLinks);
  const lateRelayed = sum(runs, (r) => r.lateRelayed);
  const share = lateLinks === 0 ? 1 : lateRelayed / lateLinks;
  const kbps =
    sum(runs, (r) => r.gossipBytes) /
    1000 /
    Math.max(
      1,
      sum(runs, (r) => r.linkSeconds),
    );
  const relayScenario = name === 'sparse' || name === 'streams';
  const dense = name === 'crowd' || name === 'witnesses';
  const budgeted = name !== 'crowd' && name !== 'witnesses';
  const median = pct(perMinute, 0.5);
  const p95 = pct(perMinute, 0.95);
  const budgetOk =
    (!budgeted || (median <= MSG_MEDIAN && p95 <= MSG_P95 && join <= JOIN_P95)) &&
    (!relayScenario || lateLinks === 0 || share >= RELAY_SHARE);
  const duties = sum(runs, (r) => r.duties);
  return [
    zero(1, 'The cap holds', ['cap']),
    zero(2, 'No hidden interactable creature', ['hidden']),
    zero(
      3,
      'Seamless handoffs: no pops, newcomers linked 0.5 s ahead',
      dense ? ['pops'] : ['pops', 'late'],
    ),
    {
      n: 4,
      name: 'Friends linked within 3 s (median), 5 s (p95)',
      ok:
        friends.length === 0 ||
        (pct(friends, 0.5) <= FRIENDS_P50_MS && pct(friends, 0.95) <= FRIENDS_P95_MS),
      detail:
        friends.length === 0
          ? 'n/a'
          : `median ${(pct(friends, 0.5) / 1000).toFixed(2)} s, p95 ${(pct(friends, 0.95) / 1000).toFixed(2)} s over ${friends.length} pairs`,
    },
    {
      n: 5,
      name: 'Budget: authority messages and relayed links',
      ok: budgetOk,
      detail: `median ${median}, p95 ${p95} per player-minute after the first, ${join} (p95) in the first; ${
        relayScenario
          ? `${(100 * share).toFixed(0)}% of ${lateLinks} later links relayed`
          : 'relay share n/a'
      }`,
    },
    {
      n: 6,
      name: 'Gossip within 0.3 KB/s per link',
      ok: kbps <= GOSSIP_KBPS,
      detail: `${kbps.toFixed(3)} KB/s`,
    },
    zero(7, 'Tiers: no link two tiers apart, every swarm complete', ['tierLink', 'swarm']),
    {
      ...zero(8, 'Witness duties taken within the cap', ['duty', 'dutyCap']),
      detail:
        duties === 0
          ? 'n/a'
          : `${sum(runs, (r) => r.dutiesTaken)} of ${duties} duty links taken in 10 s; ${examples(runs, ['duty', 'dutyCap']) || '0 violations'}`,
    },
  ];
}
