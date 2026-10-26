import { evictDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { genomeFromBase64url } from '../src/genome/codec';
import { buildCreature } from '../src/genome/stats';
import { recordHash } from '../src/ledger/record';
import { CLOSE_RATE_LIMITED, type HubMsg } from '../src/net/protocol';
import { RULES, RULES_VERSION } from '../src/sim/rules';
import {
  type Client,
  closeSockets,
  hatch,
  login,
  nextOf,
  rowsWritten,
  sql,
  stub,
  useFakeBeacons,
} from './test-hub';

const TICKS_PER_30S = 900;

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
  await closeSockets();
});

interface Condition {
  biomass: number;
  energy: number;
  health: number;
}
const CALM: Condition = { biomass: 10_000, energy: 12_000, health: 10_000 };

/** Logs in and hatches a creature; its clock starts at the current fake wall time. */
async function newPlayer() {
  const { c, id } = await login();
  const g = await hatch(c, id);
  const creature = recordHash(g.record.record);
  const stats = buildCreature(genomeFromBase64url(g.genome) as never).stats;
  return { c, id, creature, stats };
}

let reports = 0;
/** Sends a `progress` for `c`; `n` counts up by default. */
function report(c: Client, ticks: number, cond: Condition = CALM, n = ++reports) {
  c.send({ t: 'progress', n, ticks, ...cond });
}

/** Everything the hub sends up to the answer to a ping, so a silent message shows as nothing. */
async function flush(c: Client): Promise<HubMsg[]> {
  const id = 1 + (++reports % 1000);
  c.send({ t: 'ping', id });
  const out: HubMsg[] = [];
  for (;;) {
    const msg = await c.next();
    if (msg.t === 'pong' && msg.id === id) return out;
    out.push(msg);
  }
}

const head = async (creature: string) =>
  (
    await sql<{
      seq: number;
      active_ms: number;
      biomass: number;
      energy: number;
      health: number;
    }>('SELECT seq, active_ms, biomass, energy, health FROM creatures WHERE id = ?', creature)
  )[0];

const flags = async (creature: string) =>
  (await sql<{ kind: string }>('SELECT kind FROM flags WHERE creature = ?', creature)).map(
    (f) => f.kind,
  );

/** Closes the socket (which checkpoints) and waits for it. */
async function leave(c: Client) {
  c.ws.close(1000, 'bye');
  await c.closed;
  // The close is handled after the peer's close event; a query goes through the object after it.
  await sql('SELECT 1');
}

describe('progress and the life clock', () => {
  it('credits the ticks, but at most the wall time plus 2 s', async () => {
    const { c } = await newPlayer();
    advance(5000);
    report(c, TICKS_PER_30S);
    expect(await nextOf(c, 'ack')).toMatchObject({ activeMs: 7000 });

    const slow = await newPlayer();
    advance(40_000);
    report(slow.c, TICKS_PER_30S);
    expect(await nextOf(slow.c, 'ack')).toMatchObject({ activeMs: 30_000 });
  });

  it('credits nothing without ticks, whatever the wall clock says', async () => {
    const { c } = await newPlayer();
    advance(600_000);
    report(c, 0);
    expect(await nextOf(c, 'ack')).toMatchObject({ activeMs: 0 });
    // Ticks that go backwards after that credit nothing either.
    advance(30_000);
    report(c, TICKS_PER_30S);
    const ack = await nextOf(c, 'ack');
    advance(30_000);
    report(c, 100);
    expect(await nextOf(c, 'ack')).toMatchObject({ activeMs: ack.activeMs });
  });

  it('adds up across reports and answers with the matching n', async () => {
    const { c } = await newPlayer();
    for (let i = 1; i <= 3; i++) {
      advance(30_000);
      report(c, i * TICKS_PER_30S, CALM, 10 * i);
      expect(await nextOf(c, 'ack')).toEqual({ t: 'ack', n: 10 * i, activeMs: 30_000 * i });
    }
  });

  it('ignores a repeated or lower n without an answer', async () => {
    const { c } = await newPlayer();
    advance(30_000);
    report(c, TICKS_PER_30S, CALM, 5);
    advance(30_000);
    report(c, 2 * TICKS_PER_30S, CALM, 5);
    report(c, 2 * TICKS_PER_30S, CALM, 4);
    const rest = await flush(c);
    expect(rest.filter((m) => m.t === 'ack')).toHaveLength(1);
  });

  it('ignores a progress from a player with no creature', async () => {
    const { c } = await login();
    report(c, TICKS_PER_30S);
    expect((await flush(c)).filter((m) => m.t === 'ack')).toHaveLength(0);
  });

  it('closes the session at 1,000 progress messages in 10 s like any message', async () => {
    const { c } = await newPlayer();
    for (let i = 0; i < 1000; i++) report(c, i);
    expect(await c.closed).toBe(CLOSE_RATE_LIMITED);
  });
});

describe('plausibility', () => {
  it('clamps biomass to what the genome can grow to', async () => {
    const { c, creature, stats } = await newPlayer();
    advance(30_000);
    report(c, TICKS_PER_30S, { ...CALM, biomass: 900_000_000 });
    await nextOf(c, 'ack');
    await leave(c);
    const row = await head(creature);
    expect(row?.biomass).toBeLessThanOrEqual(Math.floor(stats.maxBiomass * 100));
    expect(await flags(creature)).toContain('biomass-over-max');
  });

  it('clamps growth faster than the growth rate allows', async () => {
    const { c, creature, stats } = await newPlayer();
    expect(stats.maxBiomass).toBeGreaterThan(300);
    advance(30_000);
    report(c, TICKS_PER_30S, { ...CALM, biomass: 30_000 });
    await nextOf(c, 'ack');
    await leave(c);
    // 30 s from the starting biomass at the genome's growth rate, plus 10 % and 1 wu.
    const bound =
      RULES.starter.biomass * Math.exp(RULES.growth.maxRate * stats.growth * 1.1 * 30) * 100 + 100;
    const row = await head(creature);
    expect(row?.biomass).toBeLessThanOrEqual(Math.floor(bound));
    expect(row?.biomass).toBeGreaterThan(CALM.biomass);
    expect(await flags(creature)).toContain('growth-too-fast');
  });

  it('accepts honest growth without a flag', async () => {
    const { c, creature, stats } = await newPlayer();
    advance(30_000);
    const honest = Math.floor(
      RULES.starter.biomass * Math.exp(RULES.growth.maxRate * stats.growth * 30) * 100,
    );
    report(c, TICKS_PER_30S, {
      biomass: honest,
      energy: honest,
      health: Math.floor(10 * Math.sqrt(honest / 100) * 100),
    });
    await nextOf(c, 'ack');
    await leave(c);
    expect((await head(creature))?.biomass).toBe(honest);
    expect(await flags(creature)).toEqual([]);
  });

  it('clamps energy to twice the biomass and health to 10 per radius', async () => {
    const { c, creature } = await newPlayer();
    advance(30_000);
    report(c, TICKS_PER_30S, { biomass: 10_000, energy: 99_000_000, health: 99_000_000 });
    await nextOf(c, 'ack');
    await leave(c);
    const row = await head(creature);
    expect(row?.energy).toBe(20_000);
    expect(row?.health).toBe(10_000);
    expect(await flags(creature)).toEqual(expect.arrayContaining(['energy-over', 'health-over']));
  });

  it('keeps the session open and flags once per kind', async () => {
    const { c, creature } = await newPlayer();
    for (let i = 1; i <= 4; i++) {
      advance(30_000);
      report(c, i * TICKS_PER_30S, { ...CALM, energy: 99_000_000 });
      await nextOf(c, 'ack');
    }
    expect(await flags(creature)).toEqual(['energy-over']);
  });
});

describe('checkpoints', () => {
  it('writes no row for progress alone', async () => {
    const { c, creature } = await newPlayer();
    const before = await sql<{ n: number }>('SELECT COUNT(*) AS n FROM records');
    for (let i = 1; i <= 5; i++) {
      advance(30_000);
      report(c, i * TICKS_PER_30S);
      await nextOf(c, 'ack');
    }
    const after = await sql<{ n: number }>('SELECT COUNT(*) AS n FROM records');
    expect(after[0]?.n).toBe(before[0]?.n);
    expect((await head(creature))?.seq).toBe(0);
  });

  it('writes one when the socket closes after progress', async () => {
    const { c, id, creature } = await newPlayer();
    advance(30_000);
    report(c, TICKS_PER_30S);
    await nextOf(c, 'ack');
    await leave(c);
    const chain = await sql<{ json: string; seq: number }>(
      'SELECT seq, json FROM records WHERE creature = ? ORDER BY seq',
      creature,
    );
    expect(chain.map((r) => r.seq)).toEqual([0, 1]);
    const record = JSON.parse(chain[1]?.json ?? '{}');
    expect(record).toMatchObject({
      kind: 'checkpoint',
      owner: id.playerId,
      seq: 1,
      rules: RULES_VERSION,
      body: { ...CALM, activeMs: 30_000 },
    });
    const genesis = JSON.parse(chain[0]?.json ?? '{}');
    expect(record.prev).toBe(recordHash(genesis));
  });

  it('writes none when the socket closes without progress', async () => {
    const { c, creature } = await newPlayer();
    await leave(c);
    expect((await head(creature))?.seq).toBe(0);
  });

  it('writes one on the first progress after 15 minutes of active time', async () => {
    const { c, creature } = await newPlayer();
    for (let i = 1; i < 30; i++) {
      advance(30_000);
      report(c, i * TICKS_PER_30S);
      await nextOf(c, 'ack');
    }
    expect((await head(creature))?.seq).toBe(0);
    advance(30_000);
    report(c, 30 * TICKS_PER_30S);
    await nextOf(c, 'ack');
    expect(await head(creature)).toMatchObject({ seq: 1, active_ms: 900_000 });
    // The next period starts from the checkpoint, and closing right after writes nothing more.
    await leave(c);
    expect((await head(creature))?.seq).toBe(1);
  });
});

describe('write and message budgets', () => {
  async function playHour(reconnects: number) {
    const { c: first, id, creature } = await newPlayer();
    let c = first;
    const rowsBefore = await rowsWritten();
    let ticks = 0;
    let sent = 0;
    const perSession = 120 / (reconnects + 1);
    for (let s = 0; s <= reconnects; s++) {
      ticks = 0;
      for (let i = 0; i < perSession; i++) {
        advance(30_000);
        ticks += TICKS_PER_30S;
        report(c, ticks, { ...CALM, biomass: 10_000 + sent });
        sent++;
        await nextOf(c, 'ack');
      }
      if (s < reconnects) {
        await leave(c);
        advance(1000);
        c = (await login(id)).c;
      }
    }
    await leave(c);
    return { rows: (await rowsWritten()) - rowsBefore, sent, creature };
  }

  it('costs at most 10 row writes for one hour of play', async () => {
    const { rows, sent } = await playHour(0);
    console.log(`progress budget: ${rows} rows and ${sent + 2} messages in one hour`);
    expect(rows).toBeLessThanOrEqual(10);
    // 120 reports plus the ping and hello: well under 20 messages per player-minute.
    expect((sent + 2) / 60).toBeLessThan(20);
  });

  it('costs at most 18 row writes with 4 reconnects', async () => {
    const { rows, sent } = await playHour(4);
    console.log(
      `progress budget (4 reconnects): ${rows} rows and ${sent + 10} messages in one hour`,
    );
    expect(rows).toBeLessThanOrEqual(18);
  });
});

describe('resume', () => {
  it('sends the last checkpointed condition and clock in life', async () => {
    const { c, id, creature } = await newPlayer();
    advance(30_000);
    report(c, TICKS_PER_30S, { biomass: 10_100, energy: 15_000, health: 10_000 });
    await nextOf(c, 'ack');
    await leave(c);
    const back = await login(id);
    expect(back.life.life).toMatchObject({
      creature,
      seq: 1,
      biomass: 10_100,
      energy: 15_000,
      health: 10_000,
      activeMs: 30_000,
    });
  });

  it('keeps the clock across an eviction of the object', async () => {
    const { c } = await newPlayer();
    advance(30_000);
    report(c, TICKS_PER_30S);
    expect(await nextOf(c, 'ack')).toMatchObject({ activeMs: 30_000 });
    await evictDurableObject(stub());
    await useFakeBeacons();
    advance(30_000);
    report(c, 2 * TICKS_PER_30S);
    // Neither lost nor counted twice.
    expect(await nextOf(c, 'ack')).toMatchObject({ activeMs: 60_000 });
  });

  it('does not age a creature while its player is away', async () => {
    const { c, id } = await newPlayer();
    advance(30_000);
    report(c, TICKS_PER_30S);
    await nextOf(c, 'ack');
    await leave(c);
    advance(10 * 3_600_000);
    const back = await login(id);
    expect(back.life.life?.activeMs).toBe(30_000);
    report(back.c, TICKS_PER_30S);
    // The clock restarts at the login: ticks played now, not the ten hours.
    expect(await nextOf(back.c, 'ack')).toMatchObject({ activeMs: 32_000 });
  });

  it('checkpoints a session another login replaces', async () => {
    const { c, id, creature } = await newPlayer();
    advance(30_000);
    report(c, TICKS_PER_30S);
    await nextOf(c, 'ack');
    const next = await login(id);
    expect(await c.closed).toBe(4001);
    expect(next.life.life).toMatchObject({ creature, seq: 1, activeMs: 30_000 });
  });
});
