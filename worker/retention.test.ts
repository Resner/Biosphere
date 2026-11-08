import { exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseFightProof, parseProofBundle } from '../src/ledger/proof';
import { verifyLineage } from '../src/ledger/verify';
import { LOG_KEEP_DAYS, PRUNE_PER_SETTLEMENT } from './fight-store';
import { advance, authority, fighters, killB, setEnv, useFightHub } from './fight-test-kit';
import { sql } from './test-hub';

// M9 T10 (ADR 0056): fight logs are kept `LOG_KEEP_DAYS` days, each settlement prunes a few expired
// ones, and a pruned row keeps what a proof needs.

useFightHub();

// Earlier tests' fights would count among the expired ones.
beforeEach(() => sql('DELETE FROM encounters'));

const DAY = 86_400_000;
const get = (path: string) =>
  exports.default.fetch(`https://authority.test${path}`, {
    headers: { Origin: 'https://resner.github.io' },
  });

interface RowSize extends Record<string, SqlStorageValue> {
  id: string;
  bytes: number;
  start: string;
}

/** Every row's id, stored size and whether it still holds its log, oldest first. */
const rows = () =>
  sql<RowSize>(
    `SELECT id, length(start) + length(joins) + length(frames) + length(fighters) + length(settlement)
       + length(pond) + length(id) AS bytes, start
     FROM encounters ORDER BY t, id`,
  );

/** A settled fight on a new pair of players; its creature and encounter. */
async function duel() {
  const [a, b] = await fighters();
  const { start } = await killB(a, b);
  return { enc: start.enc, creature: a.creature };
}

describe('fight log retention', () => {
  it('packs a duel’s log under 8 KB, and a pruned row stays under 2 KB', async () => {
    await setEnv(true);
    const first = await duel();
    const [kept] = await rows();
    // frames + joins + start + fighters: the log's own bytes, without the countersigned document.
    const [log] = await sql<{ n: number }>(
      'SELECT length(frames) AS n FROM encounters WHERE id = ?',
      first.enc,
    );
    expect(log?.n).toBeGreaterThan(0);
    expect(log?.n).toBeLessThan(8 * 1024);
    expect(kept?.start).not.toBe('');

    await advance((LOG_KEEP_DAYS + 1) * DAY);
    const second = await duel();

    const after = await rows();
    const old = after.find((r) => r.id === first.enc);
    expect(old?.start).toBe('');
    expect(old?.bytes).toBeLessThan(2 * 1024);
    // The younger fight keeps its log.
    expect(after.find((r) => r.id === second.enc)?.start).not.toBe('');
  });

  it('serves a pruned fight with log null, and its creature’s bundle still verifies, counting it', async () => {
    await setEnv(true);
    const first = await duel();
    await advance((LOG_KEEP_DAYS + 1) * DAY);
    await duel();

    const fight = parseFightProof(await (await get(`/v1/fight/${first.enc}`)).text());
    expect(fight?.log).toBeNull();
    expect(fight?.settlement.settlement.enc).toBe(first.enc);

    const bundle = parseProofBundle(await (await get(`/v1/proof/${first.creature}`)).text());
    if (!bundle) throw new Error('the bundle does not parse');
    const report = verifyLineage(bundle, {
      keys: bundle.keys,
      logs: new Map([[first.enc, null]]),
      replay: () => [],
    });
    expect(report.problems).toEqual([]);
    expect(report.fights.pruned).toBe(1);
  });

  it('prunes at most four expired logs a settlement, the oldest first, and none younger', async () => {
    await setEnv(true);
    const first = await duel();
    const [kept] = await sql<{ t: number }>('SELECT t FROM encounters WHERE id = ?', first.enc);
    const t0 = kept?.t ?? 0;
    // Six more settled rows, copied from the first: five a day apart (all expired after 20 days),
    // one made young.
    const ids = Array.from(
      { length: 6 },
      (_, i) => `${String(i).padStart(2, '0')}${'e'.repeat(62)}`,
    );
    for (const [i, id] of ids.entries()) {
      await sql(
        `INSERT INTO encounters (id, pond, start, joins, frames, persisted, fighters, open, t, settlement)
         SELECT ?, pond, start, joins, frames, persisted, fighters, 0, ?, settlement FROM encounters WHERE id = ?`,
        id,
        i < 5 ? t0 + i * DAY : t0 + 19 * DAY,
        first.enc,
      );
    }
    await advance(20 * DAY);
    const already = new Set((await rows()).filter((r) => r.start === '').map((r) => r.id));
    await duel();

    // Seven expired rows (the first, five copies) and one young copy: four go, the oldest.
    const pruned = (await rows())
      .filter((r) => r.start === '' && !already.has(r.id))
      .map((r) => r.id);
    expect(pruned).toHaveLength(PRUNE_PER_SETTLEMENT);
    expect(new Set(pruned)).toEqual(new Set([first.enc, ids[0], ids[1], ids[2]]));
    expect((await rows()).find((r) => r.id === ids[5])?.start).not.toBe('');

    // The next settlement prunes the rest that expired, and still not the young copy.
    await duel();
    const left = (await rows()).filter((r) => r.start !== '').map((r) => r.id);
    expect(left).not.toContain(ids[3]);
    expect(left).not.toContain(ids[4]);
    expect(left).toContain(ids[5]);
  });

  it('writes the database size to the usage row and shows it in the audit', async () => {
    await authority((o) => o.usage.flush(Date.now()));
    const res = await get('/v1/audit');
    const body = (await res.json()) as { storage: { bytes: number; limit: number } };
    const day = new Date(Date.now()).toISOString().slice(0, 10);
    const [row] = await sql<{ db_bytes: number }>('SELECT db_bytes FROM usage WHERE day = ?', day);
    expect(row?.db_bytes).toBeGreaterThan(0);
    expect(body.storage).toEqual({ bytes: row?.db_bytes, limit: 1_000_000_000 });
  });
});
