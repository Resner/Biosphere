import { describe, expect, it, vi } from 'vitest';
import golden from '../src/ledger/__golden__/settlement.json';
import type { PubKey, StoredRecord } from '../src/ledger/record';
import {
  checkSettledRecords,
  type FightLog,
  frameLeaf,
  merkleRoot,
  type SignedSettlement,
} from '../src/ledger/settlement';
import { verifyEncounter } from '../src/net/encounter-verify';
import type { FighterInfo, HubMsg } from '../src/net/protocol';
import { FRAME_MS } from '../src/net/referee';
import type { Fighter } from '../src/sim/encounter/types';
import { RULES, TICK_HZ } from '../src/sim/rules';

type Body = Fighter['body'];

import {
  advance,
  advanceTo,
  authority,
  clock,
  type EncEnd,
  type EncStart,
  editLife,
  fighters,
  genomeOf,
  join,
  killB,
  lifeOn,
  locked,
  logRow,
  NEAR,
  outcomeOf,
  outOfReach,
  type Player,
  rowsBesideLog,
  startFight,
  startOf,
  useFightHub,
  within,
} from './fight-test-kit';
import { type Client, nextOf, report, sql } from './test-hub';

// M8 T8: the settlement (ADR 0053, ADR 0054): the countersigned document in the fight's row and in
// `enc-end`, the locked time in the records, the carrion at the victim's worth, and a settlement
// that fails leaving every life as the ledger holds it.

useFightHub();

/** Every message the client receives from now on, in order. */
function log(c: Client): HubMsg[] {
  const seen: HubMsg[] = [];
  c.ws.addEventListener('message', (e) => {
    seen.push(JSON.parse(String(e.data)) as HubMsg);
  });
  return seen;
}

const recordsOf = (creature: string) =>
  sql<{ json: string; hash: string; auth_sig: string; key_id: string; owner_sig: string | null }>(
    'SELECT json, hash, auth_sig, key_id, owner_sig FROM records WHERE creature = ? ORDER BY seq',
    creature,
  ).then((rows) =>
    rows.map(
      (r): StoredRecord => ({
        record: JSON.parse(r.json),
        hash: r.hash,
        ownerSig: r.owner_sig,
        authSig: r.auth_sig,
        keyId: r.key_id,
      }),
    ),
  );

const pubkeys = () =>
  authority((o): PubKey[] => o.ledger.pubkeys().map((k) => ({ id: k.id, publicKey: k.publicKey })));

/** The fight's stored settlement and its log, as the row holds them. */
async function stored(enc: string, pondSeed: string) {
  const row = await logRow(enc);
  if (!row?.settlement) throw new Error('no settlement stored');
  const fight: FightLog = { pondSeed, start: row.start, joins: row.joins, frames: row.frames };
  return { row, signed: JSON.parse(row.settlement) as SignedSettlement, log: fight };
}

/** Edits each fighter's body on the authority's copy of the fight A is in (its clients don't see it). */
const bodies = (a: Player, start: EncStart, edit: (body: Body, player: string) => void) =>
  authority((o) => {
    const fight = o.fights.ofPlayer(a.id.playerId)?.fight;
    if (!fight || fight.enc.id !== start.enc) throw new Error('no fight');
    for (const f of fight.enc.fighters) edit(f.body, f.player);
  });

/** Each fighter's life clock as its fight starts. */
const clocks = (ps: Player[]) =>
  Promise.all(ps.map(async (p) => (await lifeOn(p))?.activeMs ?? Number.NaN));

describe('the golden settlement in workerd', () => {
  for (const [name, g] of Object.entries(golden.fights)) {
    it(`${name}: the same root and verdict as in Node`, () => {
      const fight = g as unknown as { log: FightLog; settlement: SignedSettlement };
      const records = (g as unknown as { records: StoredRecord[] }).records;
      expect(merkleRoot(fight.log.frames.map((i, f) => frameLeaf(f, i)))).toBe(
        fight.settlement.settlement.root,
      );
      expect(verifyEncounter(fight.settlement, fight.log, golden.keys as PubKey[])).toEqual([]);
      expect(checkSettledRecords(fight.settlement.settlement, records)).toEqual([]);
    });
  }
});

describe('a kill’s settlement', () => {
  it('is countersigned over the log, stored in the row, sent in `enc-end` and agrees with the records', async () => {
    const [a, b] = await fighters();
    const seenA = log(a.c);
    const rows = await rowsBesideLog();
    const sealed = { rows: 0 };
    await authority((o) => {
      const store = o.fightStore;
      const seal = store.seal.bind(store);
      vi.spyOn(store, 'seal').mockImplementation((...args) => {
        const before = store.rowsWritten;
        try {
          seal(...args);
        } finally {
          sealed.rows += store.rowsWritten - before;
        }
      });
    });
    const { start, end } = await killB(a, b);
    // M7's rows per participant beside the log, and one update of the row for the tail and the
    // document, and the lock's `authority-only` flag (no witness online, M10).
    expect((await rowsBesideLog()) - rows).toBeLessThanOrEqual(6);
    expect(sealed.rows).toBeGreaterThan(0);
    expect(sealed.rows).toBeLessThanOrEqual(3);

    const { row, signed, log: fight } = await stored(start.enc, a.pond.seed);
    expect(row.open).toBe(false);
    expect(verifyEncounter(signed, fight, await pubkeys())).toEqual([]);
    expect(signed.settlement).toMatchObject({ enc: start.enc, frames: end.f, hash: end.hash });
    // `enc-end` carries the very document the row holds.
    const ended = seenA.find((m): m is EncEnd => m.t === 'enc-end');
    expect(ended?.settlement).toEqual(signed);
    expect(end.settlement).toEqual(signed);

    const records = [...(await recordsOf(a.creature)), ...(await recordsOf(b.creature))];
    expect(checkSettledRecords(signed.settlement, records)).toEqual([]);
    // Each result has its record exactly once.
    for (const r of signed.settlement.results) {
      const mine = records.filter((s) => s.record.creature === r.creature);
      expect(mine.filter((s) => s.record.body.enc === start.enc)).toHaveLength(1);
    }
  });

  it('settles once: a second settlement writes nothing and returns the stored document', async () => {
    const [a, b] = await fighters();
    const { start } = await killB(a, b);
    const { signed } = await stored(start.enc, a.pond.seed);
    const again = await authority((o) => {
      const before = o.ledger.rowsWritten;
      const result = o.ledger.settle({
        enc: start.enc,
        fighters: [],
        settlement: signed.settlement,
        log: {
          stored: () => o.fightStore.settlement(start.enc),
          seal: () => {
            throw new Error('sealed twice');
          },
        },
      });
      return { result, rows: o.ledger.rowsWritten - before };
    });
    expect(again.rows).toBe(0);
    expect(again.result).toEqual({ fresh: false, stored: [], settlement: signed });
  });

  it('drops carrion of the victim’s biomass times its worth', async () => {
    const [a, b] = await fighters();
    const spectator = await join();
    const seen = log(spectator.c);
    const genomes = await Promise.all([genomeOf(a), genomeOf(b)]);
    const info = (p: Player, k: number, over: Partial<FighterInfo>): FighterInfo => ({
      player: p.id.playerId,
      creature: p.creature,
      genome: genomes[k] as string,
      x: NEAR[k === 0 ? 'a' : 'b'][0],
      y: NEAR[k === 0 ? 'a' : 'b'][1],
      vx: 0,
      vy: 0,
      heading: 0,
      biomass: RULES.starter.biomass,
      energy: 150,
      health: 100,
      elder: false,
      egg: false,
      worth: 1,
      ...over,
    });
    const msg = startOf(a, [info(a, 0, {}), info(b, 1, { health: 0.01, worth: 0.5 })]);
    const start = await startFight(a, b, msg);
    const { end } = await killB(a, b, start);
    const victim = outcomeOf(end, b);
    const dropped = seen.filter((m) => m.t === 'carrion');
    expect(dropped).toEqual([
      {
        t: 'carrion',
        enc: start.enc,
        x: victim.x,
        y: victim.y,
        biomass: victim.biomass * 0.5,
        radius: Math.sqrt(victim.biomass),
        tick: start.t0 + end.f * RULES.encounter.frameTicks,
      },
    ]);
  });
});

describe('locked time', () => {
  it('credits the fight’s frames to both records, whoever left, and the next report only what follows', async () => {
    const [a, b] = await fighters();
    const start = await outOfReach(a, b);
    const [fromA, fromB] = await clocks([a, b]);
    // Every frame is the autopilot's, and nobody can die of it on the authority's copy.
    await bodies(a, start, (body) => {
      body.health = 1e6;
      body.energy = 1e6;
    });
    await advanceTo(start.at + 100 * FRAME_MS);
    b.c.ws.close(1000, 'gone');
    await b.c.closed;
    // 299 frames in, B starves, so the fight lasts about 30 s, the last 20 s with B away.
    await advanceTo(start.at + 298 * FRAME_MS + RULES.encounter.inputDeadlineMs + 1);
    expect(await locked(a)).toBe(true);
    await bodies(a, start, (body, p) => {
      body.health = p === b.id.playerId ? 0.001 : 50;
      body.energy = p === b.id.playerId ? 0 : 100;
    });
    for (let i = 0; i < 20 && (await locked(a)); i++) await advance(FRAME_MS);
    const end = await within(nextOf(a.c, 'enc-end'), 'enc-end');
    expect(end.f).toBeGreaterThanOrEqual(299);
    expect(end.f).toBeLessThan(310);
    const fought = end.f * FRAME_MS;

    const [recA] = (await recordsOf(a.creature)).filter((s) => s.record.body.enc === start.enc);
    const [recB] = (await recordsOf(b.creature)).filter((s) => s.record.body.enc === start.enc);
    expect(recA?.record.kind).toBe('encounter');
    expect(recA?.record.body.activeMs).toBe((fromA as number) + fought);
    expect(recB?.record.kind).toBe('death');
    expect(recB?.record.body.activeMs).toBe((fromB as number) + fought);
    expect((await lifeOn(a))?.activeMs).toBe((fromA as number) + fought);

    // A's next report, 10 s on, counts ticks from before and through the fight: only the 10 s count.
    await advance(10_000);
    a.ticks += 50 * TICK_HZ;
    a.c.send({
      t: 'progress',
      n: 1,
      ticks: a.ticks,
      biomass: 10_000,
      energy: 5000,
      health: 5000,
    });
    const ack = await nextOf(a.c, 'ack');
    const credited = ack.activeMs - ((fromA as number) + fought);
    expect(credited).toBeGreaterThanOrEqual(10_000);
    expect(credited).toBeLessThanOrEqual(10_000 + RULES.life.accrueSlackMs);
  });

  it('runs on the hub’s clock: the settlement’s `t`, its records’ `t` and the next report’s credit', async () => {
    const [a, b] = await fighters();
    // The hand-moved clock runs an hour ahead of the wall clock from here on.
    const HOUR = 3_600_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock.t - HOUR);
    const { start } = await killB(a, b);
    const { signed } = await stored(start.enc, a.pond.seed);
    expect(signed.settlement.t).toBeGreaterThanOrEqual(start.at);
    expect(signed.settlement.t).toBeLessThanOrEqual(clock.t);
    const [recA] = (await recordsOf(a.creature)).filter((s) => s.record.body.enc === start.enc);
    const recsB = (await recordsOf(b.creature)).filter((s) => s.record.body.enc === start.enc);
    for (const s of [recA, ...recsB]) expect(s?.record.t).toBe(signed.settlement.t);
    const settledMs = (await lifeOn(a))?.activeMs ?? Number.NaN;
    expect(settledMs).toBe(recA?.record.body.activeMs);

    await advance(10_000);
    a.ticks += 10 * TICK_HZ;
    report(a.c, a.ticks, { biomass: 10_000, energy: 5000, health: 5000 });
    expect((await nextOf(a.c, 'ack')).activeMs - settledMs).toBe(10_000);
  });

  it('ends a fighter whose lifespan runs out in the fight with its encounter record, then old age', async () => {
    const [a, b] = await fighters();
    const before = await lifeOn(a);
    // One second of life left as the fight starts.
    await editLife(a, { lifespanMs: (before?.activeMs ?? 0) + 1000 });
    const start = await outOfReach(a, b);
    // Three seconds that nobody can die of on the authority's copy, then B starves.
    await bodies(a, start, (body) => {
      body.health = 1e6;
      body.energy = 1e6;
    });
    await advanceTo(start.at + 30 * FRAME_MS);
    await bodies(a, start, (body, p) => {
      body.health = p === b.id.playerId ? 0.001 : 50;
      body.energy = p === b.id.playerId ? 0 : 100;
    });
    for (let i = 0; i < 20 && (await locked(a)); i++) await advance(FRAME_MS);
    expect(outcomeOf(await nextOf(a.c, 'enc-end'), a).outcome).toBe('stood');
    const died = await within(nextOf(a.c, 'died'), 'died');
    expect(died.cause).toBe('old-age');
    const chain = await recordsOf(a.creature);
    expect(chain.map((s) => s.record.kind)).toEqual(['genesis', 'encounter', 'death']);
    const lifespan = (before?.activeMs ?? 0) + 1000;
    expect(chain[1]?.record.body.activeMs).toBe(lifespan);
    expect(chain[2]?.record.body).toMatchObject({ cause: 'old-age', activeMs: lifespan });
  });
});

describe('a settlement that fails', () => {
  it('writes nothing, flags once, and sends each fighter `enc-end` then its life as the ledger holds it', async () => {
    const [a, b] = await fighters();
    const [seenA, seenB] = [log(a.c), log(b.c)];
    // The last write of the transaction fails, so the records written before it roll back.
    await authority((o) => {
      vi.spyOn(o.fightStore, 'seal').mockImplementation(() => {
        throw new Error('disk full');
      });
    });
    const records = await sql<{ n: number }>('SELECT COUNT(*) AS n FROM records');
    const { start, end } = await killB(a, b);
    await within(Promise.all([nextOf(a.c, 'life'), nextOf(b.c, 'life')]), 'life');
    expect(end.settlement).toBeUndefined();
    expect(await sql<{ n: number }>('SELECT COUNT(*) AS n FROM records')).toEqual(records);
    expect((await recordsOf(b.creature)).map((s) => s.record.kind)).toEqual(['genesis']);
    const row = await logRow(start.enc);
    expect(row?.settlement).toBeNull();
    const flags = await sql(
      'SELECT * FROM flags WHERE kind = ? AND hash = ?',
      'settle-failed',
      start.enc,
    );
    expect(flags).toHaveLength(1);

    for (const [p, seen] of [
      [a, seenA],
      [b, seenB],
    ] as const) {
      const after = seen.filter((m) => m.t === 'enc-end' || m.t === 'life' || m.t === 'died');
      expect(after.map((m) => m.t)).toEqual(['enc-end', 'life']);
      const life = after[1] as Extract<HubMsg, { t: 'life' }>;
      expect(life.life?.creature).toBe(p.creature);
      expect(life.fight).toBeUndefined();
      expect((await lifeOn(p))?.over).toBe(false);
      expect(await locked(p)).toBe(false);
    }
    expect(
      await authority((o) => o.ledger.head(b.creature)?.status),
      'the victim is alive in the ledger',
    ).toBe('active');
    // The clock has moved on, and nothing waits on the fight.
    expect(clock.t).toBeGreaterThan(start.at);
    expect(await authority((o) => o.fights.timers())).toBe(0);
  });
});
