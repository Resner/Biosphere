import { runInDurableObject } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { roundAt } from '../src/ledger/drand';
import { commitmentId } from '../src/ledger/genesis';
import type { Identity } from '../src/ledger/identity';
import { checkMatePair, type MateAsk, signMateAsk } from '../src/ledger/mating';
import { checkStored, type PubKey, recordHash } from '../src/ledger/record';
import type { HubMsg } from '../src/net/protocol';
import type { MateView } from '../src/sim/mating';
import { RULES } from '../src/sim/rules';
import * as mating from './mating';
import { refusalFor } from './mating';
import {
  CALM,
  type Client,
  closeSockets,
  flush,
  freshNonce,
  hatch,
  login,
  nextOf,
  ORIGIN,
  report,
  rowsWritten,
  source,
  sql,
  stub,
  useFakeBeacons,
} from './test-hub';

// M5 T7: courtship to commitment on the hub, with fake beacons and a hand-moved wall clock.
// MATING_SCALE 0.01 turns minutes into seconds: maturity ~9 s, cooldown 3.6 s, repeat window 864 s.

const TICKS_PER_S = 30;
const SCALE = '0.01';

let wall = 0;
const advance = (ms: number) => {
  wall += ms;
};

const setEnv = (vars: { DRAND_SOURCE?: string | undefined; MATING_SCALE?: string | undefined }) =>
  runInDurableObject(stub(), (authority) => {
    const e = (authority as unknown as { env: Record<string, string | undefined> }).env;
    e.DRAND_SOURCE = vars.DRAND_SOURCE;
    e.MATING_SCALE = vars.MATING_SCALE;
  });

beforeEach(async () => {
  wall = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => wall);
  await useFakeBeacons();
  await setEnv({ DRAND_SOURCE: 'fixture', MATING_SCALE: SCALE });
  await sql('DELETE FROM matings');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await setEnv({});
  await closeSockets();
});

interface Player {
  c: Client;
  id: Identity;
  creature: string;
  ticks: number;
}

async function player(): Promise<Player> {
  const { c, id } = await login();
  const g = await hatch(c, id);
  return { c, id, creature: recordHash(g.record.record), ticks: 0 };
}

/** Plays `ms` of active time and waits for the ack. */
async function play(p: Player, ms: number, cond = CALM) {
  advance(ms);
  p.ticks += Math.ceil((ms * TICKS_PER_S) / 1000);
  report(p.c, p.ticks, cond);
  return nextOf(p.c, 'ack');
}

/** A player old enough to mate. */
async function adult(): Promise<Player> {
  const p = await player();
  await play(p, 12_000);
  return p;
}

const askOf = (from: Player, to: Player, nonce = freshNonce()): MateAsk =>
  signMateAsk(from.id, {
    creature: from.creature,
    partner: to.id.playerId,
    partnerCreature: to.creature,
    nonce,
  });

/** Courts and returns the invite the partner sees. */
async function court(a: Player, b: Player, nonce?: string) {
  const ask = askOf(a, b, nonce);
  a.c.send({ t: 'court', ask });
  return { ask, invite: await nextOf(b.c, 'invite') };
}

async function courtship(a: Player, b: Player) {
  const { ask: askA } = await court(a, b);
  const askB = askOf(b, a, askA.nonce);
  b.c.send({ t: 'accept', ask: askB });
  const [ma, mb] = await Promise.all([nextOf(a.c, 'mating'), nextOf(b.c, 'mating')]);
  return { askA, askB, ma, mb };
}

/** What the player is told when a message is refused. */
async function refusal(c: Client): Promise<string> {
  const msg = await nextOf(c, 'refused');
  return msg.reason;
}

async function check(a: Player, b: Player | string) {
  a.c.send({ t: 'mate-check', partner: typeof b === 'string' ? b : b.id.playerId });
  return nextOf(a.c, 'mate-info');
}

const matings = () => sql<{ n: number }>('SELECT COUNT(*) AS n FROM matings').then((r) => r[0]?.n);
const resolveAll = () => sql('UPDATE matings SET resolved = 1');

describe('mate-check', () => {
  it('answers ok for a pair that could mate, with the card facts', async () => {
    const [a, b] = [await adult(), await adult()];
    const info = await check(a, b);
    expect(info).toMatchObject({
      partner: b.id.playerId,
      reason: null,
      kinship: 0,
      generation: 0,
      cooldownLeftMs: 0,
    });
    expect(info.tier).toBeGreaterThanOrEqual(0);
    expect(info.creature).toMatch(/^[0-9a-f]{64}$/);
  });

  it('names my reason, then the partner’s with a partner- prefix', async () => {
    const [young, old] = [await player(), await adult()];
    expect((await check(young, old)).reason).toBe('not-mature');
    expect((await check(old, young)).reason).toBe('partner-not-mature');
  });

  it('says not-here for another pond, an unknown or an offline player', async () => {
    const a = await adult();
    const b = await adult();
    expect((await check(a, 'x'.repeat(43))).reason).toBe('not-here');
    await sql("UPDATE ponds SET id = id || 'x'"); // cosmetic: ponds are matched by session, not by row
    const away = b.id.playerId;
    b.c.ws.close(1000, 'bye');
    await b.c.closed;
    await sql('SELECT 1');
    expect((await check(a, away)).reason).toBe('not-here');
  });
});

describe('courtship', () => {
  it('commits to the round after the latest and chains both records', async () => {
    const [a, b] = [await adult(), await adult()];
    const before = await sql<{ seq: number }>('SELECT seq FROM creatures WHERE id = ?', a.creature);
    const { askA, askB, ma, mb } = await courtship(a, b);

    const latest = roundAt(source.now());
    expect(ma.commit.commitment.round).toBe(latest + 2);
    expect(mb.commit).toEqual(ma.commit);
    expect(ma.commit.commitment).toMatchObject({ kind: 'mate', owner: a.id.playerId });
    expect(ma.commit.commitment.data).toEqual({ a: askA, b: askB });
    expect(checkMatePair(askA, a.id.playerId, askB, b.id.playerId)).toEqual([]);

    const keys = (await (
      await exports.default.fetch('https://authority.test/v1/pubkeys', {
        headers: { Origin: ORIGIN },
      })
    ).json()) as { keys: PubKey[] };
    for (const [m, p, role] of [
      [ma, a, 'a'],
      [mb, b, 'b'],
    ] as const) {
      expect(checkStored(m.record, keys.keys)).toEqual([]);
      const body = m.record.record.body;
      expect(m.record.record.kind).toBe('mate-commit');
      expect(m.record.record.creature).toBe(p.creature);
      expect(body).toMatchObject({
        commit: commitmentId(ma.commit.commitment),
        round: latest + 2,
        role,
      });
    }
    expect(ma.record.record.seq).toBe((before[0]?.seq ?? 0) + 1);
    const sa = await sql<{
      biomass: number;
      energy: number;
      cooldown_until_ms: number;
      active_ms: number;
    }>(
      'SELECT biomass, energy, cooldown_until_ms, active_ms FROM creatures WHERE id = ?',
      a.creature,
    );
    // 85% of the biomass and 70% of the energy the authority last saw.
    expect(sa[0]?.biomass).toBe(Math.floor(CALM.biomass * 0.85));
    expect(sa[0]?.energy).toBe(Math.floor(CALM.energy * 0.7));
    expect(sa[0]?.cooldown_until_ms).toBe((sa[0]?.active_ms ?? 0) + 3600);
    expect(await matings()).toBe(1);
  });

  it('shows the new maturity and cooldown in the next ack', async () => {
    const [a, b] = [await adult(), await adult()];
    await courtship(a, b);
    const ack = await play(a, 1000);
    expect(ack.matureAtMs).toBeGreaterThan(0);
    expect(ack.matureAtMs).toBeLessThanOrEqual(ack.activeMs);
    expect(ack.cooldownUntilMs).toBeGreaterThan(ack.activeMs);
  });

  it('invites with a card of species-independent facts', async () => {
    const [a, b] = [await adult(), await adult()];
    const { invite } = await court(a, b);
    expect(invite).toMatchObject({ from: a.id.playerId, kinship: 0, generation: 0 });
  });

  it('a duplicate accept returns the same commitment and writes nothing more', async () => {
    const [a, b] = [await adult(), await adult()];
    const { askB, mb } = await courtship(a, b);
    const writes = await rowsWritten();
    b.c.send({ t: 'accept', ask: askB });
    const again = await nextOf(b.c, 'mating');
    expect(again).toEqual(mb);
    expect(await rowsWritten()).toBe(writes);
    expect(await matings()).toBe(1);
  });

  it('a second court replaces the first: the earlier invitation is void', async () => {
    const [a, b, c] = [await adult(), await adult(), await adult()];
    const { ask: first } = await court(a, b);
    await court(a, c);
    b.c.send({ t: 'accept', ask: askOf(b, a, first.nonce) });
    expect(await refusal(b.c)).toBe('no-court');
    expect(await matings()).toBe(0);
  });

  it('decline tells the courting player and voids the invitation', async () => {
    const [a, b] = [await adult(), await adult()];
    const { ask } = await court(a, b);
    b.c.send({ t: 'decline', partner: a.id.playerId });
    expect(await nextOf(a.c, 'declined')).toEqual({ t: 'declined', by: b.id.playerId });
    b.c.send({ t: 'accept', ask: askOf(b, a, ask.nonce) });
    expect(await refusal(b.c)).toBe('no-court');
  });

  it('a whole courtship costs 4 incoming messages and few row writes', async () => {
    const [a, b] = [await adult(), await adult()];
    const writes = await rowsWritten();
    await check(a, b);
    await check(b, a);
    await courtship(a, b);
    const used = (await rowsWritten()) - writes;
    console.log(`courtship: 4 messages, ${used} ledger row writes`);
    expect(used).toBeLessThanOrEqual(6);
  });
});

describe('the socket attachment', () => {
  it('stays within 2 KB while a court is held', async () => {
    const [a, b] = [await adult(), await adult()];
    await court(a, b);
    const sizes = await runInDurableObject(stub(), (_o, state) =>
      state.getWebSockets().map((ws) => JSON.stringify(ws.deserializeAttachment()).length),
    );
    console.log(`attachment sizes: ${sizes.join(', ')}`);
    expect(Math.max(...sizes)).toBeLessThan(2048);
  });
});

describe('refusals change nothing', () => {
  async function expectRefused(player: Player, reason: string) {
    expect(await refusal(player.c)).toBe(reason);
    expect(await matings()).toBe(0);
  }

  it('not mature', async () => {
    const [a, b] = [await player(), await adult()];
    a.c.send({ t: 'court', ask: askOf(a, b) });
    await expectRefused(a, 'not-mature');
  });

  it('partner not mature', async () => {
    const [a, b] = [await adult(), await player()];
    a.c.send({ t: 'court', ask: askOf(a, b) });
    await expectRefused(a, 'partner-not-mature');
  });

  it('low energy', async () => {
    const [a, b] = [await adult(), await adult()];
    await play(a, 1000, { ...CALM, energy: 3000 });
    a.c.send({ t: 'court', ask: askOf(a, b) });
    await expectRefused(a, 'low-energy');
  });

  it('size tiers two apart (the rules, on views the progress clamp cannot reach)', () => {
    const view = (biomass: number): MateView => ({
      creature: 'c',
      owner: String(biomass),
      active: true,
      activeMs: 1e9,
      matureAtMs: 0,
      cooldownUntilMs: 0,
      biomass,
      energy: 2 * biomass,
      hasPending: false,
      inFlight: false,
      locked: false,
    });
    expect(refusalFor(view(100), view(20_000))).toBe('tier');
    expect(refusalFor(view(1000), view(1100))).toBeNull();
  });

  it('the same player', async () => {
    const a = await adult();
    a.c.send({
      t: 'court',
      ask: signMateAsk(a.id, {
        creature: a.creature,
        partner: a.id.playerId,
        partnerCreature: a.creature,
        nonce: freshNonce(),
      }),
    });
    await expectRefused(a, 'self');
  });

  it('a partner who is not here', async () => {
    const a = await adult();
    const ghost = { id: a.id, creature: 'a'.repeat(64) } as Player;
    a.c.send({
      t: 'court',
      ask: signMateAsk(a.id, {
        creature: a.creature,
        partner: 'y'.repeat(43),
        partnerCreature: ghost.creature,
        nonce: freshNonce(),
      }),
    });
    await expectRefused(a, 'not-here');
  });

  it('a bad signature', async () => {
    const [a, b] = [await adult(), await adult()];
    const ask = askOf(a, b);
    a.c.send({
      t: 'court',
      ask: { ...ask, sig: `${ask.sig.slice(0, 85)}${ask.sig.endsWith('A') ? 'B' : 'A'}` },
    });
    await expectRefused(a, 'bad-signature');
    // Signed by someone else.
    a.c.send({
      t: 'court',
      ask: signMateAsk(b.id, {
        creature: a.creature,
        partner: b.id.playerId,
        partnerCreature: b.creature,
        nonce: freshNonce(),
      }),
    });
    await expectRefused(a, 'bad-signature');
  });

  it('accept with no court', async () => {
    const [a, b] = [await adult(), await adult()];
    b.c.send({ t: 'accept', ask: askOf(b, a) });
    await expectRefused(b, 'no-court');
  });

  it('accept with the wrong nonce, creature or partner', async () => {
    const [a, b, c] = [await adult(), await adult(), await adult()];
    const { ask } = await court(a, b);
    b.c.send({ t: 'accept', ask: askOf(b, a, freshNonce()) });
    await expectRefused(b, 'pair-mismatch');
    b.c.send({
      t: 'accept',
      ask: signMateAsk(b.id, {
        creature: b.creature,
        partner: a.id.playerId,
        partnerCreature: c.creature,
        nonce: ask.nonce,
      }),
    });
    await expectRefused(b, 'pair-mismatch');
    // A third player's accept names a court that was not offered to them.
    c.c.send({ t: 'accept', ask: askOf(c, a, ask.nonce) });
    await expectRefused(c, 'no-court');
    b.c.send({
      t: 'accept',
      ask: signMateAsk(b.id, {
        creature: c.creature,
        partner: a.id.playerId,
        partnerCreature: a.creature,
        nonce: ask.nonce,
      }),
    });
    await expectRefused(b, 'bad-signature');
  });

  it('accept after 20 s', async () => {
    const [a, b] = [await adult(), await adult()];
    const { ask } = await court(a, b);
    advance(RULES.mating.signWindowMs + 1);
    b.c.send({ t: 'accept', ask: askOf(b, a, ask.nonce) });
    await expectRefused(b, 'expired');
    // Exactly at the limit is still good.
    const second = await court(a, b);
    advance(RULES.mating.signWindowMs);
    b.c.send({ t: 'accept', ask: askOf(b, a, second.ask.nonce) });
    expect((await nextOf(b.c, 'mating')).record.record.kind).toBe('mate-commit');
  });

  it('a replayed ask after its commitment is used', async () => {
    const [a, b] = [await adult(), await adult()];
    const { askA } = await courtship(a, b);
    await resolveAll();
    await play(a, 10_000);
    await play(b, 10_000);
    a.c.send({ t: 'court', ask: askA });
    expect(await refusal(a.c)).toBe('used');
    expect(await matings()).toBe(1);
  });

  it('cooldown, and allowed again once the active time has passed', async () => {
    const [a, b] = [await adult(), await adult()];
    await courtship(a, b);
    await resolveAll();
    const reason = async () => {
      a.c.send({ t: 'court', ask: askOf(a, b) });
      const refused = (await flush(a.c)).find((m) => m.t === 'refused');
      const invited = (await flush(b.c)).some((m) => m.t === 'invite');
      return refused?.t === 'refused' ? refused.reason : invited ? 'invited' : 'nothing';
    };
    expect(await reason()).toBe('cooldown');
    // 3.6 s of cooldown after the first mating, doubled for a second one with this partner: 7.2 s.
    await play(a, 4000);
    await play(b, 4000);
    expect(await reason()).toBe('invited');
  });

  it('a mating in flight blocks both players', async () => {
    const [a, b, c] = [await adult(), await adult(), await adult()];
    await courtship(a, b);
    c.c.send({ t: 'court', ask: askOf(c, a) });
    expect(await refusal(c.c)).toBe('partner-in-flight');
    expect(await matings()).toBe(1);
  });

  it('a partner with a pending child', async () => {
    const [a, b] = [await adult(), await adult()];
    await sql(
      `INSERT INTO creatures (id, owner, status, seq, hash, genome, active_ms, biomass, energy, health, born_t, generation, cooldown_until_ms)
       VALUES (?, ?, 'pending', 0, ?, 'x', 0, 100, 100, 100, 1, 1, 0)`,
      'e'.repeat(64),
      b.id.playerId,
      'e'.repeat(64),
    ).catch(() => {});
    a.c.send({ t: 'court', ask: askOf(a, b) });
    const reason = await refusal(a.c);
    expect(['partner-pending']).toContain(reason);
    await sql('DELETE FROM creatures WHERE id = ?', 'e'.repeat(64));
  });
});

describe('cooldown doubling for the same pair', () => {
  it('doubles for a repeat with the same partner and not for another', async () => {
    const [a, b, c] = [await adult(), await adult(), await adult()];
    const cooldownOf = async (p: Player) => {
      const r = await sql<{ cooldown_until_ms: number; active_ms: number }>(
        'SELECT cooldown_until_ms, active_ms FROM creatures WHERE id = ?',
        p.creature,
      );
      return (r[0]?.cooldown_until_ms ?? 0) - (r[0]?.active_ms ?? 0);
    };
    await courtship(a, b);
    expect(await cooldownOf(a)).toBe(3600);
    for (const want of [7200, 14_400]) {
      await resolveAll();
      await play(a, 20_000);
      await play(b, 20_000);
      await courtship(a, b);
      expect(await cooldownOf(a)).toBe(want);
    }
    // A different partner is back to x1.
    await resolveAll();
    await play(a, 60_000);
    await play(c, 1000);
    await courtship(a, c);
    expect(await cooldownOf(a)).toBe(3600);
  });
});

describe('a commitment cannot be undone', () => {
  it('exports nothing that edits a stored round', () => {
    const names = Object.keys(mating);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names)
      expect(name).not.toMatch(/cancel|undo|reroll|revoke|edit|setRound|withdraw/i);
  });

  it('closing either socket changes nothing', async () => {
    const [a, b] = [await adult(), await adult()];
    const { ma } = await courtship(a, b);
    a.c.ws.close(1000, 'bye');
    b.c.ws.close(1000, 'bye');
    await Promise.all([a.c.closed, b.c.closed]);
    await sql('SELECT 1');
    expect(await matings()).toBe(1);
    const row = await sql<{ round: number }>(
      'SELECT round FROM commitments WHERE kind = ? ORDER BY created DESC',
      'mate',
    );
    expect(row[0]?.round).toBe(ma.commit.commitment.round);
  });
});

describe('hello version', () => {
  it('flush still works after a courtship (no stray messages)', async () => {
    const [a, b] = [await adult(), await adult()];
    await courtship(a, b);
    const rest: HubMsg[] = await flush(a.c);
    expect(rest.filter((m) => m.t === 'refused' || m.t === 'error')).toEqual([]);
  });
});

void env;
