// The area-of-interest report (M11 T10, ADR 0062): `npm run report:aoi` writes `docs/perf/aoi.md`
// from the headless harness (`tests/aoi-harness.ts`): seven scenarios at normal speed over a few
// seeds each, each judged by the nine gates, with the numbers M13's capacity model reads.
// The harness is seeded, so the report is deterministic.

import { FRAME_OVERHEAD_BYTES, runScenario } from '../tests/aoi-harness';
import {
  CHANGES_P95,
  CROWDED_SHARE,
  FRIENDS_P50_MS,
  FRIENDS_P95_MS,
  type Gate,
  GOSSIP_KBPS,
  gatesOf,
  JOIN_P95,
  LATE_PER_1000,
  LINK_KBPS,
  MSG_MEDIAN,
  MSG_P95,
  makeScenario,
  pct,
  RELAY_SHARE,
  SCENARIO_NAMES,
  type ScenarioName,
  type ScenarioOptions,
  sum,
  UPLOAD_24_KBPS,
  uploadOf,
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
  throng: 3,
};

function runReportScenario(
  name: ScenarioName,
  seeds = REPORT_SEEDS[name],
  opts: ScenarioOptions = {},
): RunResult[] {
  return Array.from({ length: seeds }, (_, i) =>
    runScenario(makeScenario(name, `report${i}`, opts), `report${i}`),
  );
}

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
  const up = uploadOf(runs);
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
    [
      'Upload on the wire at 24 links (most, mean); on one link at most',
      `${up.max24 === null || up.mean24 === null ? 'n/a' : `${fixed(up.max24)} KB/s, ${fixed(up.mean24)} KB/s`}; ${fixed(up.link, 2)} KB/s`,
    ],
    ['Time crowded (P0 + P1 past 32)', `${fixed(100 * crowded, 1)}%`],
    ...(first.instances
      ? [
          [
            'Time crowded after a client\'s first 10 s; instance changes per client-minute (p95)',
            `${fixed((100 * sum(runs, (r) => r.crowdedLate)) / Math.max(1, sum(runs, (r) => r.clientLate)), 2)}%; ${fixed(
              pct(
                runs.flatMap((r) => r.changesPerMinute),
                0.95,
              ),
              2,
            )}`,
          ],
        ]
      : []),
    ...(sum(runs, (r) => r.spawns) > 0
      ? [
          [
            'Placed spawns and rides (at the centre)',
            `${sum(runs, (r) => r.spawns)} and ${sum(runs, (r) => r.rides)} (${sum(runs, (r) => r.spawnFallbacks)})`,
          ],
        ]
      : []),
  ]);
  const rows = table([
    ['Gate', 'Result', 'Detail'],
    ...gates.map((g) => [`${g.n}. ${g.name}`, g.ok ? 'pass' : '**FAIL**', g.detail]),
  ]);
  return `### ${name}\n\n${rows}\n\n${metrics}\n`;
}

const CROWD_GRACE_S = 10;

const INTRO = `# Area-of-interest report

Written by \`npm run report:aoi\` (\`tools/aoi-report.ts\`). Simulated clients each run their own \`AoiManager\`, \`WhereReporter\`, \`Gossip\` and \`SignalRoute\` against one \`Directory\` (\`tests/aoi-harness.ts\`), over a seeded link model: a hop between peers takes 30–80 ms, the hub 50–150 ms each way, ICE 0.5–2 s with 5% of attempts failing and being retried, and the hello a round trip. There are no sockets and no WebRTC. Creatures move by script at 40–105 wu/s with dashes.

How the clients dial is part of the model, and is what the page (M11 T13) must do (ADR 0063): the plan runs every 500 ms and at once when the directory answers or an offer comes in; P0 and P1 are dialled at once through the hub; the rest wait for the lower id to call (1.5 s), go through a peer when its gossip placed the target, else through the hub one at a time; a P4 is dialled only on a fix under 5 s old; an offer carries the caller's class, and \`admit\` judges by it; a refusal is an answer, and backs off a P3 or P4 (5 s, doubling, to 60 s).

## Gates

1. **The cap**: never more than 32 links, nor more than 24 while P0 + P1 ≤ 24.
2. **No hidden interactable creature**: every pair that shares water, within 8 × the larger radius, that can link is linked with its hello done, unless a side is crowded (or has 24 or more P1 within reach), changed instance in the last 10 s, or the pair has been within P1 reach (sharing water) under 10 s.
3. **Seamless handoffs**: no link closes to a creature in view while the two stay within each other's AoI; every remote that comes into view at a closing speed of at most 100 wu/s has been linked for 0.5 s. Pairs that stop sharing water are excused, and in the three dense scenarios (\`crowd\`, \`witnesses\`, \`throng\`) at most ${LATE_PER_1000} late entries in 1,000 are allowed.
4. **Friends** (spawn ring): linked within ${FRIENDS_P50_MS / 1000} s at the median and ${FRIENDS_P95_MS / 1000} s at the p95.
5. **Budget**: at most ${MSG_MEDIAN} incoming authority messages per player-minute (median) and ${MSG_P95} (p95) after a creature's first minute, at most ${JOIN_P95} (p95) in it; in \`sparse\` and \`streams\`, at least ${RELAY_SHARE * 100}% of the links made after the first minute through a peer relay. Not asserted in the dense scenarios.
6. **Gossip** costs at most ${GOSSIP_KBPS} KB/s per link.
7. **Tiers**: no link between creatures two tiers apart outside P0 (for more than 4 s); every giant's swarm holds each smaller creature in its AoI that reported in the last 30 s, up to 64.
8. **Witnesses**: every duty link is taken within 10 s and held to the fight's end, with P0 + P1 ≤ 28, and the cap holds.
9. **Bandwidth** (M11 T15): snapshots go at the rate each receiver asks (10 Hz for P0, P1 or within 1.15 × its view's half-diagonal, 5 Hz in its AoI, 2 Hz for P3, 1 Hz for P4), an engage candidate's signed frame every 200 ms, plus gossip, each frame counted on the wire with ${FRAME_OVERHEAD_BYTES} bytes of IPv4, UDP, DTLS and SCTP. A client's upload at 24 links is at most ${UPLOAD_24_KBPS} KB/s, and one link's at most ${LINK_KBPS} KB/s. The upload is not asserted in the dense scenarios, where every link is P1 and at 10 Hz by rule.
10. **Crowds** (M12 T8, ADR 0064): clients run the page's crowd rules against the hub's \`Crowds\` (\`worker/crowds.ts\`): a client whose wanted P0 + P1 that share its water reach 24 sends its crowd list in its \`where\`; the hub tells each member whose instance changed (after the hub's latency); a link that no longer shares water closes at once unless it is a duty link; each client keeps the freshest word of every creature's instance; a page asks the directory again when its own instance changes. After a client's first ${CROWD_GRACE_S} s at most ${CROWDED_SHARE * 100}% of client-seconds are crowded (P0 + P1 past 32), at most ${CHANGES_P95} instance change per client-minute at the 95th percentile (the first instance a client joins is its entry, not a change), and a fight's fighters, picked as an engage picks them (the nearest comparable creature that shares water), share water and keep their instance for the whole fight. Judged only when instances are on.
11. **Spawns** (M12 T8): clients that enter the water by \`place()\` over the directory's positions keep the clearance from every engage-capable member (tier gap within the rules' limit) by those positions, except a placement that falls back to the spawn centre; and the friends of the \`friends\` scenario, placed so, are linked within ${FRIENDS_P50_MS / 1000} s (median) and ${FRIENDS_P95_MS / 1000} s (p95). A ride (a client alone 120 s that the directory names no one for, the hub places around the best group) is a placement too; it is switched on per scenario, and no scenario here rides.
`;

const NOTES = `## Findings

- Crowd instances (M12 T8): \`throng\` (80 comparable starters hatching within 5 s in a room 1,500 wu wide) is crowded about 94% of the time without instances and about 1% with them. The first split forms 3 instances of about 27 from the members within the first reporter's P1 reach; the rest join the least-full, and the next crowded report (10 s later at the earliest) re-bins them into 5 of 16, so half the members change instance once more. Until the instances settle, a page still counts the creatures it knew in the open water as sharing its water: the directory's answer holds only the 48 nearest that share it, so a creature absent from it keeps its old word (instance 0, shared with everyone). A page asks the directory again after its own instance changes (\`WhereReporter.refresh\`), which brought the crowded share from about 4% to 1%.

- A hub-relayed signal carries the sender's directory position, up to 30 s old. A callee that judged the caller's class from it refused calls that were in range; \`admit\` judges by the class the offer carries.
- A giant's AoI (up to about 20,000 wu) is wider than a smaller neighbour's query radius, so the giant called creatures that had no class for it. A creature is now in the AoI of whichever of two creatures sees further (\`AoiManager.classify\`); refusals in \`tiers\` fell from 227 to 24.
- Directory positions are up to 30 s old, so a P4 dialled from one may be out of the callee's range: a P4 needs a fix under 5 s old.
- In a dense crowd (about 20 P1 each) a P1 pair that drifts past the hold and back within a few seconds can come into view before its link is up: about 3 in 1,000 entries. M12 (crowded instances) owns it.
- A relayed offer lost on a peer's closed link costs 4 s before the hub resend, more than a P1's 3 s lead, so P0 and P1 calls go through the hub.
- Most of a snapshot's cost on the wire is its carriage: 93 bytes of headers for 29 bytes of snapshot. At 10 Hz to all 24 links a client would upload about 29 KB/s; at the asked rates the open-world scenarios average about 6 KB/s at 24 links and peak near 10.5. In a dense crowd every link is P1 and asks 10 Hz, and most are engage candidates with signed frames, so 24 links cost 20 to 32 KB/s: M12's instances bound it.
`;

/** The full text of \`docs/perf/aoi.md\`. */
export function aoiReport(
  results: Record<ScenarioName, RunResult[]>,
  without?: RunResult[],
): string {
  const parts = SCENARIO_NAMES.map((name) => {
    const runs = results[name];
    return section(name, runs, gatesOf(runs));
  });
  // The same throng with no instances, which shows the scenario crowds (gates 1 to 9 as they stand).
  const compare = without
    ? `\n### throng without instances (comparison)\n\n${section('throng', without, gatesOf(without)).replace(/^### throng\n\n/, '')}`
    : '';
  return `${INTRO}\n## Scenarios\n\n${parts.join('\n')}${compare}\n${NOTES}`;
}

export function runAoiReport(): string {
  const results = Object.fromEntries(
    SCENARIO_NAMES.map((name) => [name, runReportScenario(name)]),
  ) as Record<ScenarioName, RunResult[]>;
  return aoiReport(results, runReportScenario('throng', 1, { instances: false }));
}
