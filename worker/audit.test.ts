import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { CLOCK_SLACK_MS, reachAt, vitalsCap } from '../src/ledger/gates';
import { RULES, TICK_HZ } from '../src/sim/rules';
import { FLAG_KIND_NAMES } from './audit';
import {
  advance,
  authority,
  clock,
  firstSeenAgo,
  hatched,
  join,
  lifeOn,
  lockIn,
  NEAR,
  type Player,
  pair,
  refusal,
  setEnv,
  snap,
  useFightHub,
} from './fight-test-kit';
import { must } from './ledger-test-kit';
import { breed, court, promoteRequest, signed } from './lineage-test-kit';
import { genesisRequest, nextOf, publish, report, sql } from './test-hub';

// M9 T8: the authority's bounds hold per record interval, as the verifier checks them, and its
// audit flags each attack once and counts the flags at `GET /v1/audit` (ADR 0055).

useFightHub();

const kindsOf = (creature: string) =>
  authority((o) => o.ledger.audit.flags(creature).map((f) => f.kind));

/** Plays `ms` of honest time and reports it: the starter's size, energy at 90%, health full. */
async function play(p: Player, ms: number): Promise<void> {
  await advance(ms);
  p.ticks += (ms * TICK_HZ) / 1000;
  const biomass = Math.floor(RULES.starter.biomass * 100);
  const cap = vitalsCap(biomass);
  report(p.c, p.ticks, { biomass, energy: Math.floor(cap.energy * 0.9), health: cap.health });
  await nextOf(p.c, 'ack');
}

/** Two players of a test world (maturity in seconds), both mature and rested. */
async function mates(): Promise<[Player, Player]> {
  await setEnv(true);
  const [a, b] = await pair();
  for (const p of [a, b]) await play(p, 10_000);
  return [a, b];
}

describe('the bounds per record interval', () => {
  it('grows a creature no further from 20 reports in 10 s than one report would take it', async () => {
    const p = await hatched();
    const start = must(await lifeOn(p));
    const greedy = { biomass: Math.floor(start.maxBiomass * 100), energy: 1, health: 1 };
    // A fresh rate window: 20 messages in 10 s are within the socket's limit.
    await advance(10_000);
    for (let i = 0; i < 20; i++) {
      await advance(500);
      p.ticks += TICK_HZ / 2;
      report(p.c, p.ticks, greedy);
    }
    for (let i = 0; i < 20; i++) await nextOf(p.c, 'ack');
    const life = must(await lifeOn(p));
    expect(life.activeMs).toBe(10_000);
    // One reach from the binding over the 10 s, with its one slack: not twenty slacks.
    expect(life.biomass).toBe(reachAt(start.boundBiomass, start.growth, 10_000));
    expect(await kindsOf(p.creature)).toEqual(['growth-too-fast']);
  });

  it('credits 1 min + 2 s for 10 min of ticks claimed after 1 min, and flags clock-too-fast once', async () => {
    const p = await hatched();
    await advance(60_000);
    report(p.c, 600 * TICK_HZ);
    expect(await nextOf(p.c, 'ack')).toMatchObject({ activeMs: 60_000 + CLOCK_SLACK_MS });
    // Claimed again, and again: still one flag.
    for (let i = 2; i <= 3; i++) {
      await advance(1_000);
      report(p.c, i * 600 * TICK_HZ);
      await nextOf(p.c, 'ack');
    }
    expect(await kindsOf(p.creature)).toEqual(['clock-too-fast']);
  });

  it('credits honest ticks without a flag', async () => {
    const p = await hatched();
    for (let i = 0; i < 4; i++) await play(p, 30_000);
    expect(must(await lifeOn(p)).activeMs).toBe(120_000);
    expect(await kindsOf(p.creature)).toEqual([]);
  });

  it('after a mating, credits the next report only the time since the mate-commit', async () => {
    const [a, b] = await mates();
    // 20 s of play go unreported before the mating is written.
    await advance(20_000);
    a.ticks += 20 * TICK_HZ;
    const { ma } = await court(a, b);
    const record = ma.record.record;
    await advance(5_000);
    a.ticks += 5 * TICK_HZ;
    report(a.c, a.ticks);
    const ack = await nextOf(a.c, 'ack');
    expect(record.t).toBe(clock.t - 5_000);
    expect(ack.activeMs - (record.body.activeMs as number)).toBe(5_000 + CLOCK_SLACK_MS);
  });

  it('clamps a lock-in claim over the wall time since the last record', async () => {
    const [a, b] = await pair();
    // Reports since the binding move nothing the claim's bound counts from.
    a.ticks = 10 * TICK_HZ;
    report(a.c, a.ticks);
    await nextOf(a.c, 'ack');
    const life = must(await lifeOn(a));
    const engagedAt = clock.t;
    const [start] = await lockIn(
      a,
      b,
      undefined,
      snap(a, ...NEAR.a, { biomass: 400, energy: 0.1, health: 0.1 }),
    );
    const fa = must(start.fighters.find((f) => f.player === a.id.playerId));
    expect(Math.round(fa.biomass * 100)).toBe(
      reachAt(life.boundBiomass, life.growth, engagedAt - life.boundT),
    );
  });

  it('refuses a mating under the maturity size, which a test world shortens', async () => {
    const [a, b] = await mates();
    // A body under 60% of its adult size at scale 1.
    await setEnv(false);
    await authority((o) => {
      for (const ws of o.ctx.getWebSockets()) {
        const s = ws.deserializeAttachment() as { phase: string; life?: { matureBiomass: number } };
        if (s.phase === 'active' && s.life) {
          ws.serializeAttachment({ ...s, life: { ...s.life, matureBiomass: 10 ** 9 } });
        }
      }
    });
    a.c.send({ t: 'mate-check', partner: b.id.playerId });
    expect(await nextOf(a.c, 'mate-info')).toMatchObject({ reason: 'not-mature' });
  });
});

describe('each attack leaves its flag once', () => {
  it('a stale promote: a signed promote for a head that has moved on', async () => {
    const [a, b] = await mates();
    const [bornA] = await breed(a, b);
    const accepted = promoteRequest(a, bornA);
    a.c.send({ t: 'promote', request: accepted, sig: signed(a.id, accepted) });
    await nextOf(a.c, 'promoted');
    // Signed for the same head, naming another parent: the child has moved on since.
    const stale = promoteRequest(a, bornA, b.creature);
    for (let i = 0; i < 3; i++) {
      a.c.send({ t: 'promote', request: stale, sig: signed(a.id, stale) });
      await nextOf(a.c, 'refused');
    }
    expect(await kindsOf(bornA.record.hash)).toEqual(['replay']);
    // The accepted request sent again gets its acknowledgement again, and no flag.
    a.c.send({ t: 'promote', request: accepted, sig: signed(a.id, accepted) });
    expect((await nextOf(a.c, 'promoted')).life.creature).toBe(bornA.record.hash);
    expect(await kindsOf(bornA.record.hash)).toEqual(['replay']);
  });

  it('a replayed mate ask', async () => {
    const [a, b] = await mates();
    const { askA, askB, mb } = await court(a, b);
    // The accepting player's acceptance again: the same commitment, no flag.
    b.c.send({ t: 'accept', ask: askB });
    expect((await nextOf(b.c, 'mating')).record.hash).toBe(mb.record.hash);
    for (let i = 0; i < 3; i++) {
      a.c.send({ t: 'court', ask: askA });
      expect((await nextOf(a.c, 'refused')).reason).toBe('used');
    }
    expect(await kindsOf(a.creature)).toEqual(['replay']);
    expect(await kindsOf(b.creature)).toEqual([]);
  });

  it('a replayed genesis ask', async () => {
    const { c, id } = await join();
    await firstSeenAgo({ id });
    const ask = genesisRequest(id);
    c.send(ask);
    const { commit } = await nextOf(c, 'commit');
    await publish(commit.commitment.round);
    const { record } = await nextOf(c, 'genesis');
    const creature = record.hash;
    c.send({ t: 'death', cause: 'toxin', ticks: 0 });
    await nextOf(c, 'died');
    for (let i = 0; i < 3; i++) {
      c.send(ask);
      expect((await nextOf(c, 'refused')).reason).toBe('used');
    }
    expect(await kindsOf(creature)).toEqual(['replay']);
  });

  it('a report beyond the maximum biomass', async () => {
    const p = await hatched();
    const { maxBiomass } = must(await lifeOn(p));
    for (let i = 0; i < 3; i++) {
      await advance(1_000);
      p.ticks += TICK_HZ;
      report(p.c, p.ticks, { biomass: Math.floor(maxBiomass * 200), energy: 1, health: 1 });
      await nextOf(p.c, 'ack');
    }
    // Past the growth reach too, but each kind once.
    expect(await kindsOf(p.creature)).toEqual(['biomass-over-max', 'growth-too-fast']);
  });

  it('an over-claimed lock-in', async () => {
    const [a, b] = await pair();
    const greedy = () => snap(a, ...NEAR.a, { biomass: 400, energy: 0.1, health: 0.1 });
    await lockIn(a, b, undefined, greedy());
    expect(await refusal(a, b, undefined, greedy())).toBe('engage:locked');
    expect(await kindsOf(a.creature)).toEqual(['claim-over']);
  });
});

describe('GET /v1/audit', () => {
  it('counts the flags by kind for the day and since the renewal, with no ids', async () => {
    // Some flags of this test's own: a stray death and an implausible report.
    const p = await hatched();
    report(p.c, 10 ** 6, { biomass: 10 ** 9, energy: 10 ** 9, health: 10 ** 9 });
    await nextOf(p.c, 'ack');
    const before = await authority((o) => o.proofReads);

    const res = await exports.default.fetch('https://authority.test/v1/audit', {
      headers: { Origin: 'https://resner.github.io' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://resner.github.io');
    const text = await res.text();
    const body = JSON.parse(text) as {
      since: number;
      day: Record<string, number>;
      total: Record<string, number>;
    };
    expect(Object.keys(body).sort()).toEqual(['day', 'since', 'total']);
    const [world] = await sql<{ reset_at: number }>('SELECT reset_at FROM world');
    expect(body.since).toBe(world?.reset_at);
    const counts = async (since: number) => {
      const rows = await sql<{ kind: string; n: number }>(
        'SELECT kind, COUNT(*) AS n FROM flags WHERE t >= ? GROUP BY kind',
        since,
      );
      return Object.fromEntries(
        FLAG_KIND_NAMES.map((k) => [k, rows.find((r) => r.kind === k)?.n ?? 0]),
      );
    };
    const now = clock.t;
    expect(body.total).toEqual(await counts(body.since));
    expect(body.day).toEqual(await counts(Math.max(body.since, now - (now % 86_400_000))));
    expect(body.total['growth-too-fast']).toBeGreaterThan(0);
    // No player, creature, request or encounter named.
    const ids = await sql<{ owner: string; creature: string; hash: string }>(
      'SELECT owner, creature, hash FROM flags',
    );
    for (const row of ids) {
      for (const id of [row.owner, row.creature, row.hash].filter((x) => x.length > 0)) {
        expect(text).not.toContain(id);
      }
    }
    expect(await authority((o) => o.proofReads)).toBe(before + 1);

    // Cached at the edge: a second request never reaches the object.
    const again = await exports.default.fetch('https://authority.test/v1/audit');
    expect(again.status).toBe(200);
    expect(JSON.parse(await again.text())).toEqual(body);
    expect(await authority((o) => o.proofReads)).toBe(before + 1);
  });
});
