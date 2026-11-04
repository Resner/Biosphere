// The netcode report (M8 T13): `npm run report:net` writes `docs/perf/netcode.md` from the jitter
// and loss harness (`tests/net-harness.ts`): two clients and the scripted referee over every cell
// of a grid of latency, jitter, loss and clock error. The harness is seeded, so the report is
// deterministic and its hash is pinned per rules version by `net-report.test.ts`.

import { Hasher } from '../src/sim/hash';
import { RULES_VERSION } from '../src/sim/rules';
import { type HarnessResult, runHarness } from '../tests/net-harness';

export const GRID = {
  oneWayMs: [20, 80, 150, 250],
  jitterMs: [0, 30, 60],
  loss: [0, 0.02, 0.05],
  clockErrMs: [0, 20, 60],
} as const;

/** The harness seed of every cell. */
export const SEED = 'netcode';

/** Fighters (and clients) in a grid cell. */
export const CLIENTS = 2;

export interface Cell {
  oneWayMs: number;
  jitterMs: number;
  loss: number;
  clockErrMs: number;
  result: HarnessResult;
}

/** Every cell of the grid, in the order of the report's rows. */
export function measure(): Cell[] {
  const cells: Cell[] = [];
  for (const oneWayMs of GRID.oneWayMs) {
    for (const jitterMs of GRID.jitterMs) {
      for (const loss of GRID.loss) {
        for (const clockErrMs of GRID.clockErrMs) {
          const link = { oneWayMs, jitterMs, loss, clockErrMs };
          const result = runHarness({ seed: SEED, clients: CLIENTS, link });
          cells.push({ ...link, result });
        }
      }
    }
  }
  return cells;
}

/** The share of own inputs the referee took in time, over every client of a run. */
export function onTimeShare(r: HarnessResult): number {
  const sent = r.clients.reduce((n, c) => n + c.sent, 0);
  const onTime = r.clients.reduce((n, c) => n + c.onTime, 0);
  return sent === 0 ? 1 : onTime / sent;
}

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

/** The report's text without its closing hash line. */
export function reportBody(cells: Cell[]): string {
  const rows = cells.map(({ oneWayMs, jitterMs, loss, clockErrMs, result: r }) => {
    const perSecond = r.clients.reduce((n, c) => n + c.rollbacks, 0) / r.clients.length / r.seconds;
    const deepest = Math.max(...r.clients.map((c) => c.longestRollback));
    const resyncs = r.clients.reduce((n, c) => n + c.resyncs, 0);
    return `| ${oneWayMs} | ${jitterMs} | ${pct(loss)} | ${clockErrMs} | ${pct(onTimeShare(r))} | ${perSecond.toFixed(2)} | ${deepest} | ${resyncs} | ${r.converged ? 'yes' : '**NO**'} |`;
  });
  return [
    '# Netcode report',
    '',
    `Written by \`npm run report:net\` (\`tools/net-report.ts\`); rules v${RULES_VERSION}. ${CLIENTS} \`EncounterSync\` clients play a whole fight through the scripted referee (\`tests/net-harness.ts\`), each with seeded scripted inputs, over a link with the one-way latency and jitter below. A loss is a delay spike of 200-600 ms that holds the messages behind it. Each client's estimate of the hub clock is off by the clock error, one early and one late.`,
    '',
    '| One way (ms) | Jitter (ms) | Loss | Clock error (ms) | Own inputs on time | Rollbacks / s | Deepest rollback (frames) | Resyncs | Same hash as the referee |',
    '|---|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

/** A 64-bit hash of the report body, pinned per rules version by the test. */
export const reportHash = (body: string): string => new Hasher().str(body).digest();

/** The full text of `docs/perf/netcode.md`. */
export function netReport(cells: Cell[] = measure()): string {
  const body = reportBody(cells);
  return `${body}\nReport hash: \`${reportHash(body)}\` (rules v${RULES_VERSION}).\n`;
}
