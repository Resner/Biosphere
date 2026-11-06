import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { type Genome, genomeFromBase64url, genomeHash } from '../src/genome/codec';
import { buildCreature } from '../src/genome/stats';
import { LIVE_SCALES, matureBiomassOf, reachAt, vitalsCap } from '../src/ledger/gates';
import { type Identity, toBase64Url } from '../src/ledger/identity';
import { type MateAsk, signMateAsk } from '../src/ledger/mating';
import type { ProofBundle } from '../src/ledger/proof';
import {
  type AuthorityKey,
  PROOF_MAX_BYTES,
  PROOF_MAX_CREATURES,
  parseFightProof,
  parseProofBundle,
} from '../src/ledger/proof';
import {
  type PubKey,
  REQUEST_DOMAIN,
  type RecordRequest,
  requestMessage,
  type StoredRecord,
} from '../src/ledger/record';
import { verifyLineage } from '../src/ledger/verify';
import { verifyEncounter } from '../src/net/encounter-verify';
import { type Ancestor, type Born, genomeRefOf } from '../src/net/protocol';
import { RULES_VERSION, TICK_HZ } from '../src/sim/rules';
import {
  advance,
  authority,
  firstSeenAgo,
  join,
  killB,
  lifeOn,
  lockIn,
  NEAR,
  type Player,
  rehatch,
  setEnv,
  snap,
  useFightHub,
} from './fight-test-kit';
import {
  bear,
  checkpoint,
  die,
  hatch as hatchInLedger,
  mated,
  must,
  mustPromote,
  newPlayer,
  RULE,
  restoreRequest,
  sign,
  step,
} from './ledger-test-kit';
import { proofBundle } from './proof';
import { closeSockets, freshNonce, nextOf, publish, report, sql } from './test-hub';

// M9 T7: proof bundles and fight proofs, served from the ledger alone while every player is
// offline (ADR 0055): `GET /v1/proof/<creature>` and `GET /v1/fight/<enc>`.

useFightHub();

const BASE = 'https://authority.test';
const ORIGIN = 'https://resner.github.io';
const get = (path: string) =>
  exports.default.fetch(`${BASE}${path}`, { headers: { Origin: ORIGIN } });

/** RPCs that reached the object's proof and fight reads. */
const reads = () => authority((o) => o.proofReads);

/** A player's creature as the test drives it: its genome and the reports it sends. */
interface Grower extends Player {
  genome: Genome;
}

const genomeText = (p: Player) => authority((o) => must(o.ledger.head(p.creature)).genome);

async function grower(p: Player): Promise<Grower> {
  const genome = genomeFromBase64url(await genomeText(p));
  if (!genome) throw new Error('genome does not decode');
  return { ...p, genome };
}

/**
 * Plays 10 s at a time, reporting a body that grows at 90% of the fastest rate its genome allows,
 * until it holds `target` hundredths, with energy at 90% and health full: honest play.
 */
async function growTo(p: Grower, target: number): Promise<void> {
  const growth = buildCreature(p.genome).phys.growth;
  for (let i = 0; i < 400; i++) {
    const life = must(await lifeOn(p));
    if (life.biomass >= target) return;
    await advance(10_000);
    p.ticks += 10 * TICK_HZ;
    const biomass = Math.min(target, reachAt(life.biomass, growth, 9_000) - 100);
    const cap = vitalsCap(biomass);
    report(p.c, p.ticks, { biomass, energy: Math.floor(cap.energy * 0.9), health: cap.health });
    await nextOf(p.c, 'ack');
  }
  throw new Error(`never grew to ${target}`);
}

const signed = (who: Identity, req: RecordRequest) =>
  toBase64Url(who.sign(REQUEST_DOMAIN, requestMessage(req)));

const askOf = (from: Player, to: Player, nonce: string): MateAsk =>
  signMateAsk(from.id, {
    creature: from.creature,
    partner: to.id.playerId,
    partnerCreature: to.creature,
    nonce,
  });

/** A courts B, B accepts, the round comes out: both hold their pending child. */
async function breed(a: Player, b: Player): Promise<[Born, Born]> {
  const askA = askOf(a, b, freshNonce());
  a.c.send({ t: 'court', ask: askA });
  await nextOf(b.c, 'invite');
  b.c.send({ t: 'accept', ask: askOf(b, a, askA.nonce) });
  const [ma] = await Promise.all([nextOf(a.c, 'mating'), nextOf(b.c, 'mating')]);
  await publish(ma.commit.commitment.round);
  return Promise.all([nextOf(a.c, 'born'), nextOf(b.c, 'born')]);
}

async function promote(p: Grower, born: Born): Promise<Grower> {
  const request: RecordRequest = {
    v: 1,
    rules: RULES_VERSION,
    kind: 'promote',
    creature: born.record.hash,
    seq: born.record.record.seq + 1,
    prev: born.record.hash,
    owner: p.id.playerId,
    body: { role: 'child', parent: p.creature },
  };
  p.c.send({ t: 'promote', request, sig: signed(p.id, request) });
  const { life } = await nextOf(p.c, 'promoted');
  const child = await grower({ ...p, creature: life.creature, ticks: 0 });
  return { ...child, ref: genomeRefOf(genomeHash(child.genome)) };
}

async function restore(p: Player, a: Ancestor, from: string): Promise<void> {
  const request: RecordRequest = {
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
  };
  p.c.send({ t: 'restore', request, sig: signed(p.id, request) });
  await nextOf(p.c, 'restored');
}

/** The snapshot claim of a player's creature as the object holds it: its real size. */
const sizeOf = async (p: Player) => must(await lifeOn(p)).biomass / 100;

const chainOf = (creature: string) => authority((o) => o.ledger.chain(creature));

/** Rows in every table but the usage meter's, and the ledger's write counter. */
const footprint = async () => ({
  written: await authority((o) => o.ledger.rowsWritten),
  rows: await sql<{ n: number }>(
    `SELECT (SELECT COUNT(*) FROM records) + (SELECT COUNT(*) FROM creatures)
      + (SELECT COUNT(*) FROM flags) + (SELECT COUNT(*) FROM keys) + (SELECT COUNT(*) FROM beacons)
      + (SELECT COUNT(*) FROM commitments) + (SELECT COUNT(*) FROM encounters)
      + (SELECT COUNT(*) FROM players) AS n`,
  ),
});

/** A held creature's records in the bundle (a first record names no creature: its hash is the id). */
const recordsIn = (bundle: ProofBundle, id: string) =>
  bundle.records.filter((r) => r.record.creature === id || (r.record.seq === 0 && r.hash === id));

const keysOf = (keys: readonly AuthorityKey[]): PubKey[] =>
  keys.map((k) => ({ id: k.id, publicKey: k.publicKey }));

/**
 * The history of the lineage fixture, made through the hub: A0 and B0 hatch, grow and mate; A
 * promotes A1; A1 kills B0, eating B1's egg; A1 dies of a toxin; A restores A0.
 */
async function history() {
  await setEnv(true);
  const pa = await join();
  const pb = await join();
  let a = await grower(await rehatch(pa));
  const b = await grower(await rehatch(pb));
  for (const p of [a, b]) await firstSeenAgo(p);
  for (const p of [a, b]) await growTo(p, Math.ceil(matureBiomassOf(p.genome, LIVE_SCALES) * 1.02));
  const a0 = a.creature;
  const b0 = b.creature;
  const [bornA, bornB] = await breed(a, b);
  a = await promote(a, bornA);
  const a1 = a.creature;
  // Past A1's spawn protection, then the fight: B0 at 1 hp, carrying B1 as an egg.
  await growTo(a, Math.ceil(must(await lifeOn(a)).biomass * 1.1));
  await advance(16_000);
  const [start] = await lockIn(
    a,
    b,
    snap(b, ...NEAR.b, { health: 0.01, egg: true, biomass: await sizeOf(b) }),
    snap(a, ...NEAR.a, { health: 1, biomass: await sizeOf(a) }),
  );
  await killB(a, b, start);
  await advance(5_000);
  a.ticks += 5 * TICK_HZ;
  a.c.send({ t: 'death', cause: 'toxin', ticks: a.ticks });
  const died = await nextOf(a.c, 'died');
  const ancestor = must(died.fallback?.ancestor);
  expect(ancestor.creature).toBe(a0);
  await restore(a, ancestor, a1);
  await closeSockets();
  return { a0, b0, a1, b1: bornB.record.hash, enc: start.enc };
}

describe('GET /v1/proof and /v1/fight, with every socket closed', () => {
  it('serves a bundle of the hub’s own history that verifies, each ancestor cut at its tie', async () => {
    const h = await history();
    const before = await footprint();
    const calls = await reads();

    const res = await get(`/v1/proof/${h.a1}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    // A1 is dead, so its bundle never changes.
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=86400');
    const bundle = parseProofBundle(await res.text());
    if (!bundle) throw new Error('the bundle does not parse');

    // The subject, then its parents by id; nobody else's creatures (B1 is A1's sibling, not an ancestor).
    expect(bundle.subject).toBe(h.a1);
    expect(bundle.creatures.map((c) => c.id)).toEqual([h.a1, ...[h.a0, h.b0].sort()]);
    expect(bundle.more).toEqual([]);
    expect(bundle.world).toMatchObject({ epoch: 3, rules: RULES_VERSION });
    expect(bundle.world.scales.mating).toBe(0.01);
    expect(bundle.settlements.map((s) => s.settlement.enc)).toEqual([h.enc]);

    const recordsOf = (id: string) => recordsIn(bundle, id);
    // The subject's whole chain: birth, promote, encounter, death.
    expect(recordsOf(h.a1).map((r) => r.hash)).toEqual((await chainOf(h.a1)).map((r) => r.hash));
    // A0 up to its parent promote naming A1 (its restore comes later); B0 up to its mate-commit.
    const cut = async (id: string, tie: (s: StoredRecord) => boolean) => {
      const chain = await chainOf(id);
      const end = chain.findIndex(tie);
      expect(end).toBeGreaterThan(0);
      expect(end).toBeLessThan(chain.length - 1);
      expect(recordsOf(id).map((r) => r.hash)).toEqual(chain.slice(0, end + 1).map((r) => r.hash));
    };
    await cut(h.a0, (s) => s.record.kind === 'promote' && s.record.body.child === h.a1);
    await cut(h.b0, (s) => s.record.kind === 'mate-commit');

    const report = verifyLineage(bundle);
    expect(report.problems).toEqual([]);
    expect(report).toMatchObject({ held: 3, toGenesis: true, generations: 1, scaled: true });

    // Reads only: nothing but the usage meter is written.
    expect(await footprint()).toEqual(before);
    expect(await reads()).toBe(calls + 1);

    // A second request is answered from the edge cache: it never reaches the object.
    const again = await get(`/v1/proof/${h.a1}`);
    expect(again.status).toBe(200);
    expect(again.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(parseProofBundle(await again.text())?.subject).toBe(h.a1);
    expect(await reads()).toBe(calls + 1);

    // The fight's log replays to its settlement.
    const fight = await get(`/v1/fight/${h.enc}`);
    expect(fight.status).toBe(200);
    expect(fight.headers.get('Cache-Control')).toBe('public, max-age=86400');
    const proof = parseFightProof(await fight.text());
    if (!proof?.log) throw new Error('the fight proof has no log');
    expect(verifyEncounter(proof.settlement, proof.log, keysOf(bundle.keys))).toEqual([]);
    expect(await footprint()).toEqual(before);

    // A creature still alive (A0, restored) is cached for a minute only, and it holds A0's whole chain.
    const live = await get(`/v1/proof/${h.a0}`);
    expect(live.headers.get('Cache-Control')).toBe('public, max-age=60');
    const own = parseProofBundle(await live.text());
    expect(own?.records.map((r) => r.hash)).toEqual((await chainOf(h.a0)).map((r) => r.hash));
    expect(own?.creatures.map((c) => c.id)).toEqual([h.a0]);
  });

  it('answers 400 for a malformed id, 404 for an unknown one and 503 past 80% of the budget', async () => {
    for (const path of ['/v1/proof/xyz', `/v1/proof/${'A'.repeat(64)}`, '/v1/fight/12']) {
      const res = await get(path);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'id' });
    }
    const unknown = `${'e'.repeat(63)}1`;
    for (const path of [`/v1/proof/${unknown}`, `/v1/fight/${unknown}`]) {
      const res = await get(path);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not-found' });
    }
    const foreign = await exports.default.fetch(`${BASE}/v1/proof/${unknown}`, {
      headers: { Origin: 'https://evil.example' },
    });
    expect(foreign.status).toBe(403);

    // A budget of 1: the request that counts past 0.8 of it is refused.
    await authority((o) => {
      (o.env as unknown as Record<string, string>).DAILY_REQUEST_BUDGET = '1';
    });
    try {
      const busy = await get(`/v1/proof/${'d'.repeat(63)}2`);
      expect(busy.status).toBe(503);
      expect(busy.headers.get('Retry-After')).toBe('600');
      expect(await busy.json()).toEqual({ error: 'busy' });
      expect((await get(`/v1/fight/${'d'.repeat(63)}3`)).status).toBe(503);
    } finally {
      await authority((o) => {
        delete (o.env as unknown as Record<string, string | undefined>).DAILY_REQUEST_BUDGET;
      });
    }
  });
});

describe('proofBundle caps', () => {
  /**
   * A line of 36 creatures of player P, each born of the one before and a fresh genesis partner,
   * and promoted: the last has 70 ancestors.
   */
  async function pedigree() {
    const P = await newPlayer();
    const partners = await Promise.all(Array.from({ length: 35 }, () => newPlayer()));
    return authority((o) => {
      let line = hatchInLedger(o.ledger, P.playerId);
      line = step(o.ledger, checkpoint(line, 5_000));
      for (const Q of partners) {
        const partner = step(o.ledger, checkpoint(hatchInLedger(o.ledger, Q.playerId), 5_000));
        const [child] = bear(o.ledger, mated(o.ledger, line, partner));
        mustPromote(o.ledger, P, child, line.id);
        line = must(o.ledger.head(child.id));
      }
      return line.id;
    });
  }

  it('stops at 64 creatures, naming the parents it left out', async () => {
    const subject = await pedigree();
    const bundle = await authority((o) => must(proofBundle(o, subject, o.clock.now())));
    expect(bundle.creatures).toHaveLength(PROOF_MAX_CREATURES);
    expect(new TextEncoder().encode(JSON.stringify(bundle)).length).toBeLessThanOrEqual(
      PROOF_MAX_BYTES,
    );
    const held = new Set(bundle.creatures.map((c) => c.id));
    const parents = (id: string) => {
      const first = recordsIn(bundle, id)[0];
      return first?.record.kind === 'birth' ? (first.record.body.parents as string[]) : [];
    };
    const left = [...held].flatMap(parents).filter((id) => !held.has(id));
    expect(bundle.more.length).toBeGreaterThan(0);
    expect([...bundle.more].sort()).toEqual([...new Set(left)].sort());
    // Nearest first: every held ancestor is no further back than any one left out.
    expect(bundle.creatures[0]?.id).toBe(subject);
  });

  it('stops before the byte cap', async () => {
    const subject = await pedigree();
    const bundle = await authority((o) =>
      must(proofBundle(o, subject, o.clock.now(), { creatures: 64, bytes: 30_000 })),
    );
    expect(new TextEncoder().encode(JSON.stringify(bundle)).length).toBeLessThanOrEqual(30_000);
    expect(bundle.creatures.length).toBeLessThan(PROOF_MAX_CREATURES);
    expect(bundle.creatures.length).toBeGreaterThan(1);
    expect(bundle.more.length).toBeGreaterThan(0);
  });

  it('cuts a chain parent at its promote, though it was restored and died later', async () => {
    const [A, B] = [await newPlayer(), await newPlayer()];
    const child = await authority((o) => {
      const a = step(o.ledger, checkpoint(hatchInLedger(o.ledger, A.playerId), 5_000));
      const b = step(o.ledger, checkpoint(hatchInLedger(o.ledger, B.playerId), 5_000));
      const [c] = bear(o.ledger, mated(o.ledger, a, b));
      mustPromote(o.ledger, A, c, a.id);
      die(o.ledger, must(o.ledger.head(c.id)));
      const request = restoreRequest(must(o.ledger.head(a.id)), c.id);
      expect(o.ledger.restore(request, sign(A, request), RULE).ok).toBe(true);
      die(o.ledger, must(o.ledger.head(a.id)));
      return { id: c.id, parent: a.id };
    });
    const bundle = await authority((o) => must(proofBundle(o, child.id, o.clock.now())));
    const mine = recordsIn(bundle, child.parent);
    expect(mine.at(-1)?.record).toMatchObject({ kind: 'promote', body: { child: child.id } });
    expect((await chainOf(child.parent)).map((r) => r.record.kind).slice(-2)).toEqual([
      'restore',
      'death',
    ]);
  });

  it('cuts a chain parent that was already dead at its death', async () => {
    const [A, B] = [await newPlayer(), await newPlayer()];
    const child = await authority((o) => {
      const a = step(o.ledger, checkpoint(hatchInLedger(o.ledger, A.playerId), 5_000));
      const b = step(o.ledger, checkpoint(hatchInLedger(o.ledger, B.playerId), 5_000));
      const [c] = bear(o.ledger, mated(o.ledger, a, b));
      die(o.ledger, must(o.ledger.head(a.id)));
      mustPromote(o.ledger, A, c, a.id);
      return { id: c.id, parent: a.id };
    });
    const bundle = await authority((o) => must(proofBundle(o, child.id, o.clock.now())));
    const mine = recordsIn(bundle, child.parent);
    expect(mine.at(-1)?.record.kind).toBe('death');
    expect(mine).toHaveLength((await chainOf(child.parent)).length);
  });
});
