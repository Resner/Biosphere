import { describe, expect, it } from 'vitest';
import { commitmentId } from '../src/ledger/genesis';
import { type MateAsk, signMateAsk } from '../src/ledger/mating';
import { poolOf, witnessRound } from '../src/ledger/witness';
import type { BeaconSource } from './beacons';
import {
  advance,
  authority,
  fighters,
  join,
  lockIn,
  type Player,
  rehatch,
  rowsBesideLog,
  setEnv,
  useFightHub,
} from './fight-test-kit';
import { ask, CALM, freshNonce, nextOf, report, source, sql } from './test-hub';
import { commitWitnesses } from './witness-pool';
import { setAvail, useWitnessHub, witnessCommit, witnesses } from './witness-test-kit';

// M10 T4: each fight, mating and genesis commits its pool of witnesses to a future round
// (ADR 0058); with nobody eligible it writes none and is flagged `authority-only` once.

useFightHub();
useWitnessHub();

const ids = (ps: readonly { id: { playerId: string } }[]) => ps.map((p) => p.id.playerId).sort();
const count = async (table: string, where = 'true', ...b: string[]) =>
  (await sql<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, ...b))[0]?.n ?? 0;
const authorityOnly = (event: string) =>
  count('flags', "kind = 'authority-only' AND hash = ?", event);
const beaconRows = () => authority((o) => o.beacons.rowsWritten);

/** The event's witness commitment, once the object has written it. */
async function committed(event: string) {
  for (let i = 0; i < 50; i++) {
    const found = await witnessCommit(event);
    if (found) return found;
  }
  throw new Error(`no witness commitment for ${event}`);
}

describe('witness commitments', () => {
  it('commits a lock’s pool to witnessRound(t) once enc-start went out, and writes nothing else', async () => {
    const [a, b] = await fighters();
    const ws = await witnesses(3);
    const fetches = { n: 0 };
    const counting: BeaconSource = {
      now: () => source.now(),
      fetch: (round) => {
        fetches.n++;
        return source.fetch(round);
      },
    };
    await authority((o) => {
      (o as unknown as { source: BeaconSource }).source = counting;
    });
    const rows = await rowsBesideLog();
    const commits = await count('commitments');
    const beacons = await beaconRows();
    const [start] = await lockIn(a, b);
    const event = `enc:${start.enc}`;
    const commit = await committed(event);
    expect(commit.commitment).toMatchObject({
      kind: 'witness',
      owner: '',
      round: witnessRound(commit.commitment.t),
      data: { event, pool: ids(ws) },
    });
    expect(commit.status).toBe('awaiting');
    expect(commit.id).toBe(commitmentId(commit.commitment));
    // One commitment row (with its two index entries), no beacon fetched, nothing in the ledger.
    expect(await count('commitments')).toBe(commits + 1);
    expect((await beaconRows()) - beacons).toBe(3);
    expect(fetches.n).toBe(0);
    expect(await rowsBesideLog()).toBe(rows);
    expect(await authorityOnly(event)).toBe(0);
    // Asked again, the event keeps its one commitment.
    const again = await authority((o) =>
      commitWitnesses(o, 'enc', start.enc, [a.id.playerId, b.id.playerId]),
    );
    expect(again?.id).toBe(commit.id);
    expect(await count('commitments')).toBe(commits + 1);
  });

  it('writes no commitment for an empty pool, and flags the event authority-only once', async () => {
    const [a, b] = await fighters();
    const commits = await count('commitments');
    const rows = await rowsBesideLog();
    const [start] = await lockIn(a, b);
    const event = `enc:${start.enc}`;
    for (let i = 0; i < 50 && (await authorityOnly(event)) === 0; i++);
    expect(await authorityOnly(event)).toBe(1);
    expect(await witnessCommit(event)).toBeNull();
    expect(await count('commitments')).toBe(commits);
    // The flag is the lock's one row beside its log.
    expect((await rowsBesideLog()) - rows).toBe(1);
    await authority((o) => commitWitnesses(o, 'enc', start.enc, [a.id.playerId]));
    expect(await authorityOnly(event)).toBe(1);
  });

  it('pools the 16 that poolOf picks of 40 eligible sessions', async () => {
    const [a, b] = await fighters();
    const ws = await witnesses(40);
    const [start] = await lockIn(a, b);
    const event = `enc:${start.enc}`;
    const commit = await committed(event);
    const pool = (commit.commitment.data as { pool: string[] }).pool;
    expect(pool).toHaveLength(16);
    expect(pool).toEqual(poolOf(ids(ws), event));
  });

  it('commits a genesis’s pool on the genesis’s own round, without its player', async () => {
    const ws = await witnesses(2);
    const p = await join();
    // Even available and played, the hatching player never witnesses its own genesis.
    await sql(
      `INSERT INTO creatures (id, owner, status, seq, hash, genome, active_ms, biomass, energy, health, born_t, died_t)
       VALUES (?, ?, 'dead', 0, '', '', 1200000, 0, 0, 0, 0, 0)`,
      'f'.repeat(64),
      p.id.playerId,
    );
    await setAvail(p.c, true);
    const commits = await count('commitments');
    const { commit } = await ask(p.c, p.id);
    const id = commitmentId(commit.commitment);
    const witnessed = await committed(`genesis:${id}`);
    expect(witnessed.commitment.round).toBe(commit.commitment.round);
    expect(witnessed.commitment.data).toEqual({ event: `genesis:${id}`, pool: ids(ws) });
    expect(await count('commitments')).toBe(commits + 2);
    await sql('DELETE FROM creatures WHERE id = ?', 'f'.repeat(64));
  });

  it('commits a mating’s pool on the mating’s own round, without either mate', async () => {
    await setEnv(true);
    const [a, b] = [await adult(), await adult()];
    const ws = await witnesses(2);
    const commits = await count('commitments');
    const commit = await mate(a, b);
    const id = commitmentId(commit.commitment);
    const witnessed = await committed(`mating:${id}`);
    expect(witnessed.commitment.round).toBe(commit.commitment.round);
    expect(witnessed.commitment.data).toEqual({ event: `mating:${id}`, pool: ids(ws) });
    expect(await count('commitments')).toBe(commits + 2);
    expect(ids(ws)).not.toContain(a.id.playerId);
  });
});

/** A hatched player, grown up under `MATING_SCALE`. */
async function adult(): Promise<Player> {
  const j = await join();
  const p = await rehatch(j);
  await advance(12_000);
  report(p.c, 12 * 30, CALM);
  await nextOf(p.c, 'ack');
  return p;
}

const askOf = (from: Player, to: Player, nonce = freshNonce()): MateAsk =>
  signMateAsk(from.id, {
    creature: from.creature,
    partner: to.id.playerId,
    partnerCreature: to.creature,
    nonce,
  });

async function mate(a: Player, b: Player) {
  const askA = askOf(a, b);
  a.c.send({ t: 'court', ask: askA });
  await nextOf(b.c, 'invite');
  b.c.send({ t: 'accept', ask: askOf(b, a, askA.nonce) });
  const [ma] = await Promise.all([nextOf(a.c, 'mating'), nextOf(b.c, 'mating')]);
  return ma.commit;
}
