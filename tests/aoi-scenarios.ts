// The harness's scenarios and gates (M11 T10, ADR 0062): seven worlds laid out by seed, and the nine
// gates a run must meet. `tests/aoi-harness.ts` runs them; the test and `npm run report:aoi` judge them.

import { createRng, type Rng, seedFromString } from '../src/sim/prng';
import { CENTRE } from './aoi-harness';
import type { Box, ClientSpec, FightSpec, RunResult, Scenario, Walk } from './aoi-types';

export const SCENARIO_NAMES = [
  'friends',
  'sparse',
  'crowd',
  'tiers',
  'streams',
  'traveller',
  'witnesses',
  'throng',
] as const;
export type ScenarioName = (typeof SCENARIO_NAMES)[number];

export interface ScenarioOptions {
  /** Creatures move this many times as fast (the property test runs at 2). */
  speed?: number;
  /** A share of the population and the area, and of the time: smaller worlds for quick runs. */
  scale?: number;
  /** False runs the scenario without crowd instances, for comparison (M12). */
  instances?: boolean;
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

function wander(rng: Rng, speed: number, b: Box | undefined): Walk {
  return {
    heading: rng.range(0, 2 * Math.PI),
    speed: rng.range(40, 105) * speed,
    turn: 1.5,
    dash: true,
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
  const inst = opts.instances === false ? { instances: false } : {};
  const scenario = (sc: Scenario): Scenario => ({ ...sc, ...inst });
  switch (name) {
    case 'friends': {
      const around = box(CENTRE, CENTRE, 10_000);
      const clients = Array.from({ length: 6 }, (_, i) => {
        const a = (i / 6) * 2 * Math.PI + rng.range(-0.2, 0.2);
        const at = { x: CENTRE + 2400 * Math.cos(a), y: CENTRE + 2400 * Math.sin(a) };
        return { ...walker(rng, `f${i}`, 0, around, speed, i * 500, at), place: true };
      });
      return { name, seconds: 40, clients, friends: true, ...inst };
    }
    case 'sparse': {
      const side = 40_000 * Math.sqrt(scale);
      const world = box(CENTRE, CENTRE, side);
      const clients = Array.from({ length: n(200) }, (_, i) =>
        walker(rng, `s${i}`, rng.next() < 0.1 ? 1 : 0, world, speed, rng.range(0, 20_000)),
      );
      return scenario({ name, seconds: 150, clients });
    }
    case 'crowd': {
      const room = box(CENTRE, CENTRE, 2660);
      const clients = Array.from({ length: 40 }, (_, i) => ({
        ...walker(rng, `c${i}`, 0, room, speed, rng.range(0, 20_000)),
        r: rng.range(14, 26),
        adultR: 26,
      }));
      return scenario({ name, seconds: 60, clients });
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
      return scenario({ name, seconds: 90, clients });
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
      return scenario({ name, seconds: Math.round(7000 / (105 * speed * 1.1)) + 150, clients });
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
      return scenario({
        name,
        seconds: Math.max(130, Math.round(length / (100 * speed)) + 5),
        clients,
      });
    }
    case 'throng': {
      // 80 comparable starters in a room 1,500 wu wide: each has dozens of P1 within reach.
      const room = box(CENTRE, CENTRE, 1500 * Math.sqrt(scale));
      const clients = Array.from({ length: n(80) }, (_, i) => ({
        ...walker(rng, `h${i}`, 0, room, speed, rng.range(0, 5000)),
        r: rng.range(14, 26),
        adultR: 26,
      }));
      return scenario({ name, seconds: 90, clients });
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
        fighters: [`c${2 * i}`],
        witnesses: [`w${i}`],
        engage: true,
      }));
      return scenario({ name, seconds: 60, clients: [...crowd, ...witnesses], fights });
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

/** A hatch to a hello: the median within 3 s; one attempt in 20 fails and is retried, so the p95 is 5 s. */
export const FRIENDS_P50_MS = 3000;
export const FRIENDS_P95_MS = 5000;
export const MSG_MEDIAN = 6;
export const MSG_P95 = 12;
/** A creature's first minute: an offer and an answer for each of the 24 links it dials. */
export const JOIN_P95 = 48;
export const RELAY_SHARE = 0.7;
export const GOSSIP_KBPS = 0.3;
/** Snapshots and gossip on the wire at the asked rates (M11 T15): a client's upload at 24 links, and one link's. */
export const UPLOAD_24_KBPS = 12;
export const LINK_KBPS = 4;
/** Gate 3 in the dense scenarios: late entries in 1,000 (M12, ADR 0065). */
export const LATE_PER_1000 = 15;
/** Gate 10: the share of client-seconds crowded after a client's first 10 s, and instance changes a client-minute (p95). */
export const CROWDED_SHARE = 0.01;
export const CHANGES_P95 = 1;

/** Upload on the wire (KB/s): at 24 links (null with no sample there; most and mean) and on one link at most. */
export function uploadOf(runs: RunResult[]) {
  const gossip =
    sum(runs, (r) => r.gossipBytes) /
    Math.max(
      1,
      sum(runs, (r) => r.linkSeconds),
    );
  const samples = sum(runs, (r) => r.upload24Samples);
  const at24 = (bps: number) => (bps + 24 * gossip) / 1000;
  return {
    max24: samples === 0 ? null : at24(Math.max(...runs.map((r) => r.upload24))),
    mean24: samples === 0 ? null : at24(sum(runs, (r) => r.upload24Sum) / samples),
    link: (Math.max(...runs.map((r) => r.linkUpload)) + gossip) / 1000,
  };
}

export function pct(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] as number;
}

export const sum = (runs: RunResult[], f: (r: RunResult) => number) =>
  runs.reduce((s, r) => s + f(r), 0);
const examples = (runs: RunResult[], keys: (keyof RunResult['violations'])[]) =>
  runs
    .flatMap((r) => keys.flatMap((k) => r.examples[k].map((e) => `${r.seed}: ${e}`)))
    .slice(0, 3)
    .join('; ');

/** The nine gates over one scenario's runs (several seeds are pooled). */
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
  const dense = name === 'crowd' || name === 'witnesses' || name === 'throng';
  const budgeted = !dense;
  const median = pct(perMinute, 0.5);
  const p95 = pct(perMinute, 0.95);
  const budgetOk =
    (!budgeted || (median <= MSG_MEDIAN && p95 <= MSG_P95 && join <= JOIN_P95)) &&
    (!relayScenario || lateLinks === 0 || share >= RELAY_SHARE);
  const duties = sum(runs, (r) => r.duties);
  const up = uploadOf(runs);
  const kb = (v: number) => `${v.toFixed(1)} KB/s`;
  const entries = sum(runs, (r) => r.entries);
  const late = v('late');
  const lateOk = late * 1000 <= LATE_PER_1000 * entries;
  const gate3 = dense
    ? {
        n: 3,
        name: 'Seamless handoffs: no pops, newcomers linked 0.5 s ahead',
        ok: v('pops') === 0 && lateOk,
        detail: `${v('pops')} pops, ${late} late entries in ${entries} (at most ${LATE_PER_1000} in 1,000)${
          v('pops') + late === 0 ? '' : `: ${examples(runs, ['pops', 'late'])}`
        }`,
      }
    : zero(3, 'Seamless handoffs: no pops, newcomers linked 0.5 s ahead', ['pops', 'late']);
  const instanced = runs.every((r) => r.instances);
  const clientLate = sum(runs, (r) => r.clientLate);
  const crowdedShare = clientLate === 0 ? 0 : sum(runs, (r) => r.crowdedLate) / clientLate;
  const changes = pct(
    runs.flatMap((r) => r.changesPerMinute),
    0.95,
  );
  const crowdOk = crowdedShare <= CROWDED_SHARE && changes <= CHANGES_P95 && v('fightWater') === 0;
  const spawns = sum(runs, (r) => r.spawns);
  const placedFriends = spawns > 0 && friends.length > 0;
  const friendsOk = pct(friends, 0.5) <= FRIENDS_P50_MS && pct(friends, 0.95) <= FRIENDS_P95_MS;
  return [
    zero(1, 'The cap holds', ['cap']),
    zero(2, 'No hidden interactable creature that shares water', ['hidden']),
    gate3,
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
    {
      n: 9,
      name: `Bandwidth: upload at 24 links within ${UPLOAD_24_KBPS} KB/s, each link within ${LINK_KBPS} KB/s`,
      // A dense crowd's links are all P1, at 10 Hz by rule: its upload is reported, not asserted (M12).
      ok: up.link <= LINK_KBPS && (dense || up.max24 === null || up.max24 <= UPLOAD_24_KBPS),
      detail: `${
        up.max24 === null || up.mean24 === null
          ? 'never 24 links'
          : `at 24 links ${kb(up.max24)} at most, ${kb(up.mean24)} on average${dense ? ' (not asserted)' : ''}`
      }; one link ${kb(up.link)} at most`,
    },
    {
      n: 10,
      name: `Crowds: at most ${CROWDED_SHARE * 100}% of client-seconds crowded after a client's first 10 s, ${CHANGES_P95} instance change a client-minute (p95), fights keep their water`,
      ok: !instanced || crowdOk,
      detail: instanced
        ? `${(100 * crowdedShare).toFixed(2)}% crowded, ${changes.toFixed(2)} changes a client-minute (p95), ${v('fightWater')} fight-water violations${
            v('fightWater') === 0 ? '' : `: ${examples(runs, ['fightWater'])}`
          }`
        : `n/a: instances off (${(100 * crowdedShare).toFixed(1)}% crowded)`,
    },
    {
      n: 11,
      name: 'Spawns: every placed spawn keeps its clearance; a placed friend is linked within 3 s (median), 5 s (p95)',
      ok: v('clearance') === 0 && (!placedFriends || friendsOk),
      detail:
        spawns === 0
          ? 'n/a'
          : `${spawns} placed (${sum(runs, (r) => r.spawnFallbacks)} at the centre), ${v('clearance')} clearance violations${
              v('clearance') === 0 ? '' : `: ${examples(runs, ['clearance'])}`
            }; ${
              placedFriends
                ? `friends median ${(pct(friends, 0.5) / 1000).toFixed(2)} s, p95 ${(pct(friends, 0.95) / 1000).toFixed(2)} s`
                : 'no friends'
            }`,
    },
  ];
}
