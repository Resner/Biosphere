import { describe, expect, it } from 'vitest';
import { commitmentId } from '../src/ledger/genesis';
import { POOL_MAX } from '../src/ledger/witness-doc';
import {
  LOG_STEADY_LIMIT_BYTES,
  model,
  packedChars,
  type StorageMeasure,
} from '../tools/storage-report';
import { advance, authority, hatched, join, useFightHub } from './fight-test-kit';
import { history } from './history-kit';
import { ask, CALM, closeSockets, nextOf, publish, report, sql } from './test-hub';
import { DAY_MS } from './usage';
import {
  attestAuditor,
  byPlayer,
  orderOf,
  useWitnessHub,
  waitFor,
  witnessCommit,
  witnesses,
} from './witness-test-kit';

// M9 T10 (ADR 0056): what the authority stores, measured from the rows hub tests write. The guards
// bound an hour of ordinary play and a fight's log; the measurements, printed as one
// `STORAGE_MEASURE` line, are what `npm run report:storage` turns into `docs/perf/storage.md`.

useFightHub();
useWitnessHub();

const HOUR_MS = 3_600_000;
const TICKS_PER_30S = 900;

/** Per-player data: a beacon is shared by everyone, a key or the migrations belong to the object. */
const TABLES = ['players', 'creatures', 'records', 'commitments', 'matings', 'flags', 'encounters'];

interface Column extends Record<string, SqlStorageValue> {
  name: string;
  type: string;
}

/** The bytes the rows of `table` hold (text and blobs by length, numbers as 8), optionally `where`. */
async function bytesOf(table: string, where = '1', ...bind: SqlStorageValue[]): Promise<number> {
  const columns = await sql<Column>(`SELECT name, type FROM pragma_table_info('${table}')`);
  const sum = columns
    .map((c) =>
      c.type === 'TEXT' || c.type === 'BLOB' ? `IFNULL(length(CAST(${c.name} AS BLOB)), 0)` : '8',
    )
    .join(' + ');
  const [row] = await sql<{ n: number | null }>(
    `SELECT SUM(${sum}) AS n FROM ${table} WHERE ${where}`,
    ...bind,
  );
  return row?.n ?? 0;
}

const storedBytes = async () => {
  let n = 0;
  for (const table of TABLES) n += await bytesOf(table);
  return n;
};

/** A new player's hatch, then an hour of progress reports every 30 s and a close: what each stores. */
async function playHour() {
  const start = await storedBytes();
  const p = await hatched();
  const before = await storedBytes();
  let ticks = 0;
  for (let i = 0; i < 120; i++) {
    await advance(30_000);
    ticks += TICKS_PER_30S;
    report(p.c, ticks, { ...CALM, biomass: 10_000 + i });
    await nextOf(p.c, 'ack');
  }
  p.c.ws.close(1000, 'bye');
  await p.c.closed;
  await sql('SELECT 1');
  const after = await storedBytes();
  return { hatch: before - start, hour: after - before };
}

/** A full pool's witness commitment and an auditor's attestation, as one genesis writes them (M10 T14). */
async function witnessRows() {
  const ws = await witnesses(POOL_MAX);
  const p = await join();
  const { commit } = await ask(p.c, p.id);
  const event = `genesis:${commitmentId(commit.commitment)}`;
  const wc = await waitFor(() => witnessCommit(event), 'the witness commitment');
  const order = orderOf(wc, wc.id);
  expect(order).toHaveLength(POOL_MAX);
  await publish(commit.commitment.round);
  await nextOf(p.c, 'genesis');
  const auditor = byPlayer(ws, order[0]);
  expect(await attestAuditor(auditor, event, wc.id)).toBe('done');
  const commitBytes = await bytesOf('commitments', 'kind = ?', 'witness');
  const attestBytes = await bytesOf('attestations');
  await closeSockets();
  // The pool's 16 ids are most of it: 16 × 44 characters, and the countersigned envelope.
  expect(commitBytes).toBeGreaterThan(16 * 44);
  expect(commitBytes).toBeLessThan(2 * 1024);
  expect(attestBytes).toBeLessThan(1024);
  return { commitBytes, attestBytes };
}

describe('what the authority stores', () => {
  it('keeps an hour of ordinary play under 10 KB a player', async () => {
    const { hatch, hour } = await playHour();
    expect(hatch + hour).toBeLessThan(10 * 1024);
  });

  it('measures the rows it writes', async () => {
    const { hatch, hour } = await playHour();
    const h = await history();

    const kinds = await sql<{ kind: string; n: number }>(
      'SELECT kind, COUNT(*) AS n FROM records GROUP BY kind ORDER BY kind',
    );
    const perKind = [];
    for (const { kind, n } of kinds) {
      perKind.push({ kind, count: n, bytes: await bytesOf('records', 'kind = ?', kind) });
    }
    const commitments = await sql<{ n: number }>('SELECT COUNT(*) AS n FROM commitments');
    const [fight] = await sql<{ frames: number; joins: number }>(
      'SELECT persisted AS frames, length(joins) AS joins FROM encounters WHERE id = ?',
      h.enc,
    );
    const log = await bytesOf('encounters', 'id = ?', h.enc);
    const settlement = (
      await sql<{ n: number }>('SELECT length(settlement) AS n FROM encounters WHERE id = ?', h.enc)
    )[0]?.n;
    await authority((o) => o.fightStore.prune(Date.now() + 15 * DAY_MS));
    const pruned = await bytesOf('encounters', 'id = ?', h.enc);
    const [beacon] = await sql<{ n: number }>(
      'SELECT AVG(length(signature) + 8) AS n FROM beacons',
    );
    await closeSockets();

    expect(pruned).toBeLessThan(2 * 1024);
    // The fight's log is packed: 4 bytes a code, a third more as base64.
    expect(log - (settlement ?? 0)).toBeLessThan(8 * 1024);
    // ... and a 30 s duel (300 frames of two codes) stays under it with the fixed part around them.
    expect(
      log - (settlement ?? 0) - packedChars(fight?.frames ?? 0) + packedChars(300),
    ).toBeLessThan(8 * 1024);
    const measure = {
      hatchBytes: hatch,
      hourBytes: hour,
      perKind,
      commitment: {
        count: commitments[0]?.n ?? 0,
        bytes: await bytesOf('commitments'),
      },
      beaconBytes: Math.round(beacon?.n ?? 0),
      fight: {
        frames: fight?.frames ?? 0,
        keptBytes: log,
        settlementBytes: settlement ?? 0,
        prunedBytes: pruned,
      },
      hourMs: HOUR_MS,
    };
    const full: StorageMeasure = { ...measure, witness: await witnessRows() };
    // Logs and witness commitments together stay under the steady-state limit at 200 players.
    expect(model(full, 200).logsSteady).toBeLessThan(LOG_STEADY_LIMIT_BYTES);
    console.log(`STORAGE_MEASURE ${JSON.stringify(full)}`);
  });
});
