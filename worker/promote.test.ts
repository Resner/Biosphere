import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Identity, toBase64Url } from '../src/ledger/identity';
import { type MateAsk, signMateAsk } from '../src/ledger/mating';
import {
  REQUEST_DOMAIN,
  type RecordRequest,
  recordHash,
  requestMessage,
} from '../src/ledger/record';
import type { Ancestor, Born, ClientMsg, FallbackInfo } from '../src/net/protocol';
import { RULES_VERSION, TICK_HZ } from '../src/sim/rules';
import {
  CALM,
  type Client,
  closeSockets,
  freshNonce,
  genesisRequest,
  hatch,
  login,
  nextOf,
  publish,
  report,
  rowsWritten,
  sql,
  stub,
  useFakeBeacons,
} from './test-hub';

// M5 T9: promotion, restore, the death fallback, the lineage view and genesis gating.

let wall = 0;
const advance = (ms: number) => {
  wall += ms;
};

const setEnv = (on: boolean) =>
  runInDurableObject(stub(), (authority) => {
    const e = (authority as unknown as { env: Record<string, string | undefined> }).env;
    e.DRAND_SOURCE = on ? 'fixture' : undefined;
    e.MATING_SCALE = on ? '0.01' : undefined;
    e.LIFESPAN_SCALE = on ? '0.05' : undefined;
  });

beforeEach(async () => {
  wall = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => wall);
  await useFakeBeacons();
  await setEnv(true);
  await sql('DELETE FROM matings');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await setEnv(false);
  await closeSockets();
});

interface Player {
  c: Client;
  id: Identity;
  /** The creature this connection is playing. */
  creature: string;
  ticks: number;
  activeMs: number;
  lifespan: number;
}

const ticksFor = (ms: number) => Math.ceil((ms * TICK_HZ) / 1000);

/** Plays `ms` of wall time and reports it; the creature's `activeMs` as the hub credits it. */
async function play(p: Player, ms: number): Promise<number> {
  advance(ms);
  p.ticks += ticksFor(ms);
  report(p.c, p.ticks, CALM);
  const ack = await nextOf(p.c, 'ack');
  p.activeMs = ack.activeMs;
  p.lifespan = ack.lifespanMs;
  return ack.activeMs;
}

async function adult(): Promise<Player> {
  const { c, id } = await login();
  const g = await hatch(c, id);
  const p = { c, id, creature: recordHash(g.record.record), ticks: 0, activeMs: 0, lifespan: 0 };
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

/** `a` mates with a fresh adult; the round arrives and `a` holds the pending child. */
async function breed(a: Player): Promise<Born> {
  const b = await adult();
  const askA = askOf(a, b);
  a.c.send({ t: 'court', ask: askA });
  await nextOf(b.c, 'invite');
  b.c.send({ t: 'accept', ask: askOf(b, a, askA.nonce) });
  const [ma] = await Promise.all([nextOf(a.c, 'mating'), nextOf(b.c, 'mating')]);
  await publish(ma.commit.commitment.round);
  return nextOf(a.c, 'born');
}

const signed = (who: Identity, req: RecordRequest) =>
  toBase64Url(who.sign(REQUEST_DOMAIN, requestMessage(req)));

const promoteReq = (p: Player, born: Born, parent = p.creature, owner = p.id.playerId) =>
  ({
    v: 1,
    rules: RULES_VERSION,
    kind: 'promote',
    creature: born.record.hash,
    seq: born.record.record.seq + 1,
    prev: born.record.hash,
    owner,
    body: { role: 'child', parent },
  }) satisfies RecordRequest;

const restoreReq = (p: Player, a: Ancestor, from: string) =>
  ({
    v: 1,
    rules: RULES_VERSION,
    kind: 'restore',
    creature: a.creature,
    seq: a.seq + 1,
    prev: a.hash,
    owner: p.id.playerId,
    body: {
      from,
      activeMs: a.activeMs,
      biomass: a.biomass,
      energy: a.energy,
      health: a.health,
      cooldownUntilMs: a.cooldownUntilMs,
    },
  }) satisfies RecordRequest;

/** Promotes `born` and moves the player's connection to the child. */
async function promote(p: Player, born: Born) {
  p.c.send({ t: 'promote', request: promoteReq(p, born), sig: signed(p.id, promoteReq(p, born)) });
  const msg = await nextOf(p.c, 'promoted');
  p.creature = msg.life.creature;
  p.ticks = 0;
  p.activeMs = msg.life.activeMs;
  p.lifespan = msg.life.lifespanMs;
  return msg;
}

async function restore(p: Player, a: Ancestor, from: string) {
  const req = restoreReq(p, a, from);
  p.c.send({ t: 'restore', request: req, sig: signed(p.id, req) });
  const msg = await nextOf(p.c, 'restored');
  p.creature = msg.life.creature;
  p.ticks = 0;
  p.activeMs = msg.life.activeMs;
  p.lifespan = msg.life.lifespanMs;
  return msg;
}

/** Sends a request and returns the refusal reason. */
async function refusal(p: Player, msg: ClientMsg & { t: 'promote' | 'restore' }): Promise<string> {
  p.c.send(msg);
  return (await nextOf(p.c, 'refused')).reason;
}

const statusOf = async (creature: string) =>
  (await sql<{ status: string }>('SELECT status FROM creatures WHERE id = ?', creature))[0]?.status;

/** Plays the rest of the creature's life in one report: old age ends it on the authority's clock. */
async function growOld(p: Player) {
  advance(p.lifespan);
  p.ticks += ticksFor(p.lifespan);
  report(p.c, p.ticks, CALM);
  const died = await nextOf(p.c, 'died');
  expect(died.cause).toBe('old-age');
  return died;
}

async function die(p: Player): Promise<FallbackInfo | undefined> {
  p.c.send({ t: 'death', cause: 'toxin', ticks: p.ticks });
  return (await nextOf(p.c, 'died')).fallback;
}

describe('promote', () => {
  it('makes the child active, freezes the parent and credits the child from then on', async () => {
    const a = await adult();
    const g = a.creature;
    const born = await breed(a);
    const before = await rowsWritten();
    const promoted = await promote(a, born);
    const rows = (await rowsWritten()) - before;
    console.log(`promote rows written: ${rows}`);
    expect(rows).toBeLessThanOrEqual(6);

    expect(promoted.life.creature).toBe(born.record.hash);
    expect(promoted.life.activeMs).toBe(0);
    expect(promoted.parent?.record).toMatchObject({
      kind: 'promote',
      creature: g,
      body: { role: 'parent', child: born.record.hash },
    });
    expect(promoted.parent?.record.body.activeMs).toBeGreaterThan(0);
    expect(await statusOf(g)).toBe('checkpoint');
    expect(await statusOf(born.record.hash)).toBe('active');

    // The connection now plays the child: its clock starts from zero.
    const active = await play(a, 5_000);
    expect(active).toBeGreaterThan(0);
    expect(active).toBeLessThanOrEqual(5_000);
  });

  it('refuses a bad signature, someone else’s child, a stale prev and a stranger as parent', async () => {
    const [a, other] = [await adult(), await adult()];
    const born = await breed(a);
    const req = promoteReq(a, born);
    const unsigned = { t: 'promote', request: req, sig: signed(other.id, req) } as const;
    expect(await refusal(a, unsigned)).toBe('bad-owner-signature');

    const theirs = promoteReq(other, born);
    expect(
      await refusal(other, { t: 'promote', request: theirs, sig: signed(other.id, theirs) }),
    ).toBe('wrong-owner');
    const asMe = promoteReq(a, born, a.creature, other.id.playerId);
    expect(await refusal(a, { t: 'promote', request: asMe, sig: signed(a.id, asMe) })).toBe(
      'wrong-owner',
    );

    const stale = { ...req, prev: '0'.repeat(64) };
    expect(await refusal(a, { t: 'promote', request: stale, sig: signed(a.id, stale) })).toBe(
      'conflict',
    );
    const stranger = promoteReq(a, born, other.creature);
    expect(await refusal(a, { t: 'promote', request: stranger, sig: signed(a.id, stranger) })).toBe(
      'bad-parent',
    );
    expect(await statusOf(born.record.hash)).toBe('pending');
    expect(await statusOf(a.creature)).toBe('active');
  });

  it('is idempotent: a second promote returns the same record and changes nothing', async () => {
    const a = await adult();
    const born = await breed(a);
    const first = await promote(a, born);
    const rows = await rowsWritten();
    a.c.send({
      t: 'promote',
      request: promoteReq({ ...a, creature: first.parent?.record.creature ?? '' }, born),
      sig: signed(a.id, promoteReq({ ...a, creature: first.parent?.record.creature ?? '' }, born)),
    });
    const again = await nextOf(a.c, 'promoted');
    expect(again.parent?.hash).toBe(first.parent?.hash);
    expect(await rowsWritten()).toBe(rows);
    // Still the same life clock: the repeat did not rewind the child.
    const active = await play(a, 2_000);
    expect(active).toBeGreaterThan(0);
  });

  it('only links a parent that already died', async () => {
    const a = await adult();
    const g = a.creature;
    const born = await breed(a);
    await die(a);
    a.c.send({
      t: 'promote',
      request: promoteReq({ ...a, creature: g }, born, g),
      sig: signed(a.id, promoteReq(a, born, g)),
    });
    const promoted = await nextOf(a.c, 'promoted');
    expect(promoted.parent).toBeNull();
    expect(await statusOf(g)).toBe('dead');
    expect(await statusOf(born.record.hash)).toBe('active');
    expect(
      (
        await sql<{ chain_parent: string }>(
          'SELECT chain_parent FROM creatures WHERE id = ?',
          born.record.hash,
        )
      )[0]?.chain_parent,
    ).toBe(g);
  });
});

describe('fallback', () => {
  it('names nothing, the pending child, the ancestor, or both', async () => {
    const solo = await adult();
    expect(await die(solo)).toEqual({ pending: false, ancestor: null });

    const withChild = await adult();
    await breed(withChild);
    expect(await die(withChild)).toEqual({ pending: true, ancestor: null });

    const a = await adult();
    const g = a.creature;
    await promote(a, await breed(a));
    await play(a, 12_000);
    const onlyAncestor = await die(a);
    expect(onlyAncestor?.pending).toBe(false);
    expect(onlyAncestor?.ancestor?.creature).toBe(g);

    const both = await adult();
    const root = both.creature;
    await promote(both, await breed(both));
    await play(both, 12_000);
    await breed(both);
    const fallback = await die(both);
    expect(fallback?.pending).toBe(true);
    expect(fallback?.ancestor?.creature).toBe(root);
  });

  it('arrives at hello when no creature is active', async () => {
    const a = await adult();
    const g = a.creature;
    await promote(a, await breed(a));
    await die(a);
    a.c.ws.close(1000, 'bye');
    await a.c.closed;
    const back = await login(a.id);
    expect(back.life.life).toBeNull();
    expect(back.life.fallback?.ancestor?.creature).toBe(g);
    expect(back.life.fallback?.pending).toBe(false);
  });
});

describe('restore and old age', () => {
  it('walks the chain: each ancestor plays only the life it had left', async () => {
    const a = await adult();
    const g = a.creature;
    const c1 = (await promote(a, await breed(a))).life.creature;
    await play(a, 12_000);
    const c2 = (await promote(a, await breed(a))).life.creature;

    const afterC2 = (await growOld(a)).fallback;
    expect(afterC2?.ancestor?.creature).toBe(c1);
    const frozen = afterC2?.ancestor as Ancestor;
    const headsBefore = await sql<{ hash: string; seq: number }>(
      'SELECT hash, seq FROM records WHERE creature = ? ORDER BY seq',
      c1,
    );

    const restored = await restore(a, frozen, c2);
    expect(restored.life.activeMs).toBe(frozen.activeMs);
    expect(await statusOf(c1)).toBe('active');
    // Earlier records are untouched.
    const headsAfter = await sql<{ hash: string; seq: number }>(
      'SELECT hash, seq FROM records WHERE creature = ? ORDER BY seq',
      c1,
    );
    expect(headsAfter.slice(0, headsBefore.length)).toEqual(headsBefore);

    // Only the remaining life is played.
    const left = a.lifespan - a.activeMs;
    await play(a, Math.min(1000, left - 1));
    const afterC1 = (await growOld(a)).fallback;
    expect(afterC1?.ancestor?.creature).toBe(g);

    await restore(a, afterC1?.ancestor as Ancestor, c1);
    const afterG = (await growOld(a)).fallback;
    expect(afterG).toEqual({ pending: false, ancestor: null });

    // Nothing survives: genesis is allowed again, and history names each ending.
    a.c.send({ t: 'history' });
    const history = await nextOf(a.c, 'history');
    expect(history.lives.map((l) => l.cause)).toEqual(['old-age', 'old-age', 'old-age']);
    expect(history.lives.map((l) => l.creature).sort()).toEqual([c2, c1, g].sort());
    const hatched = await hatch(a.c, a.id);
    expect(hatched.record.record.kind).toBe('genesis');
  });

  it('skips an ancestor with too little life left and ends it', async () => {
    const a = await adult();
    const g = a.creature;
    await promote(a, await breed(a));
    await play(a, 12_000);
    const c1 = a.creature;
    // C1 is close to the end of its life when it hands over.
    await play(a, a.lifespan - a.activeMs - 300);
    const born = await breed(a).catch(() => null);
    if (!born) throw new Error('could not mate near the end of life');
    await promote(a, born);
    const fallback = await die(a);
    expect(fallback?.ancestor?.creature).toBe(g);
    expect(await statusOf(c1)).toBe('dead');
    const death = await sql<{ json: string }>(
      "SELECT json FROM records WHERE creature = ? AND kind = 'death'",
      c1,
    );
    expect(JSON.parse(death[0]?.json ?? '{}').body.cause).toBe('old-age');
  });

  it('refuses a restore that is not the nearest ancestor or does not match its saved condition', async () => {
    const a = await adult();
    const g = a.creature;
    await promote(a, await breed(a));
    await play(a, 12_000);
    const c1 = a.creature;
    // While C1 lives, the ancestor G cannot come back.
    const frozen = (await die(a))?.ancestor as Ancestor;
    expect(frozen.creature).toBe(g);

    const wrongBody = {
      ...restoreReq(a, frozen, c1),
      body: { ...restoreReq(a, frozen, c1).body, biomass: frozen.biomass + 1 },
    };
    expect(
      await refusal(a, { t: 'restore', request: wrongBody, sig: signed(a.id, wrongBody) }),
    ).toBe('condition-mismatch');
    const stale = { ...restoreReq(a, frozen, c1), prev: '1'.repeat(64) };
    expect(await refusal(a, { t: 'restore', request: stale, sig: signed(a.id, stale) })).toBe(
      'conflict',
    );
    const elsewhere = restoreReq(a, frozen, g);
    expect(
      await refusal(a, { t: 'restore', request: elsewhere, sig: signed(a.id, elsewhere) }),
    ).toBe('not-nearest');
    const onDead = restoreReq(a, { ...frozen, creature: c1, seq: 9 }, c1);
    expect(await refusal(a, { t: 'restore', request: onDead, sig: signed(a.id, onDead) })).toBe(
      'dead',
    );
    expect(await statusOf(g)).toBe('checkpoint');

    // Then it comes back, and a second restore while it is active is refused.
    const rows = await rowsWritten();
    await restore(a, frozen, c1);
    console.log(`restore rows written: ${(await rowsWritten()) - rows}`);
    expect((await rowsWritten()) - rows).toBeLessThanOrEqual(3);
    const again = restoreReq(a, { ...frozen, seq: frozen.seq + 1, hash: 'f'.repeat(64) }, c1);
    expect(await refusal(a, { t: 'restore', request: again, sig: signed(a.id, again) })).toBe(
      'status:active',
    );
  });
});

describe('genesis gating', () => {
  it('refuses a new genesis while a creature survives, without spending a hatch', async () => {
    const a = await adult();
    await breed(a);
    await die(a);
    const hatches = () =>
      sql<{ hatches: number }>('SELECT hatches FROM players WHERE id = ?', a.id.playerId);
    const before = await hatches();
    a.c.send(genesisRequest(a.id));
    expect((await nextOf(a.c, 'refused')).reason).toBe('has-lineage');
    expect(await hatches()).toEqual(before);
  });
});

describe('lineage', () => {
  it('lists the player’s creatures and a pedigree that names no other player', async () => {
    const a = await adult();
    const g = a.creature;
    const born = await breed(a);
    const c1 = (await promote(a, born)).life.creature;
    a.c.send({ t: 'lineage' });
    const msg = await nextOf(a.c, 'lineage');
    const byId = new Map(msg.creatures.map((c) => [c.creature, c]));
    expect(byId.get(g)?.status).toBe('checkpoint');
    expect(byId.get(c1)).toMatchObject({ status: 'active', generation: 1, chainParent: g });
    expect(msg.pedigree.length).toBeLessThanOrEqual(64);
    const child = msg.pedigree.find((n) => n.id === c1);
    expect(child?.parents).toHaveLength(2);
    expect(child?.parents).toContain(g);
    const text = JSON.stringify(msg);
    const others = await sql<{ id: string }>('SELECT id FROM players WHERE id != ?', a.id.playerId);
    for (const o of others) expect(text).not.toContain(o.id);
    expect(text.length).toBeLessThan(98_304);
  });
});
