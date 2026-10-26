import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { genomeFromBase64url } from '../src/genome/codec';
import { express } from '../src/genome/express';
import { speciesName } from '../src/genome/names';
import { starterGenome } from '../src/genome/starter';
import { recordHash } from '../src/ledger/record';
import { HISTORY_MAX, type HubMsg, parseHubMsg } from '../src/net/protocol';
import { lifespanMs } from '../src/sim/life';
import { createRng, seedFromString } from '../src/sim/prng';
import { RULES, TICK_HZ } from '../src/sim/rules';
import { applyReport, bindLife, type LifeState, unsaved } from './life';
import {
  CALM,
  type Client,
  closeSockets,
  flush,
  hatch,
  login,
  nextOf,
  report,
  sql,
  stub,
  useFakeBeacons,
} from './test-hub';

/** The hub reads the wall clock from `Date.now`, so a test moves it by hand. */
let wall = 0;
const advance = (ms: number) => {
  wall += ms;
};

beforeEach(async () => {
  wall = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => wall);
  await useFakeBeacons();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await setEnv({});
  await closeSockets();
});

/** Sets the object's scale variables (undefined removes one). */
const setEnv = (vars: { DRAND_SOURCE?: string; LIFESPAN_SCALE?: string }) =>
  runInDurableObject(stub(), (authority) => {
    const env = (authority as unknown as { env: Record<string, string | undefined> }).env;
    env.LIFESPAN_SCALE = vars.LIFESPAN_SCALE;
    env.DRAND_SOURCE = vars.DRAND_SOURCE;
  });

const ticksFor = (ms: number) => Math.ceil((ms * TICK_HZ) / 1000);

async function newPlayer() {
  const { c, id } = await login();
  const g = await hatch(c, id);
  const genome = genomeFromBase64url(g.genome);
  if (!genome) throw new Error('genome');
  const lifespan = Math.round(lifespanMs(express(genome).physiology.lifespan));
  return { c, id, genome, creature: recordHash(g.record.record), lifespan };
}

const chain = (creature: string) =>
  sql<{ seq: number; kind: string; json: string }>(
    'SELECT seq, kind, json FROM records WHERE creature = ? ORDER BY seq',
    creature,
  );
const status = async (creature: string) =>
  (await sql<{ status: string }>('SELECT status FROM creatures WHERE id = ?', creature))[0]?.status;

/** Plays `ms` of wall time and ticks in one report. */
async function playFor(c: Client, ms: number, ticks = ticksFor(ms)) {
  advance(ms);
  report(c, ticks);
}

describe('old age', () => {
  it('ends the creature when progress reaches its lifespan, clamped to it', async () => {
    const { c, id, creature, lifespan } = await newPlayer();
    // Ten minutes beyond the lifespan in one report: the clock stops at the lifespan.
    await playFor(c, lifespan + 600_000);
    const ack = await nextOf(c, 'ack');
    expect(ack).toMatchObject({ activeMs: lifespan });
    const died = await nextOf(c, 'died');
    expect(died.cause).toBe('old-age');
    expect(died.record.record).toMatchObject({
      kind: 'death',
      creature,
      owner: id.playerId,
      body: { cause: 'old-age', activeMs: lifespan },
    });

    // A checkpoint of the last condition comes first, then the death record.
    const records = await chain(creature);
    expect(records.map((r) => r.kind)).toEqual(['genesis', 'checkpoint', 'death']);
    expect(JSON.parse(records[1]?.json ?? '{}').body).toMatchObject({ ...CALM });
    expect(JSON.parse(records[2]?.json ?? '{}').prev).toBe(
      recordHash(JSON.parse(records[1]?.json ?? '{}')),
    );
    expect(await status(creature)).toBe('dead');

    // No more progress for it.
    advance(30_000);
    report(c, ticksFor(lifespan + 700_000));
    const after = await flush(c);
    expect(after).toContainEqual({ t: 'refused', reason: 'dead' });
    expect(after.some((m) => m.t === 'ack')).toBe(false);
    expect(await chain(creature)).toHaveLength(3);
  });

  it('does not end a creature that is still short of its lifespan', async () => {
    const { c, creature, lifespan } = await newPlayer();
    await playFor(c, lifespan - 60_000);
    const ack = await nextOf(c, 'ack');
    expect(ack.activeMs).toBeLessThan(lifespan);
    expect((await flush(c)).some((m) => m.t === 'died')).toBe(false);
    expect(await status(creature)).toBe('active');
  });

  it('carries the lifespan in life and ack', async () => {
    const { c, id, lifespan } = await newPlayer();
    advance(1000);
    report(c, 30);
    expect(await nextOf(c, 'ack')).toMatchObject({ lifespanMs: lifespan });
    c.ws.close(1000, 'bye');
    await c.closed;
    const again = await login(id);
    expect(again.life.life?.lifespanMs).toBe(lifespan);
  });

  it('gives lifespan traits 0.6, 1.0 and 1.6 the lifespans 45, 75 and 120 minutes', () => {
    const minutes = (trait: number) => lifespanMs(trait) / 60_000;
    expect(minutes(0.6)).toBeCloseTo(45, 9);
    expect(minutes(1.0)).toBeCloseTo(75, 9);
    expect(minutes(1.6)).toBeCloseTo(120, 9);
  });
});

describe('LIFESPAN_SCALE', () => {
  it('shortens the lifespan in fixture mode only', async () => {
    const { c, id, lifespan } = await newPlayer();
    c.ws.close(1000, 'bye');
    await c.closed;

    // Alone, the variable does nothing.
    await setEnv({ LIFESPAN_SCALE: '0.01' });
    const plain = await login(id);
    expect(plain.life.life?.lifespanMs).toBe(lifespan);
    plain.c.ws.close(1000, 'bye');
    await plain.c.closed;

    await setEnv({ LIFESPAN_SCALE: '0.01', DRAND_SOURCE: 'fixture' });
    const scaled = await login(id);
    expect(scaled.life.life?.lifespanMs).toBe(Math.round(lifespan * 0.01));
    // Old age comes at 1% of the time.
    await playFor(scaled.c, Math.round(lifespan * 0.01) + 5000);
    expect((await nextOf(scaled.c, 'died')).cause).toBe('old-age');
  });

  it.each(['0', '-1', 'abc', '5'])('ignores the nonsense value %s', async (value) => {
    const { c, id, lifespan } = await newPlayer();
    c.ws.close(1000, 'bye');
    await c.closed;
    await setEnv({ LIFESPAN_SCALE: value, DRAND_SOURCE: 'fixture' });
    expect((await login(id)).life.life?.lifespanMs).toBe(lifespan);
  });
});

describe('death requests', () => {
  it.each(['starved', 'toxin', 'uv', 'pressure', 'killed'] as const)(
    'records a death of %s after a checkpoint of the last progress',
    async (cause) => {
      const { c, creature } = await newPlayer();
      advance(30_000);
      report(c, 900, { biomass: 10_000, energy: 3000, health: 500 });
      await nextOf(c, 'ack');
      advance(10_000);
      c.send({ t: 'death', cause, ticks: 1200 });
      const died = await nextOf(c, 'died');
      expect(died.cause).toBe(cause);
      expect(died.record.record).toMatchObject({
        kind: 'death',
        body: { cause, activeMs: 40_000 },
      });

      const records = await chain(creature);
      expect(records.map((r) => r.kind)).toEqual(['genesis', 'checkpoint', 'death']);
      expect(JSON.parse(records[1]?.json ?? '{}').body).toMatchObject({
        biomass: 10_000,
        energy: 3000,
        health: 500,
        activeMs: 30_000,
      });
      expect(await status(creature)).toBe('dead');
    },
  );

  it('answers a second death for the same creature with the same record', async () => {
    const { c, creature } = await newPlayer();
    advance(5000);
    c.send({ t: 'death', cause: 'toxin', ticks: 150 });
    const first = await nextOf(c, 'died');
    c.send({ t: 'death', cause: 'starved', ticks: 150 });
    const second = await nextOf(c, 'died');
    expect(second).toEqual(first);
    expect(second.cause).toBe('toxin');
    // Death with no earlier progress: no checkpoint to write, only the death.
    expect((await chain(creature)).map((r) => r.kind)).toEqual(['genesis', 'death']);
  });

  it('refuses old age from a client and leaves the creature alive', async () => {
    const { c, creature } = await newPlayer();
    c.send({ t: 'death', cause: 'old-age', ticks: 0 });
    expect(await flush(c)).toContainEqual({ t: 'refused', reason: 'cause' });
    expect(await status(creature)).toBe('active');
  });

  it('ignores a death without a creature and notes it', async () => {
    const { c, id } = await login();
    c.send({ t: 'death', cause: 'starved', ticks: 10 });
    expect((await flush(c)).some((m) => m.t === 'died')).toBe(false);
    c.send({ t: 'death', cause: 'starved', ticks: 20 });
    await flush(c);
    const flagged = await sql<{ kind: string; owner: string }>(
      "SELECT kind, owner FROM flags WHERE kind = 'stray-death'",
    );
    // One row per player, however often it repeats.
    expect(flagged).toEqual([{ kind: 'stray-death', owner: id.playerId }]);
  });

  it('credits no more than the wall time allows for the last stretch', async () => {
    const { c, creature } = await newPlayer();
    advance(1000);
    c.send({ t: 'death', cause: 'starved', ticks: 90_000 });
    const died = await nextOf(c, 'died');
    expect(died.record.record.body.activeMs).toBe(3000);
    expect(await status(creature)).toBe('dead');
  });

  it('lets the owner hatch again, and a dead creature takes no later transition', async () => {
    const { c, id, creature } = await newPlayer();
    c.send({ t: 'death', cause: 'starved', ticks: 0 });
    await nextOf(c, 'died');
    const next = await hatch(c, id);
    expect(recordHash(next.record.record)).not.toBe(creature);
    expect(await chain(creature)).toHaveLength(2);
  });

  it('saves nothing more when the socket of a dead creature closes', async () => {
    const { c, creature } = await newPlayer();
    advance(30_000);
    report(c, 900);
    await nextOf(c, 'ack');
    c.send({ t: 'death', cause: 'uv', ticks: 900 });
    await nextOf(c, 'died');
    c.ws.close(1000, 'bye');
    await c.closed;
    await sql('SELECT 1');
    expect(await chain(creature)).toHaveLength(3);
  });
});

describe('history', () => {
  const pastLives = async (c: Client): Promise<Extract<HubMsg, { t: 'history' }>> => {
    c.send({ t: 'history' });
    return nextOf(c, 'history');
  };

  it('lists past lives newest first with species, cause and times, and none of another player', async () => {
    const a = await login();
    const first = await hatch(a.c, a.id);
    advance(10_000);
    a.c.send({ t: 'death', cause: 'toxin', ticks: 300 });
    const firstDeath = await nextOf(a.c, 'died');
    advance(60_000);
    const second = await hatch(a.c, a.id);
    advance(10_000);
    a.c.send({ t: 'death', cause: 'starved', ticks: 300 });
    await nextOf(a.c, 'died');

    const other = await login();
    const theirs = await hatch(other.c, other.id);
    other.c.send({ t: 'death', cause: 'killed', ticks: 0 });
    await nextOf(other.c, 'died');

    const { lives } = await pastLives(a.c);
    expect(lives.map((l) => l.creature)).toEqual([
      recordHash(second.record.record),
      recordHash(first.record.record),
    ]);
    expect(lives.map((l) => l.cause)).toEqual(['starved', 'toxin']);
    const genome = genomeFromBase64url(first.genome);
    expect(lives[1]).toMatchObject({
      species: speciesName(genome as never),
      activeMs: 10_000,
      bornT: first.record.record.t,
      diedT: firstDeath.record.record.t,
    });
    expect(lives.some((l) => l.creature === recordHash(theirs.record.record))).toBe(false);
    expect((await pastLives(other.c)).lives).toHaveLength(1);
  });

  it('is empty for a player with no past life and does not list the living creature', async () => {
    const { c, id } = await login();
    expect((await pastLives(c)).lives).toEqual([]);
    await hatch(c, id);
    expect((await pastLives(c)).lives).toEqual([]);
  });

  it('caps the answer at 20 lives', async () => {
    const { c, id } = await login();
    const g = await hatch(c, id);
    c.send({ t: 'death', cause: 'starved', ticks: 0 });
    await nextOf(c, 'died');
    const creature = recordHash(g.record.record);
    // 24 more dead creatures of the same owner, each with the death record the history reads its cause from.
    for (let i = 0; i < 24; i++) {
      const copy = `${i.toString(16).padStart(2, '0')}${creature.slice(2)}`;
      await sql(
        `INSERT INTO creatures (id, owner, status, seq, hash, genome, active_ms, biomass, energy, health, born_t, died_t)
         VALUES (?1, ?2, 'dead', 1, ?1, ?3, 1000, 0, 0, 0, ?4, ?5)`,
        copy,
        id.playerId,
        g.genome,
        1000 + i,
        2000 + i,
      );
      await sql(
        `INSERT INTO records (creature, seq, hash, req, kind, owner, t, json, owner_sig, auth_sig, key_id)
         VALUES (?1, 1, ?1, ?1, 'death', ?2, ?3, ?4, NULL, '', '')`,
        copy,
        id.playerId,
        2000 + i,
        JSON.stringify({ kind: 'death', body: { cause: 'uv', activeMs: 1000 } }),
      );
    }
    const { lives } = await pastLives(c);
    expect(lives).toHaveLength(HISTORY_MAX);
    // Newest death first.
    expect(lives[0]?.diedT).toBeGreaterThanOrEqual(lives[HISTORY_MAX - 1]?.diedT ?? 0);
    expect(lives.every((l) => l.cause !== undefined)).toBe(true);
  });

  it('survives every message through the shared codec', async () => {
    const { c, id } = await login();
    await hatch(c, id);
    c.send({ t: 'death', cause: 'toxin', ticks: 0 });
    await nextOf(c, 'died');
    c.send({ t: 'history' });
    const msg = await nextOf(c, 'history');
    expect(parseHubMsg(JSON.stringify(msg))).toEqual(msg);
  });
});

describe('the life clock never gains', () => {
  it('is non-decreasing and bounded by wall time plus slack per session (500 random sequences)', () => {
    const genome = starterGenome();
    for (let seed = 0; seed < 500; seed++) {
      const rng = createRng(seedFromString(`clock-${seed}`), 'clock');
      const below = (n: number) => rng.int(0, n - 1);
      let wallNow = 1_000_000;
      let saved = 0;
      let sessions = 0;
      let life: LifeState | null = null;
      let ticks = 0;
      let n = 0;
      const checkpoint = () => {
        if (life && unsaved(life)) {
          expect(life.activeMs).toBeGreaterThanOrEqual(saved);
          saved = life.activeMs;
          life = { ...life, savedMs: life.activeMs, savedN: life.n };
        }
      };
      for (let step = 0; step < 40; step++) {
        wallNow += below(120_000);
        const roll = below(10);
        if (!life) {
          life = bindLife(
            { id: 'c', activeMs: saved, biomass: 0, energy: 0, health: 0 },
            genome,
            wallNow,
            10 ** 12,
          );
          sessions++;
          ticks = 0;
        } else if (roll < 7) {
          // Claims anything from nothing to a day of play.
          ticks += below(3) === 0 ? 0 : below(3_000_000);
          life = applyReport(life, { n: ++n, ticks, ...CALM }, wallNow).life;
          if (life.activeMs - saved >= 900_000) checkpoint();
        } else {
          checkpoint();
          life = null;
        }
        // The head never rewinds, and nothing outruns the wall clock plus one slack per session.
        expect(saved).toBeLessThanOrEqual(
          wallNow - 1_000_000 + sessions * RULES.life.accrueSlackMs,
        );
      }
      checkpoint();
      expect(saved).toBeLessThanOrEqual(wallNow - 1_000_000 + sessions * RULES.life.accrueSlackMs);
    }
  });

  it('ends a life at its lifespan however much is claimed', () => {
    const genome = starterGenome();
    const life = bindLife(
      { id: 'c', activeMs: 0, biomass: 0, energy: 0, health: 0 },
      genome,
      0,
      60_000,
    );
    const next = applyReport(life, { n: 1, ticks: 2_000_000, ...CALM }, 10 ** 9).life;
    expect(next.activeMs).toBe(60_000);
  });
});
