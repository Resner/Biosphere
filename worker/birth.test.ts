import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GENOME_TEXT_LENGTH,
  GENOME_TEXT_LENGTH_V1,
  genomeFromBase64url,
  genomeToBase64url,
} from '../src/genome/codec';
import { genesisGenomeV5 } from '../src/genome/genesis-v5';
import { type Beacon, roundTime } from '../src/ledger/drand';
import { commitmentId } from '../src/ledger/genesis';
import type { Identity } from '../src/ledger/identity';
import { checkBirth, type MateAsk, signMateAsk } from '../src/ledger/mating';
import { recordHash } from '../src/ledger/record';
import type { Born, HubMsg } from '../src/net/protocol';
import { seedFromString } from '../src/sim/prng';
import { RULES_VERSION } from '../src/sim/rules';
import {
  CALM,
  type Client,
  closeSockets,
  freshNonce,
  hatch,
  login,
  nextOf,
  publish,
  report,
  rowsWritten,
  source,
  sql,
  stub,
  useFakeBeacons,
} from './test-hub';

// M5 T8: the committed round arrives; both children are written and delivered, once.

const TICKS_PER_S = 30;
let wall = 0;
const advance = (ms: number) => {
  wall += ms;
};

beforeEach(async () => {
  wall = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => wall);
  await useFakeBeacons();
  await runInDurableObject(stub(), (authority) => {
    const e = (authority as unknown as { env: Record<string, string | undefined> }).env;
    e.DRAND_SOURCE = 'fixture';
    e.MATING_SCALE = '0.01';
  });
  await sql('DELETE FROM matings');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await runInDurableObject(stub(), (authority) => {
    const e = (authority as unknown as { env: Record<string, string | undefined> }).env;
    e.DRAND_SOURCE = undefined;
    e.MATING_SCALE = undefined;
  });
  await closeSockets();
});

interface Player {
  c: Client;
  id: Identity;
  creature: string;
  ticks: number;
}

async function adult(): Promise<Player> {
  const { c, id } = await login();
  const g = await hatch(c, id);
  const p = { c, id, creature: recordHash(g.record.record), ticks: 0 };
  advance(12_000);
  p.ticks += 12 * TICKS_PER_S;
  report(c, p.ticks, CALM);
  await nextOf(c, 'ack');
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

const check = (b: Born): string[] => {
  const [p0, p1] = b.parents.map((t) => genomeFromBase64url(t));
  if (!p0 || !p1) return ['bad-parent'];
  return checkBirth(b.record.record, b.commit.commitment, b.beacon, [p0, p1], b.mates);
};

const pendingCount = (...ps: Player[]) =>
  sql<{ n: number }>(
    `SELECT COUNT(*) AS n FROM creatures WHERE status = 'pending' AND owner IN (${ps.map(() => '?').join(',')})`,
    ...ps.map((p) => p.id.playerId),
  ).then((r) => r[0]?.n);

describe('birth', () => {
  it('writes both children when the round arrives and delivers a checkable born to each', async () => {
    const [a, b] = [await adult(), await adult()];
    const commit = await mate(a, b);
    const before = await rowsWritten();
    await publish(commit.commitment.round);
    const [ba, bb] = await Promise.all([nextOf(a.c, 'born'), nextOf(b.c, 'born')]);

    expect(await pendingCount(a, b)).toBe(2);
    expect(check(ba)).toEqual([]);
    expect(check(bb)).toEqual([]);
    expect(ba.record.record.owner).toBe(a.id.playerId);
    expect(bb.record.record.owner).toBe(b.id.playerId);
    expect(ba.record.record.body.commit).toBe(commitmentId(commit.commitment));
    expect(ba.record.record.body.generation).toBe(1);
    expect(ba.genome).not.toBe(bb.genome);
    const rows = (await rowsWritten()) - before;
    console.log(`birth rows written: ${rows}`);
    expect(rows).toBeLessThanOrEqual(8);
    const [mating] = await sql<{ resolved: number }>('SELECT resolved FROM matings');
    expect(mating?.resolved).toBe(1);
  });

  it('pads karyotype v1 parents under rules 6 and writes v2 children', async () => {
    const [a, b] = [await adult(), await adult()];
    // Both parents were hatched under rules 5: their stored genomes are v1 texts.
    for (const [i, p] of [a, b].entries()) {
      const v1 = genomeToBase64url(genesisGenomeV5(seedFromString(`v1-parent-${i}`)));
      expect(v1).toHaveLength(GENOME_TEXT_LENGTH_V1);
      await sql('UPDATE creatures SET genome = ? WHERE id = ?', v1, p.creature);
    }
    const commit = await mate(a, b);
    await publish(commit.commitment.round);
    const [ba, bb] = await Promise.all([nextOf(a.c, 'born'), nextOf(b.c, 'born')]);
    for (const born of [ba, bb]) {
      expect(born.parents.map((t) => t.length)).toEqual([
        GENOME_TEXT_LENGTH_V1,
        GENOME_TEXT_LENGTH_V1,
      ]);
      expect(born.genome).toHaveLength(GENOME_TEXT_LENGTH);
      expect(born.record.record).toMatchObject({ rules: RULES_VERSION, body: { karyotype: 2 } });
      expect(check(born)).toEqual([]);
    }
  });

  it('is idempotent: another alarm writes nothing and sends nothing', async () => {
    const [a, b] = [await adult(), await adult()];
    const commit = await mate(a, b);
    await publish(commit.commitment.round);
    await nextOf(a.c, 'born');
    const before = await rowsWritten();
    await publish(commit.commitment.round);
    await runInDurableObject(stub(), (authority) => authority.alarm());
    expect(await rowsWritten()).toBe(before);
    expect(await pendingCount(a, b)).toBe(2);
    expect(a.c.inbox.some((m: HubMsg) => m.t === 'born')).toBe(false);
  });

  it('refuses a new court while either side holds a pending child', async () => {
    const [a, b] = [await adult(), await adult()];
    const commit = await mate(a, b);
    await publish(commit.commitment.round);
    await nextOf(a.c, 'born');
    a.c.send({ t: 'court', ask: askOf(a, b) });
    expect((await nextOf(a.c, 'refused')).reason).toBe('pending');
    await expect(
      sql(
        `INSERT INTO creatures (id, owner, status, seq, hash, genome, active_ms, biomass, energy, health, born_t, generation, cooldown_until_ms)
         VALUES ('x', ?, 'pending', 0, 'x', 'g', 0, 1, 1, 1, 1, 1, 0)`,
        a.id.playerId,
      ),
    ).rejects.toThrow();
  });

  it('delivers the child at the next hello when its owner was away', async () => {
    const [a, b] = [await adult(), await adult()];
    const commit = await mate(a, b);
    a.c.ws.close(1000, 'bye');
    await a.c.closed;
    await publish(commit.commitment.round);
    await nextOf(b.c, 'born');
    const back = await login(a.id);
    const { life } = back;
    expect(life.pending).toBeDefined();
    expect(check({ ...(life.pending as Born) })).toEqual([]);
    expect(life.pending?.record.record.owner).toBe(a.id.playerId);
  });

  it('resolves through the alarm after the object is evicted, and after a drand outage', async () => {
    const [a, b] = [await adult(), await adult()];
    const commit = await mate(a, b);
    const round = commit.commitment.round;
    // The network is down: the round is due but not served.
    const real = source.fetch.bind(source);
    const down = vi.spyOn(source, 'fetch').mockRejectedValue(new Error('down'));
    advance(60_000);
    await publish(round);
    expect(await pendingCount(a, b)).toBe(0);
    down.mockImplementation(real as (r: number | 'latest') => Promise<Beacon>);
    await publish(round);
    await nextOf(a.c, 'born');
    expect(await pendingCount(a, b)).toBe(2);
    expect(roundTime(round)).toBeGreaterThan(0);
  });

  it('resolves after the object is evicted between the commitment and the round', async () => {
    const [a, b] = [await adult(), await adult()];
    const commit = await mate(a, b);
    await evictDurableObject(stub());
    await useFakeBeacons();
    await publish(commit.commitment.round);
    await nextOf(b.c, 'born');
    expect(await pendingCount(a, b)).toBe(2);
  });
});
