// The area-of-interest report (M11 T10, ADR 0062): `npm run report:aoi` writes `docs/perf/aoi.md`
// from the headless harness (`tests/aoi-harness.ts`): seven scenarios at normal speed over a few
// seeds each, each judged by the eight gates, with the numbers M13's capacity model reads.
// The harness is seeded, so the report is deterministic.

import { runScenario } from '../tests/aoi-harness';
import {
  FRIENDS_P50_MS,
  FRIENDS_P95_MS,
  type Gate,
  GOSSIP_KBPS,
  gatesOf,
  JOIN_P95,
  MSG_MEDIAN,
  MSG_P95,
  makeScenario,
  pct,
  RELAY_SHARE,
  SCENARIO_NAMES,
  type ScenarioName,
} from '../tests/aoi-scenarios';
import type { RunResult } from '../tests/aoi-types';

/** Seeds per scenario in the report (the long scenarios have fewer). */
export const REPORT_SEEDS: Record<ScenarioName, number> = {
  friends: 10,
  sparse: 3,
  crowd: 3,
  tiers: 3,
  streams: 3,
  traveller: 1,
  witnesses: 3,
};

export function runReportScenario(name: ScenarioName, seeds = REPORT_SEEDS[name]): RunResult[] {
  return Array.from({ length: seeds }, (_, i) =>
    runScenario(makeScenario(name, `report${i}`), `report${i}`),
  );
}

const sum = (runs: RunResult[], f: (r: RunResult) => number) => runs.reduce((s, r) => s + f(r), 0);
const fixed = (v: number, digits = 1) => v.toFixed(digits);
const secs = (ms: number) => fixed(ms / 1000, 2);

/** The links per client from the histogram of (client, tick) samples. */
function linkStats(runs: RunResult[]) {
  const hist = Array.from({ length: 33 }, (_, n) => sum(runs, (r) => r.linkHistogram[n] ?? 0));
  const total = hist.reduce((a, b) => a + b, 0) || 1;
  const mean = hist.reduce((s, c, n) => s + c * n, 0) / total;
  let acc = 0;
  let p95 = 0;
  for (let n = 0; n < hist.length; n++) {
    acc += hist[n] as number;
    if (acc >= 0.95 * total) {
      p95 = n;
      break;
    }
  }
  const max = Math.max(...runs.map((r) => r.maxHeld));
  return { mean, p95, max };
}

function table(rows: string[][]): string {
  const [head, ...body] = rows as [string[], ...string[][]];
  return [
    `| ${head.join(' | ')} |`,
    `|${head.map(() => '---').join('|')}|`,
    ...body.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
}

function section(name: ScenarioName, runs: RunResult[], gates: Gate[]): string {
  const first = runs[0] as RunResult;
  const links = linkStats(runs);
  const disc = runs.flatMap((r) => r.discoveryMs);
  const steady = runs.flatMap((r) => r.perMinute);
  const join = runs.flatMap((r) => r.joinMinute);
  const lateLinks = sum(runs, (r) => r.lateLinks);
  const lateRelayed = sum(runs, (r) => r.lateRelayed);
  const kbps =
    sum(runs, (r) => r.gossipBytes) /
    1000 /
    Math.max(
      1,
      sum(runs, (r) => r.linkSeconds),
    );
  const crowded =
    sum(runs, (r) => r.crowdedSeconds) /
    Math.max(
      1,
      sum(runs, (r) => r.clientSeconds),
    );
  const metrics = table([
    ['Metric', 'Value'],
    ['Runs, clients, simulated seconds', `${runs.length}, ${first.clients}, ${first.seconds}`],
    [
      'Links per client (mean, p95, most held at once)',
      `${fixed(links.mean)}, ${links.p95}, ${links.max}`,
    ],
    [
      'Discovery latency (p50, p95)',
      disc.length === 0 ? 'n/a' : `${secs(pct(disc, 0.5))} s, ${secs(pct(disc, 0.95))} s`,
    ],
    [
      'Authority messages per player-minute (median, p95; first minute p95)',
      steady.length === 0
        ? `n/a (under 2 minutes), ${pct(join, 0.95)}`
        : `${pct(steady, 0.5)}, ${pct(steady, 0.95)}; ${pct(join, 0.95)}`,
    ],
    [
      'Links made after the first minute set up through a peer relay',
      lateLinks === 0 ? 'n/a' : `${fixed((100 * lateRelayed) / lateLinks, 0)}% of ${lateLinks}`,
    ],
    ['Gossip per link', `${fixed(kbps, 3)} KB/s`],
    ['Time crowded (P0 + P1 past 32)', `${fixed(100 * crowded, 1)}%`],
  ]);
  const rows = table([
    ['Gate', 'Result', 'Detail'],
    ...gates.map((g) => [`${g.n}. ${g.name}`, g.ok ? 'pass' : '**FAIL**', g.detail]),
  ]);
  return `### ${name}\n\n${rows}\n\n${metrics}\n`;
}

const INTRO = `# Area-of-interest report

Written by \`npm run report:aoi\` (\`tools/aoi-report.ts\`). Simulated clients each run their own \`AoiManager\`, \`WhereReporter\`, \`Gossip\` and \`SignalRoute\` against one \`Directory\` (\`tests/aoi-harness.ts\`), over a seeded link model: a hop between peers takes 30–80 ms, the hub 50–150 ms each way, ICE 0.5–2 s with 5% of attempts failing and being retried, and the hello a round trip. There are no sockets and no WebRTC. Creatures move by script at 40–105 wu/s with dashes.

How the clients dial is part of the model, and is what the page (M11 T13) must do (ADR 0063): the plan runs every 500 ms and at once when the directory answers or an offer comes in; P0 and P1 are dialled at once through the hub; the rest wait for the lower id to call (1.5 s), go through a peer when its gossip placed the target, else through the hub one at a time; a P4 is dialled only on a fix under 5 s old; an offer carries the caller's class, and \`admit\` judges by it; a refusal is an answer, and backs off a P3 or P4 (5 s, doubling, to 60 s).

## Gates

1. **The cap**: never more than 32 links, nor more than 24 while P0 + P1 ≤ 24.
2. **No hidden interactable creature**: every pair within 8 × the larger radius that can link is linked with its hello done, unless a side is crowded (or has 24 or more P1 within reach) or the pair has been within P1 reach under ${10} s.
3. **Seamless handoffs**: no link closes to a creature in view while the two stay within each other's AoI; every remote that comes into view at a closing speed of at most 100 wu/s has been linked for 0.5 s (not asserted in the two dense scenarios, ${'`crowd`'} and ${'`witnesses`'}: M12).
4. **Friends** (spawn ring): linked within ${FRIENDS_P50_MS / 1000} s at the median and ${FRIENDS_P95_MS / 1000} s at the p95.
5. **Budget**: at most ${MSG_MEDIAN} incoming authority messages per player-minute (median) and ${MSG_P95} (p95) after a creature's first minute, at most ${JOIN_P95} (p95) in it; in \`sparse\` and \`streams\`, at least ${RELAY_SHARE * 100}% of the links made after the first minute through a peer relay. Not asserted in the dense scenarios.
6. **Gossip** costs at most ${GOSSIP_KBPS} KB/s per link.
7. **Tiers**: no link between creatures two tiers apart outside P0 (for more than 4 s); every giant's swarm holds each smaller creature in its AoI that reported in the last 30 s, up to 64.
8. **Witnesses**: every duty link is taken within 10 s and held to the fight's end, with P0 + P1 ≤ 28, and the cap holds.
`;

const NOTES = `## Findings

- A hub-relayed signal carries the sender's directory position, up to 30 s old. A callee that judged the caller's class from it refused calls that were in range; \`admit\` judges by the class the offer carries.
- A giant's AoI (up to about 20,000 wu) is wider than a smaller neighbour's query radius, so the giant called creatures that had no class for it. A creature is now in the AoI of whichever of two creatures sees further (\`AoiManager.classify\`); refusals in \`tiers\` fell from 227 to 24.
- Directory positions are up to 30 s old, so a P4 dialled from one may be out of the callee's range: a P4 needs a fix under 5 s old.
- In a dense crowd (about 20 P1 each) a P1 pair that drifts past the hold and back within a few seconds can come into view before its link is up: about 3 in 1,000 entries. M12 (crowded instances) owns it.
- A relayed offer lost on a peer's closed link costs 4 s before the hub resend, more than a P1's 3 s lead, so P0 and P1 calls go through the hub.
`;

/** The full text of \`docs/perf/aoi.md\`. */
export function aoiReport(results: Record<ScenarioName, RunResult[]>): string {
  const parts = SCENARIO_NAMES.map((name) => {
    const runs = results[name];
    return section(name, runs, gatesOf(runs));
  });
  return `${INTRO}\n## Scenarios\n\n${parts.join('\n')}\n${NOTES}`;
}

export function runAoiReport(): string {
  const results = Object.fromEntries(
    SCENARIO_NAMES.map((name) => [name, runReportScenario(name)]),
  ) as Record<ScenarioName, RunResult[]>;
  return aoiReport(results);
}
