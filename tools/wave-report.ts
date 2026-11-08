// The population wave report (M12 T9): `npm run sim:wave` writes `docs/perf/wave.md` from the
// headless harness (`tests/wave.ts`): 5 players, then 300, then 20 over 24 simulated minutes, judged
// by eight gates, with the minute-by-minute series of the first seed. The harness is seeded, so the
// report is deterministic.

import { pct, sum } from '../tests/aoi-scenarios';
import type { RunResult } from '../tests/aoi-types';
import {
  EDGE_CLEARANCES,
  FIGHT_MS,
  FIGHTS_PER_MINUTE,
  FULL_WAVE,
  LINK_CAP,
  NEWCOMER_P95_MS,
  PEAK_CROWDED_SHARE,
  REGROUPED_SHARE,
  runWave,
  TOGETHER_P50_MS,
  TOGETHER_P95_MS,
  WAVE_MSG_MEAN,
  WAVE_MSG_MEDIAN,
  WAVE_MSG_P95,
  waveGates,
} from '../tests/wave';
import { table } from './aoi-report';

/** Seeds in the report: each is a 24-minute run of 300 players. */
export const WAVE_SEEDS = 2;

const secs = (ms: number) => (ms / 1000).toFixed(2);

/** Messages per player-minute in each simulated minute of one run (all players present, as a mean). */
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

const INTRO = `# Population wave report

Written by \`npm run sim:wave\` (\`tools/wave-report.ts\`) from the headless harness (\`tests/aoi-harness.ts\`, ADR 0062) with the hub's \`Crowds\` and \`place()\` in the loop and the page's dial rules. There are no sockets and no WebRTC, and the wave judges grouping, not cost (M13).

## The wave

- **The wave**: ${FULL_WAVE.first} players join in the first ${FULL_WAVE.firstUntil / 60_000} minutes; ${FULL_WAVE.peak - FULL_WAVE.first} more join over the next ${(FULL_WAVE.fallFrom - FULL_WAVE.firstUntil) / 60_000 - 2} minutes, one every ${FULL_WAVE.joinEvery / 1000} s, each placed by \`place()\`. 10% are T1, restored with a T1 ancestor's size.
- **The fall**: from minute ${FULL_WAVE.fallFrom / 60_000} players leave at random until ${FULL_WAVE.rest} remain, by minute ${FULL_WAVE.fallUntil / 60_000}.
- **The end**: the run lasts ${FULL_WAVE.end / 60_000} minutes.
- Players wander at 40–105 wu/s with dashes; a player alone for 120 s rides the current.
- Every minute from minute ${FULL_WAVE.peakFrom / 60_000} to ${FULL_WAVE.peakUntil / 60_000} (the peak), ${FIGHTS_PER_MINUTE} attackers each engage the nearest comparable player that shares their water, for ${FIGHT_MS / 1000} s.

## Gates

1. **Clearance**: every spawn and ride arrival keeps the clearance from every engage-capable member and every spawn of the last 60 s, lies in the safe depth band, and is never within P1 reach of a member in an instance, by the directory's positions. An arrival that falls back to the spawn centre owes none (the first player of an empty world is placed there).
2. **Together**: a T0 newcomer whose placement found a group is linked to one of its members within ${TOGETHER_P50_MS / 1000} s at the median and ${TOGETHER_P95_MS / 1000} s at the p95; every newcomer within ${NEWCOMER_P95_MS / 1000} s at the p95. A newcomer never linked counts as never.
3. **At the group's edge**: every spawn or ride that found a group lies within the group's reach plus ${EDGE_CLEARANCES} clearances of its centroid (ADR 0066). The group's reach is its radius, counting the spawns of the last minute around it, which are about to be members. A spawn that fell back to the spawn centre fails it.
4. **Regrouped**: from ${FULL_WAVE.regroupAfter / 60_000} minutes after the fall, at least ${REGROUPED_SHARE * 100}% of the player-seconds of players that have a creature they can link with hold a link to one. The worst single second is reported: with 20 players left, a pair that wanders apart is two lone players for as long as a ride waits, 120 s (ADR 0066).
5. **Bounded**: at the peak at most ${PEAK_CROWDED_SHARE * 100}% of client-seconds (after a client's first 10 s) are crowded and no client holds more than ${LINK_CAP} links; no crowd stands from ${FULL_WAVE.crowdsGoneAfter / 60_000} minutes after the fall.
6. **No hidden creature**: gate 2 of the area-of-interest report among pairs that share water. A pair that knows each other only from the directory (no snapshot, gossip or signal fix) is excused for 40 s instead of 10 s: the directory's word is up to one \`where\` interval (30 s) old, and nothing else tells two lone creatures that they have closed (ADR 0066).
7. **Integrity**: no fighter changes instance during its fight; fighters share water; no rider is a fighter or within 120 s of the end of its fight.
8. **Budget**: incoming authority messages (\`where\` reports with crowd lists, \`spawn\`, \`ride\` and hub signals): in the hold (a minute after the last join until the fall begins) at most ${WAVE_MSG_MEDIAN} per player-minute at the median and ${WAVE_MSG_P95} at the p95, for the players in the water through it; over the whole wave a mean of at most ${WAVE_MSG_MEAN}, the Worker's budget of one request-equivalent per player-minute (ADR 0066).
`;

/** The full text of \`docs/perf/wave.md\`. */
export function waveReport(runs: RunResult[]): string {
  const gates = waveGates(runs);
  const rows = table([
    ['Gate', 'Result', 'Detail'],
    ...gates.map((g) => [`${g.n}. ${g.name}`, g.ok ? 'pass' : '**FAIL**', g.detail]),
  ]);
  const arrivals = runs.flatMap((r) => r.wave?.arrivals ?? []);
  const rides = arrivals.filter((a) => a.ride).map((a) => a.linkMs ?? Number.POSITIVE_INFINITY);
  const perMinute = runs.flatMap((r) => r.perMinute);
  const join = runs.flatMap((r) => r.joinMinute);
  const metrics = table([
    ['Metric', 'Value'],
    [
      'Runs, players, simulated seconds',
      `${runs.length}, ${FULL_WAVE.peak}, ${FULL_WAVE.end / 1000}`,
    ],
    [
      'Spawns and rides (spawns at the spawn centre)',
      `${sum(runs, (r) => r.spawns - r.rides)} and ${sum(runs, (r) => r.rides)} (${sum(runs, (r) => r.spawnFallbacks)})`,
    ],
    [
      'Ride to first link (p50, p95)',
      rides.length === 0 ? 'n/a' : `${secs(pct(rides, 0.5))} s, ${secs(pct(rides, 0.95))} s`,
    ],
    [
      'Authority messages per player-minute (median, p95; first minute p95)',
      `${pct(perMinute, 0.5)}, ${pct(perMinute, 0.95)}; ${pct(join, 0.95)}`,
    ],
    ['Most links held at once', String(Math.max(...runs.map((r) => r.maxHeld)))],
  ]);
  const first = runs[0] as RunResult;
  return `${INTRO}
## Result

${rows}

${metrics}

## Minute by minute (seed ${first.seed})

Groups are the groups \`place()\` finds for a T0 newcomer; crowded players and instances are counted at the minute mark; spawns, rides and messages are the minute's.

${minuteTable(first)}
`;
}

export function runWaveReport(): string {
  const runs = Array.from({ length: WAVE_SEEDS }, (_, i) => runWave(`report${i}`));
  return waveReport(runs);
}
