// The storage report (M9 T10, ADR 0056): what the authority stores per player-hour and per fight,
// measured from the rows hub tests write (`worker/storage.test.ts`), and the steady state and
// yearly growth that follow at 5, 50 and 200 concurrent players. Pure: `tools/storage.mjs` runs the
// measuring test and hands its numbers here.
import { FREE } from '../worker/plan';

/** What `worker/storage.test.ts` measures, as bytes. */
export interface StorageMeasure {
  /** A hatch: the player, its genesis record, commitment and creature. */
  hatchBytes: number;
  /** An hour of ordinary play after the hatch (progress every 30 s, then a close). */
  hourBytes: number;
  perKind: { kind: string; count: number; bytes: number }[];
  commitment: { count: number; bytes: number };
  beaconBytes: number;
  fight: {
    frames: number;
    /** The fight's row with its log, settlement included. */
    keptBytes: number;
    settlementBytes: number;
    /** The row after pruning. */
    prunedBytes: number;
  };
  /** A fight's witness commitment (a full pool of 16, kept 14 days) and its auditor's attestation (kept for good). */
  witness: { commitBytes: number; attestBytes: number };
}

/** The window the logs are kept (`LOG_KEEP_DAYS` in `worker/fight-store.ts`). */
export const KEEP_DAYS = 14;
/** Fights a player is in each hour of play: ADR 0056's "a few times an hour". */
export const FIGHTS_PER_PLAYER_HOUR = 3;
/** The fight the model stores: a 30 s duel of two (300 frames of 100 ms). */
export const DUEL_FRAMES = 300;
export const CONCURRENT = [5, 50, 200] as const;
/** The free plan's SQLite storage per Durable Object (`worker/plan.ts`, ADR 0067). */
export const LIMIT_BYTES = FREE.storageBytes;
/** The steady state the logs must stay under, or the window shrinks (ADR 0056). */
export const LOG_STEADY_LIMIT_BYTES = 1_000_000_000;

const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
const mb = (n: number) => `${(n / 1_000_000).toFixed(0)} MB`;
const gb = (n: number) => `${(n / 1_000_000_000).toFixed(1)} GB`;

/** Packed characters of `frames` duel frames: two 4-byte codes each, base64 (`worker/fight-pack.ts`). */
export const packedChars = (frames: number): number => Math.ceil((frames * 8) / 3) * 4;

const snap100 = (n: number) => Math.round(n / 100) * 100;

/** The measurement with every size rounded to 100 bytes, so a few bytes of run-to-run difference (ids, times) never show. */
export function snapped(m: StorageMeasure): StorageMeasure {
  return {
    ...m,
    hatchBytes: snap100(m.hatchBytes),
    hourBytes: snap100(m.hourBytes),
    perKind: m.perKind.map((k) => ({ ...k, bytes: snap100(k.bytes) })),
    commitment: { ...m.commitment, bytes: snap100(m.commitment.bytes) },
    beaconBytes: snap100(m.beaconBytes),
    fight: {
      ...m.fight,
      keptBytes: snap100(m.fight.keptBytes),
      settlementBytes: snap100(m.fight.settlementBytes),
      prunedBytes: snap100(m.fight.prunedBytes),
    },
    witness: {
      commitBytes: snap100(m.witness.commitBytes),
      attestBytes: snap100(m.witness.attestBytes),
    },
  };
}

/** The model's numbers for `players` concurrent players around the clock. */
export function model(m: StorageMeasure, players: number) {
  // The row of a duel's log: the measured fixed part (start, genomes, fighters) plus its frames.
  const fixed = m.fight.keptBytes - m.fight.settlementBytes - packedChars(m.fight.frames);
  const logBytes = fixed + packedChars(DUEL_FRAMES);
  const fightsPerHour = (players * FIGHTS_PER_PLAYER_HOUR) / 2;
  // A witnessed fight also keeps its witness commitment for the window ...
  const logsSteady = fightsPerHour * 24 * KEEP_DAYS * (logBytes + m.witness.commitBytes);
  const recordsYear = players * m.hourBytes * 24 * 365;
  // ... and its attestation for good, beside the settlement.
  const settledYear = fightsPerHour * 24 * 365 * (m.fight.prunedBytes + m.witness.attestBytes);
  const growthYear = recordsYear + settledYear;
  const perDay = growthYear / 365;
  return {
    logBytes,
    fightsPerHour,
    logsSteady,
    growthYear,
    daysToLimit: Math.round((LIMIT_BYTES - logsSteady) / perDay / 10) * 10,
  };
}

/** `docs/perf/storage.md` for the measurements. */
export function storageReport(measured: StorageMeasure): string {
  const m = snapped(measured);
  const out: string[] = [
    '# Storage report',
    '',
    'Reproduce with `npm run report:storage`. Bytes are column sizes of the rows a hub test writes',
    '(`worker/storage.test.ts`), rounded to 100 bytes; SQLite pages and indexes add some on top.',
    'ADR 0056 sets the retention these numbers check: the history for good, fight logs for',
    `${KEEP_DAYS} days, a free-tier limit of ${gb(LIMIT_BYTES)}.`,
    '',
    '## What a player writes',
    '',
    '| Event | Stored |',
    '|---|---|',
    `| A hatch | ${kb(snap100(m.hatchBytes))} |`,
    `| An hour of ordinary play (progress every 30 s, then a close) | ${kb(snap100(m.hourBytes))} |`,
    `| A beacon (shared by everyone) | ${snap100(m.beaconBytes)} B |`,
    `| A commitment | ${snap100(m.commitment.bytes / Math.max(1, m.commitment.count))} B |`,
    '',
    'The guard in `worker/storage.test.ts` keeps a hatch and an hour under 10 KB per player.',
    '',
    '## Per record kind',
    '',
    'From one hub history (two hatches, a mating, two promotions, a fight, a restore).',
    '',
    '| Kind | Records | Average |',
    '|---|---|---|',
    ...m.perKind.map(
      (k) => `| ${k.kind} | ${k.count} | ${snap100(k.bytes / Math.max(1, k.count))} B |`,
    ),
    '',
    '## Per fight',
    '',
    '| | Stored |',
    '|---|---|',
    `| The settlement (kept for good) | ${kb(snap100(m.fight.settlementBytes))} |`,
    `| A kept row, a ${DUEL_FRAMES / 10} s duel | ${kb(snap100(model(m, 1).logBytes + m.fight.settlementBytes))} |`,
    `| The log alone, a ${DUEL_FRAMES / 10} s duel (guard: under 8 KB) | ${kb(snap100(model(m, 1).logBytes))} |`,
    `| The row after pruning (guard: under 2 KB) | ${kb(snap100(m.fight.prunedBytes))} |`,
    `| A witness commitment, a pool of 16 (kept ${KEEP_DAYS} days) | ${kb(m.witness.commitBytes)} |`,
    `| An attestation (kept for good) | ${kb(m.witness.attestBytes)} |`,
    '',
    '## Steady state and growth',
    '',
    `Players around the clock, each in ${FIGHTS_PER_PLAYER_HOUR} fights an hour, every fight a ${DUEL_FRAMES / 10} s duel with a witness commitment and an attestation.`,
    `Hours of play are charged at the measured ordinary hour; the history never shrinks.`,
    '',
    '| Concurrent players | Logs and witness commitments kept (steady state) | History growth a year | Days to the limit |',
    '|---|---|---|---|',
    ...CONCURRENT.map((n) => {
      const r = model(m, n);
      return `| ${n} | ${mb(r.logsSteady)} | ${gb(r.growthYear)} | ${r.daysToLimit} |`;
    }),
    '',
  ];
  const worst = model(m, 200);
  out.push(
    worst.logsSteady <= LOG_STEADY_LIMIT_BYTES
      ? `The steady state of logs and witness commitments at 200 players (${mb(worst.logsSteady)}) is under ${gb(LOG_STEADY_LIMIT_BYTES)}, so the ${KEEP_DAYS}-day window stands.`
      : `The steady state of logs and witness commitments at 200 players (${mb(worst.logsSteady)}) is over ${gb(LOG_STEADY_LIMIT_BYTES)}: shorten \`LOG_KEEP_DAYS\` (never below 7) and record it in ADR 0056.`,
    '',
    `At 200 players around the clock the history alone reaches the free plan's limit in about ${worst.daysToLimit} days. The free plan does not serve 200 around the clock, though:`,
    "`docs/CAPACITY.md` gives how long each plan's store lasts at its full daily allowance, and weighs checkpoint compaction (ADR 0056) against the paid plan.",
    '',
  );
  return out.join('\n');
}
