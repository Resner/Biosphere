// The netcode report (M8 T13): `npm run report:net` writes `docs/perf/netcode.md` from the jitter
// and loss harness (`tests/net-harness.ts`): two clients and the scripted referee over every cell
// of a grid of latency, jitter, loss and clock error, then a witness phase (M10 T3) over a grid of
// the fighter-to-witness link and the witness's clock error. The harness is seeded, so the report
// is deterministic and its hash is pinned per rules version by `net-report.test.ts`.

import { Hasher } from '../src/sim/hash';
import { RULES_VERSION } from '../src/sim/rules';
import { type HarnessResult, runHarness, type WitnessPhase } from '../tests/net-harness';

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

/** The witness rows (M10 T3): the fighter-to-witness link each way and the witness's error on the hub clock. */
export const WITNESS_GRID = {
  oneWayMs: [20, 80, 150],
  jitterMs: [0, 30],
  clockErrMs: [-20, 20],
} as const;

/** The witness rows' seed, calm scripts and spans: a long duel, a witness from frame 33 and a planned take-back at 300. */
export const WITNESS_SEED = 'witness-19';
export const WITNESS_FROM = 33;
export const WITNESS_UNTIL = 300;
/** The witness rows' hub link: one way 80 ms with the row's jitter, no loss, each fighter's clock 20 ms off. */
export const WITNESS_HUB = { oneWayMs: 80, loss: 0, clockErrMs: 20 } as const;

export interface WitnessCell {
  phase: WitnessPhase;
  result: HarnessResult;
}

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

/** Every witness row, in the order of the report. */
export function measureWitness(): WitnessCell[] {
  const cells: WitnessCell[] = [];
  for (const oneWayMs of WITNESS_GRID.oneWayMs) {
    for (const jitterMs of WITNESS_GRID.jitterMs) {
      for (const clockErrMs of WITNESS_GRID.clockErrMs) {
        const phase = { from: WITNESS_FROM, until: WITNESS_UNTIL, oneWayMs, jitterMs, clockErrMs };
        const result = runHarness({
          seed: WITNESS_SEED,
          clients: CLIENTS,
          calm: true,
          link: { ...WITNESS_HUB, jitterMs },
          witness: phase,
        });
        cells.push({ phase, result });
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

const rollbacksPerSecond = (r: HarnessResult): string =>
  (r.clients.reduce((n, c) => n + c.rollbacks, 0) / r.clients.length / r.seconds).toFixed(2);
const deepest = (r: HarnessResult): number => Math.max(...r.clients.map((c) => c.longestRollback));
const sum = (r: HarnessResult, k: 'resyncs' | 'overruled' | 'disputes'): number =>
  r.clients.reduce((n, c) => n + c[k], 0);
const same = (r: HarnessResult): string => (r.converged ? 'yes' : '**NO**');
const signed = (ms: number): string => (ms > 0 ? `+${ms}` : `${ms}`);

/** The report's text without its closing hash line. */
export function reportBody(cells: Cell[], witness: WitnessCell[]): string {
  const rows = cells.map(({ oneWayMs, jitterMs, loss, clockErrMs, result: r }) => {
    return `| ${oneWayMs} | ${jitterMs} | ${pct(loss)} | ${clockErrMs} | ${pct(onTimeShare(r))} | ${rollbacksPerSecond(r)} | ${deepest(r)} | ${sum(r, 'resyncs')} | ${same(r)} |`;
  });
  const witnessRows = witness.map(({ phase: p, result: r }) => {
    return `| ${p.oneWayMs} | ${p.jitterMs} | ${signed(p.clockErrMs)} | ${r.witness?.frames ?? 0} | ${pct(onTimeShare(r))} | ${rollbacksPerSecond(r)} | ${deepest(r)} | ${sum(r, 'resyncs')} | ${sum(r, 'overruled')} | ${same(r)} |`;
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
    '## A witness referees',
    '',
    `A witness referees frames ${WITNESS_FROM} to ${WITNESS_UNTIL - 1} of a calm duel (seed \`${WITNESS_SEED}\`, throttle at most 1 and no dash, so the fight runs long), and the authority takes it back at frame ${WITNESS_UNTIL}, announced 3 frames ahead (ADR 0058). Each fighter sends its inputs for the witness's frames to the witness over its own link (one way and jitter below) and takes its frames from it, leading by that link's latency; the hub's link is ${WITNESS_HUB.oneWayMs} ms one way with the same jitter and no loss, and each fighter's hub clock is ${WITNESS_HUB.clockErrMs} ms off, one early and one late. The witness's own estimate of the hub clock is off by its clock error (negative is early). Inputs on time count, at each frame's referee, the inputs it took for it. Overruled counts the authority's frames that differed from a witness's.`,
    '',
    '| Witness one way (ms) | Jitter (ms) | Witness clock error (ms) | Witnessed frames | Own inputs on time | Rollbacks / s | Deepest rollback (frames) | Resyncs | Overruled | Same hash as the referee |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...witnessRows,
    '',
  ].join('\n');
}

/** A 64-bit hash of the report body, pinned per rules version by the test. */
export const reportHash = (body: string): string => new Hasher().str(body).digest();

/** The full text of `docs/perf/netcode.md`. */
export function netReport(
  cells: Cell[] = measure(),
  witness: WitnessCell[] = measureWitness(),
): string {
  const body = reportBody(cells, witness);
  return `${body}\nReport hash: \`${reportHash(body)}\` (rules v${RULES_VERSION}).\n`;
}
