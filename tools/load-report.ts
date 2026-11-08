// The load report (M13 T5): `npm run sim:load` writes `docs/perf/load.md` and `docs/perf/load.json`
// from the headless harness at 10,000 players (`tests/load.ts`): six gates, the fill minute by
// minute, the hub's operations timed in Node, messages by type and what a client sends and receives.
// The harness is seeded, so the report is the same for a seed apart from its Timings section.

import { Meter, MSG_TYPES, type MsgType, OPS, type Op } from '../tests/aoi-meter';
import { pct } from '../tests/aoi-scenarios';
import type { RunResult } from '../tests/aoi-types';
import {
  FULL_LOAD,
  LOAD_CROWDED_SHARE,
  LOAD_JOIN_P95,
  LOAD_MSG_MEAN,
  LOAD_MSG_MEDIAN,
  LOAD_MSG_P95,
  type LoadShape,
  loadGates,
  runLoad,
} from '../tests/load';
import { EDGE_CLEARANCES, FIGHT_MS, LINK_CAP } from '../tests/wave';
import { table } from './aoi-report';

/** The seed of the committed report. */
export const LOAD_SEED = 'report0';

/** One timed hub operation. `perSecond` is its count over the simulated seconds. */
export interface OpMeasure {
  op: Op;
  count: number;
  perSecond: number;
  p50Ms: number;
  p99Ms: number;
}

/** What `docs/perf/load.json` holds. */
export interface LoadMeasure {
  seed: string;
  players: number;
  simulatedSeconds: number;
  /** The pair checks: every `pairsEvery` ticks (100 ms each), on `pairSample` of the clients. */
  pairsEvery: number;
  pairSample: number;
  /** For each minute of the hold: players judged and their messages per minute (median, p95, mean). */
  holdSeries: { minute: number; players: number; median: number; p95: number; mean: number }[];
  gates: { n: number; name: string; ok: boolean; detail: string }[];
  ok: boolean;
  messages: Record<MsgType, number>;
  /** Per player-minute, over the player-minutes of the whole run. */
  messagesPerPlayerMinute: Record<MsgType, number>;
  ops: OpMeasure[];
  heapBytes: number | null;
  heapMembers: number;
  /** KB/s per client, over every client-tick. */
  uploadKBps: { mean: number; max: number };
  downloadKBps: { mean: number; max: number };
  linkSetupsPerPlayerMinute: number;
  /** The share of link setups an offer through a peer carried. */
  relayedShare: number;
  gossipKBps: number;
  wallSeconds: number;
}

const kb = (bytes: number) => bytes / 1000;
const ms = (v: number) => (v < 10 ? v.toFixed(3) : v.toFixed(1));

export function measureOf(
  run: RunResult,
  meter: Meter,
  shape: LoadShape,
  seed: string,
  wallSeconds: number,
): LoadMeasure {
  const gates = loadGates(run);
  const w = run.wave;
  const minutes = Math.max(1, w?.lifeMinutes ?? 1);
  const seconds = shape.holdUntil / 1000;
  const per = (n: number) => n / minutes;
  const ops: OpMeasure[] = OPS.map((op) => ({
    op,
    count: meter.ops[op].length,
    perSecond: meter.ops[op].length / seconds,
    p50Ms: pct(meter.ops[op], 0.5),
    p99Ms: pct(meter.ops[op], 0.99),
  }));
  const samples = Math.max(1, meter.rateSamples);
  return {
    seed,
    players: shape.players,
    simulatedSeconds: seconds,
    pairsEvery: shape.pairsEvery,
    pairSample: shape.pairSample,
    holdSeries: (w?.holdByMinute ?? []).map((counts, k) => ({
      minute: shape.holdFrom / 60_000 + k + 1,
      players: counts.length,
      median: pct(counts, 0.5),
      p95: pct(counts, 0.95),
      mean: counts.reduce((a, b) => a + b, 0) / Math.max(1, counts.length),
    })),
    gates: gates.map((g) => ({ n: g.n, name: g.name, ok: g.ok, detail: g.detail })),
    ok: gates.every((g) => g.ok),
    messages: { ...meter.msgs },
    messagesPerPlayerMinute: Object.fromEntries(
      MSG_TYPES.map((t) => [t, per(meter.msgs[t])]),
    ) as Record<MsgType, number>,
    ops,
    heapBytes: meter.heapBytes,
    heapMembers: meter.heapMembers,
    uploadKBps: { mean: kb(meter.upSum / samples), max: kb(meter.upMax) },
    downloadKBps: { mean: kb(meter.downSum / samples), max: kb(meter.downMax) },
    linkSetupsPerPlayerMinute: per(meter.setups),
    relayedShare: meter.setups === 0 ? 0 : meter.setupsRelayed / meter.setups,
    gossipKBps: run.linkSeconds === 0 ? 0 : run.gossipBytes / 1000 / run.linkSeconds,
    wallSeconds,
  };
}

function holdTable(m: LoadMeasure): string {
  return table([
    ['Minute', 'Players', 'Median', 'p95', 'Mean'],
    ...m.holdSeries.map((r) => [
      String(r.minute),
      String(r.players),
      r.median.toFixed(1),
      r.p95.toFixed(1),
      r.mean.toFixed(1),
    ]),
  ]);
}

function minuteTable(run: RunResult): string {
  const rows = (run.wave?.minutes ?? []).map((m) => [
    String(m.minute),
    String(m.population),
    String(m.groups),
    String(m.crowded),
    String(m.instances),
    String(m.spawns),
    String(m.rides),
    m.population === 0 ? 'n/a' : (m.messages / m.population).toFixed(1),
  ]);
  return table([
    [
      'Minute',
      'Players',
      'Groups',
      'Crowded players',
      'Instances',
      'Spawns',
      'Rides',
      'Messages per player',
    ],
    ...rows,
  ]);
}

const INTRO = (s: LoadShape) => `# Load report

Written by \`npm run sim:load\` (\`tools/load-report.ts\`) from the headless harness (\`tests/aoi-harness.ts\`, ADR 0062) with the hub's \`Directory\`, \`Crowds\` and \`place()\` in the loop, the page's dial rules, and the pure parts' timings taken in Node. There are no sockets and no WebRTC: what a message costs inside the object is measured by M13 T6 and T7.

## The scenario

- **The fill**: ${s.first} players in the first minute, then the rest evenly until minute ${s.fillUntil / 60_000}, each placed by \`place()\`. 90% are starters, 9% T1 and 1% T2, the larger ones restored with an ancestor's size.
- **The hold**: from minute ${s.holdFrom / 60_000} to minute ${s.holdUntil / 60_000}. Each player leaves after an exponential session with a mean of ${s.meanSession / 60_000} minutes and a newcomer replaces each leaver at once, so the world holds ${s.players.toLocaleString('en')} with about ${(s.players / (s.meanSession / 1000)).toFixed(1)} joins a second.
- **Life**: players wander at 40–105 wu/s with dashes, and a player alone for 120 s rides. In each minute of the hold, 1 pair in ${s.playersPerFight} players, comparable and sharing water, fights for ${FIGHT_MS / 1000} s; a fighter that is due to leave leaves when its fight ends.
- **The pair checks** (discovery, hidden threats, views, tier links) run every ${s.pairsEvery / 10} s on ${s.pairSample >= 1 ? 'every client' : `a seeded ${(s.pairSample * 100).toFixed(0)}% of the clients`}.

## Gates

1. **Budget**, in the hold: world messages per player-minute after a player's first minute, median at most ${LOAD_MSG_MEDIAN} and p95 at most ${LOAD_MSG_P95}; in a joiner's first minute p95 at most ${LOAD_JOIN_P95}; the hold's mean, churn included, at most ${LOAD_MSG_MEAN}.
2. **Placement**: no clearance violation, no fall back to the spawn centre, every spawn with a group within the group's reach plus ${EDGE_CLEARANCES} clearances.
3. **Together**: a T0 newcomer with a group is linked to one of its members within 3 s at the median and 5 s at the p95.
4. **Bounded**: never more than ${LINK_CAP} links, and at most ${LOAD_CROWDED_SHARE * 100}% of client-seconds crowded after a client's first 10 s.
5. **No hidden creature**: gate 2 of the area-of-interest report among pairs that share water, as the wave reads it (ADR 0066).
6. **Integrity**: fighters share water and keep their instance through their fights.
`;

/** The full text of \`docs/perf/load.md\`. */
export function loadReport(run: RunResult, m: LoadMeasure, shape: LoadShape): string {
  const gates = table([
    ['Gate', 'Result', 'Detail'],
    ...m.gates.map((g) => [`${g.n}. ${g.name}`, g.ok ? 'pass' : '**FAIL**', g.detail]),
  ]);
  const types = table([
    ['Message', 'Count', 'Per player-minute'],
    ...MSG_TYPES.map((t) => [
      t === 'whereCrowd' ? 'where with a crowd list' : t === 'resend' ? 'signal resend' : t,
      m.messages[t].toLocaleString('en'),
      m.messagesPerPlayerMinute[t].toFixed(2),
    ]),
  ]);
  const metrics = table([
    ['Metric', 'Value'],
    ['Players, simulated seconds', `${m.players.toLocaleString('en')}, ${m.simulatedSeconds}`],
    [
      'Upload per client (mean, most)',
      `${m.uploadKBps.mean.toFixed(1)} KB/s, ${m.uploadKBps.max.toFixed(1)} KB/s`,
    ],
    [
      'Download per client (mean, most)',
      `${m.downloadKBps.mean.toFixed(1)} KB/s, ${m.downloadKBps.max.toFixed(1)} KB/s`,
    ],
    ['Link setups per player-minute', m.linkSetupsPerPlayerMinute.toFixed(2)],
    ['Share of setups through a peer', `${(100 * m.relayedShare).toFixed(1)}%`],
    ['Gossip per link', `${m.gossipKBps.toFixed(3)} KB/s`],
    ['Most links held at once', String(run.maxHeld)],
  ]);
  const ops = table([
    ['Operation', 'Count', 'Per second', 'p50', 'p99'],
    ...m.ops.map((o) => [
      opName(o.op),
      o.count.toLocaleString('en'),
      o.perSecond.toFixed(1),
      `${ms(o.p50Ms)} ms`,
      `${ms(o.p99Ms)} ms`,
    ]),
  ]);
  const heap =
    m.heapBytes === null
      ? 'not measured'
      : `${(m.heapBytes / 1e6).toFixed(1)} MB for a directory of ${m.heapMembers.toLocaleString('en')} members at the start of the hold${
          (globalThis as { gc?: unknown }).gc ? '' : ' (no GC forced: run with `--expose-gc`)'
        }`;
  return `${INTRO(shape)}
## Result

${gates}

${metrics}

## Messages by type

${types}

## The fill, minute by minute

Groups are the groups \`place()\` finds for a T0 newcomer; crowded players and instances are counted at the minute mark; spawns, rides and messages are the minute's. The fill's first minutes cost far more per player than a live world would (18 joins a second into a few thousand players): they are reported, not gated.

${minuteTable(run)}

## The hold, minute by minute

Messages per player-minute of the players past their first minute and in the water through the minute. The world relaxes from the fill through the hold, so the first minutes cost more.

${holdTable(m)}

## Timings (machine-dependent)

The rest of this report is the same for a seed; this section is not.

${ops}

- **Heap**: ${heap}.
- **Wall time**: ${(m.wallSeconds / 60).toFixed(1)} minutes.
`;
}

const opName = (op: Op): string =>
  ({
    where: 'where (directory report, near, crowds report)',
    place: 'place()',
    signal: 'hub-relayed signal (reach check)',
    split: 'crowd split (settle)',
    pool: 'poolOf at a fight start',
  })[op];

/** Runs the load scenario and builds both files' contents. `wall` gives the seconds elapsed. */
export function runLoadReport(
  shape: LoadShape = FULL_LOAD,
  seed = LOAD_SEED,
  wall: () => number = () => 0,
  progress?: (minute: number, players: number) => void,
): { text: string; measure: LoadMeasure } {
  const meter = new Meter();
  const run = runLoad(seed, shape, meter, progress);
  const measure = measureOf(run, meter, shape, seed, wall());
  return { text: loadReport(run, measure, shape), measure };
}
