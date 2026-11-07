import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it, vi } from 'vitest';
import type { HubMsg } from '../src/net/protocol';
import { FRAME_MS } from '../src/net/referee';
import { RULES } from '../src/sim/rules';
import { drive, IDLE_CODE } from '../tests/encounter-fixture';
import { worthOf } from './farming';
import {
  advance,
  advanceTo,
  authority,
  CALM_SEED,
  CENTRE,
  clock,
  type EncEnd,
  type EncStart,
  editLife,
  fighters,
  hatched,
  lockIn,
  NEAR,
  outcomeOf,
  type Plan,
  type Player,
  play,
  rehatch,
  seasoned,
  slotOf,
  snap,
  useFightHub,
  within,
} from './fight-test-kit';
import { nextOf, sql } from './test-hub';

// M8 T7 (ADR 0054): a victim's worth as prey, set at lock-in and at a join from the ledger's
// deaths, and the join checks M7 left open (tiers against every fighter still in, and no engage
// at a fighter already out of its fight).

const E = RULES.encounter;
const F = E.farming;
const MIN = 60_000;
const HOUR = 60 * MIN;
type EncJoin = Extract<HubMsg, { t: 'enc-join' }>;

useFightHub();

const hex = () => bytesToHex(crypto.getRandomValues(new Uint8Array(32)));

/** A finished creature of `owner` that lived `ms` of play. */
const played = (owner: string, ms: number, status = 'dead') =>
  sql(
    `INSERT INTO creatures (id, owner, status, seq, hash, genome, active_ms, biomass, energy, health, born_t, died_t)
     VALUES (?, ?, ?, 0, '', '', ?, 0, 0, 0, 0, ?)`,
    hex(),
    owner,
    status,
    ms,
    status === 'dead' ? 0 : null,
  );

/** An identity with a row in `players`, first seen `ago` ms before the hub's now, and `play` ms of play. */
async function identity(ago: number, play: number = F.youngPlayMs): Promise<string> {
  const id = hex();
  await sql(
    'INSERT INTO players (id, first_seen, last_seen) VALUES (?, ?, ?)',
    id,
    clock.t - ago,
    clock.t - ago,
  );
  if (play > 0) await played(id, play);
  return id;
}

/** One of `owner`'s creatures, dead `ago` ms before the hub's now with `cause`, as the ledger stores it. */
async function died(owner: string, cause: string, ago: number): Promise<void> {
  const creature = hex();
  const t = clock.t - ago;
  await sql(
    `INSERT INTO creatures (id, owner, status, seq, hash, genome, active_ms, biomass, energy, health, born_t, died_t)
     VALUES (?, ?, 'dead', 1, ?, '', 0, 10000, 0, 0, ?, ?)`,
    creature,
    owner,
    hex(),
    t - HOUR,
    t,
  );
  await sql(
    `INSERT INTO records (creature, seq, hash, req, kind, owner, t, json, owner_sig, auth_sig, key_id)
     VALUES (?, 1, ?, ?, 'death', ?, ?, ?, NULL, '', '')`,
    creature,
    hex(),
    hex(),
    owner,
    t,
    JSON.stringify({ kind: 'death', body: { cause, activeMs: 0, biomass: 10000 } }),
  );
}

const worth = (player: string) => authority((o) => worthOf(o, player, clock.t));

describe('worthOf', () => {
  it('halves for each kill of the player’s creatures in the last 24 h, at most 6 times', async () => {
    const victim = await identity(HOUR);
    expect(await worth(victim)).toBe(1);
    await died(victim, 'killed', HOUR);
    expect(await worth(victim)).toBe(0.5);
    await died(victim, 'killed', 2 * MIN);
    expect(await worth(victim)).toBe(0.25);
    for (let i = 0; i < 8; i++) await died(victim, 'killed', 3 * MIN + i);
    expect(await worth(victim)).toBe(2 ** -F.maxHalvings);
  });

  it('halves once more until the player has played 20 minutes', async () => {
    const fresh = await identity(10 * MIN, 0);
    expect(await worth(fresh)).toBe(0.5);
    await died(fresh, 'killed', MIN);
    expect(await worth(fresh)).toBe(0.25);
    // At the cap the young halving still counts: 2^-7, the least worth there is.
    for (let i = 0; i < F.maxHalvings + 2; i++) await died(fresh, 'killed', 2 * MIN + i);
    expect(await worth(fresh)).toBe(2 ** -(F.maxHalvings + 1));
  });

  it('is half at 19 min 59 s of play and 1 at 20 min', async () => {
    expect(await worth(await identity(HOUR, F.youngPlayMs - 1_000))).toBe(0.5);
    expect(await worth(await identity(HOUR, F.youngPlayMs))).toBe(1);
  });

  it('is half for an identity first seen two hours ago that never played', async () => {
    expect(await worth(await identity(2 * HOUR, 0))).toBe(0.5);
  });

  it('counts the play of every creature the player had, dead or alive', async () => {
    const id = await identity(HOUR, 0);
    await played(id, F.youngPlayMs / 2);
    expect(await worth(id)).toBe(0.5);
    await played(id, F.youngPlayMs / 2, 'active');
    expect(await worth(id)).toBe(1);
  });

  it('forgets a kill 24 h + 1 ms ago', async () => {
    const victim = await identity(2 * F.windowMs);
    await died(victim, 'killed', F.windowMs + 1);
    expect(await worth(victim)).toBe(1);
    await died(victim, 'killed', F.windowMs - 1);
    expect(await worth(victim)).toBe(0.5);
  });

  it('counts no other cause: toxin, old age, starvation, an eaten egg’s child', async () => {
    const victim = await identity(HOUR);
    for (const cause of ['toxin', 'old-age', 'starved', 'eaten']) await died(victim, cause, MIN);
    expect(await worth(victim)).toBe(1);
    // Another player's kills are not this one's.
    const other = await identity(HOUR);
    await died(other, 'killed', MIN);
    expect(await worth(victim)).toBe(1);
  });

  it('writes no row', async () => {
    const victim = await identity(10 * MIN, 0);
    await died(victim, 'killed', MIN);
    // workerd’s own count, over the two reads (kills, play): no row written.
    const seen = await authority((o) => {
      const sql = o.ctx.storage.sql;
      const exec = sql.exec.bind(sql);
      const cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];
      const spy = vi.spyOn(sql, 'exec').mockImplementation((query, ...bindings) => {
        const cursor = exec(query, ...bindings);
        cursors.push(cursor);
        return cursor;
      });
      const rows = o.ledger.rowsWritten;
      const got = worthOf(o, victim, clock.t);
      spy.mockRestore();
      return {
        got,
        statements: cursors.length,
        written: cursors.reduce((n, c) => n + c.rowsWritten, 0),
        ledger: o.ledger.rowsWritten - rows,
      };
    });
    expect(seen).toEqual({ got: 0.25, statements: 2, written: 0, ledger: 0 });
  });
});

/** A locks B in at 1 hp; A then swims at it with its weapon aimed while B idles, until B dies. */
async function killB(a: Player, b: Player): Promise<{ start: EncStart; end: EncEnd }> {
  const [start] = await lockIn(
    a,
    b,
    snap(b, ...NEAR.b, { health: 0.01 }),
    snap(a, ...NEAR.a, { health: 1 }),
  );
  const target = slotOf(start, b);
  const hunt: Plan = () => [drive(0, 15, { stance: 'aggressive', target }), IDLE_CODE];
  const played = await play(a, b, start, hunt);
  const [end] = played.ends as [EncEnd, EncEnd];
  expect(outcomeOf(end, b)).toMatchObject({ outcome: 'killed', by: slotOf(start, a) });
  return { start, end };
}

const lastReward = (creature: string) =>
  sql<{ json: string }>(
    "SELECT json FROM records WHERE creature = ? AND kind = 'encounter' ORDER BY seq DESC LIMIT 1",
    creature,
  ).then((rows) => JSON.parse(rows[0]?.json ?? '{}').body.reward as number);

const worthIn = (start: { fighters: readonly { player: string; worth: number }[] }, p: Player) =>
  start.fighters.find((f) => f.player === p.id.playerId)?.worth;

describe('worth at lock-in', () => {
  it('`enc-start` carries each side’s worth, and a second kill of the same identity pays half', async () => {
    const [a, b] = await fighters();
    const first = await killB(a, b);
    expect(worthIn(first.start, a)).toBe(1);
    expect(worthIn(first.start, b)).toBe(1);
    const reward1 = await lastReward(a.creature);
    const victim1 = outcomeOf(first.end, b).biomass;
    expect(reward1).toBe(Math.floor(E.reward.share * victim1 * 100));

    // B hatches again, and A kills the new creature from the same layout and snapshots.
    const b2 = await rehatch(b);
    await advance(16_000);
    const second = await killB(a, b2);
    expect(worthIn(second.start, a)).toBe(1);
    expect(worthIn(second.start, b2)).toBe(0.5);
    const victim2 = outcomeOf(second.end, b2).biomass;
    expect(victim2).toBe(victim1);
    const reward2 = await lastReward(a.creature);
    expect(reward2).toBe(Math.floor(E.reward.share * victim2 * 0.5 * 100));
    expect(Math.abs(reward2 - reward1 / 2)).toBeLessThanOrEqual(1);
  });

  it('a young identity starts at half', async () => {
    const [a, b] = await fighters();
    await seasoned(b, 10 * MIN);
    const [start] = await lockIn(a, b);
    expect(worthIn(start, a)).toBe(1);
    expect(worthIn(start, b)).toBe(0.5);
  });
});

/** `n` players whose hatch protection is over, in the calm `timeout` pond. */
async function players(n: number): Promise<Player[]> {
  const out: Player[] = [];
  for (let i = 0; i < n; i++) out.push(await hatched());
  await advance(16_000);
  await sql('UPDATE ponds SET seed = ? WHERE id = ?', CALM_SEED, (out[0] as Player).pond.id);
  for (const p of out) p.pond = { ...p.pond, seed: CALM_SEED };
  return out;
}

/** Gives the player's life a body of `biomass` wu, which its snapshots may then claim. */
const grown = (p: Player, biomass: number) =>
  editLife(p, { biomass: biomass * 100, boundBiomass: biomass * 100, maxBiomass: 2 * biomass });

/** `c` engages `target`, already fighting, as a body of `biomass` wu at (x, y). */
function engageInto(
  c: Player,
  target: Player,
  at: readonly [number, number],
  biomass: number,
  targetBiomass: number,
) {
  c.c.send({
    t: 'engage',
    target: target.id.playerId,
    mine: snap(c, at[0], at[1], { biomass, health: 0.5, energy: 0.5 }),
    theirs: snap(target, ...NEAR.b, { biomass: targetBiomass }),
  });
}

describe('joins', () => {
  // Tiers by biomass: T0 below 1,024, T1 below 16,384, T2 below 262,144.
  const T1 = 2_000;
  const T2 = 20_000;

  it('a joiner two tiers from a fighter still in is refused `engage:tier`; one within ±1 of all joins, with its worth', async () => {
    const [a, b, c, d] = (await players(4)) as [Player, Player, Player, Player];
    await grown(b, T1);
    await grown(c, T2);
    await grown(d, T1);
    await seasoned(d, 10 * MIN);
    // A (T0) and B (T1) fight.
    const [start] = await lockIn(a, b, snap(b, ...NEAR.b, { biomass: T1 }));
    expect(start.fighters).toHaveLength(2);
    // C (T2) is within a tier of B, its target, but two from A.
    engageInto(c, b, [CENTRE + 100, CENTRE], T2, T1);
    expect((await within(nextOf(c.c, 'refused'), 'C’s refusal')).reason).toBe('engage:tier');
    expect(await authority((o) => o.fights.playerLocked(c.id.playerId))).toBe(false);
    // D (T1) is within a tier of both, and joins at its own worth (a young identity).
    engageInto(d, b, [CENTRE + 40, CENTRE], T1, T1);
    const join: EncJoin = await within(nextOf(a.c, 'enc-join'), 'D’s join');
    expect(join.fighter.player).toBe(d.id.playerId);
    expect(join.fighter.worth).toBe(0.5);
  });

  it('an engage at a fighter already out of its running fight is refused `engage:locked`', async () => {
    const [a, b, c, d] = (await players(4)) as [Player, Player, Player, Player];
    const [start] = await lockIn(a, b);
    // C joins, so the fight runs on after one of its three is out.
    c.c.send({
      t: 'engage',
      target: a.id.playerId,
      mine: snap(c, CENTRE, CENTRE + 12, { health: 0.5, energy: 0.5 }),
      theirs: snap(a, ...NEAR.a),
    });
    const join = await within(nextOf(a.c, 'enc-join'), 'C’s join');
    // The fight runs past C's join frame.
    await advanceTo(start.at + (join.f + 1) * FRAME_MS + E.inputDeadlineMs + 1);
    // B escaped (marked on the authority's encounter: an escape from a three-fighter fight takes 3 s of swimming).
    await authority((o) => {
      const fight = o.fights.ofPlayer(b.id.playerId)?.fight;
      const fb = fight?.enc.fighters.find((f) => f.player === b.id.playerId);
      if (!fight || !fb) throw new Error('B is not fighting');
      expect(fight.enc.over).toBe(false);
      fb.status = 'escaped';
    });
    d.c.send({
      t: 'engage',
      target: b.id.playerId,
      mine: snap(d, CENTRE + 24, CENTRE, { health: 0.5, energy: 0.5 }),
      theirs: snap(b, ...NEAR.b),
    });
    expect((await within(nextOf(d.c, 'refused'), 'D’s refusal')).reason).toBe('engage:locked');
    // ... and so is B's own engage of D: an escaped fighter pulls nobody into its fight.
    b.c.send({
      t: 'engage',
      target: d.id.playerId,
      mine: snap(b, ...NEAR.b),
      theirs: snap(d, CENTRE + 24, CENTRE, { health: 0.5, energy: 0.5 }),
    });
    expect((await within(nextOf(b.c, 'refused'), 'B’s refusal')).reason).toBe('engage:locked');
    expect(await authority((o) => o.fights.playerLocked(d.id.playerId))).toBe(false);
  });
});
