import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { ProofBundle } from '../src/ledger/proof';
import {
  PROOF_CAPS,
  PROOF_MAX_BYTES,
  PROOF_MAX_CREATURES,
  parseFightProof,
  parseProofBundle,
} from '../src/ledger/proof';
import type { StoredRecord } from '../src/ledger/record';
import { verifyLineage } from '../src/ledger/verify';
import { verifyEncounter } from '../src/net/encounter-verify';
import { RULES_VERSION } from '../src/sim/rules';
import { authority, useFightHub } from './fight-test-kit';
import { history } from './history-kit';
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
import { chainOf, keysOf } from './lineage-test-kit';
import { proofBundle, proofStats, serveProof } from './proof';
import { sql } from './test-hub';

// M9 T7: proof bundles and fight proofs, served from the ledger alone while every player is
// offline (ADR 0055): `GET /v1/proof/<creature>` and `GET /v1/fight/<enc>`.

useFightHub();

const BASE = 'https://authority.test';
const ORIGIN = 'https://resner.github.io';
const get = (path: string) =>
  exports.default.fetch(`${BASE}${path}`, { headers: { Origin: ORIGIN } });

/** RPCs that reached the object's proof and fight reads. */
const reads = () => authority((o) => o.proofReads);

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

describe('GET /v1/proof and /v1/fight, with every socket closed', () => {
  it('serves a bundle of the hub’s own history that verifies, each ancestor cut at its tie', async () => {
    const h = await history();
    const before = await footprint();
    const calls = await reads();

    const res = await get(`/v1/proof/${h.a1}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    // A1 is dead: its flags and attestations can still arrive, so its bundle keeps ten minutes.
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=600');
    const bundle = parseProofBundle(await res.text());
    if (!bundle) throw new Error('the bundle does not parse');

    // The subject, then its parents by id; nobody else's creatures (B1 is A1's sibling, not an ancestor).
    expect(bundle.subject).toBe(h.a1);
    expect(bundle.creatures.map((c) => c.id)).toEqual([h.a1, ...[h.a0, h.b0].sort()]);
    expect(bundle.more).toEqual([]);
    expect(bundle.world).toMatchObject({ epoch: 5, rules: RULES_VERSION });
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
    expect(verifyEncounter(proof.settlement, proof.log, keysOf(bundle))).toEqual([]);
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

  it('assembles a 64-creature pedigree once, whatever the number of candidates it tried', async () => {
    const subject = await pedigree();
    const [bundle, assembled] = await authority((o) => {
      const before = proofStats.assembles;
      const b = must(proofBundle(o, subject, o.clock.now()));
      return [b, proofStats.assembles - before] as const;
    });
    expect(bundle.creatures).toHaveLength(PROOF_MAX_CREATURES);
    expect(assembled).toBe(1);
  });

  it('answers too-big for a subject whose own chain passes the caps, never a bundle that does not parse', async () => {
    const P = await newPlayer();
    const id = await authority((o) => {
      let head = hatchInLedger(o.ledger, P.playerId);
      for (let i = 0; i < 12; i++) head = step(o.ledger, checkpoint(head));
      return head.id;
    });
    const served = (limits: { creatures: number; bytes: number; records: number }) =>
      authority((o) => serveProof(o, id, limits));
    // Records: the chain holds 13.
    expect((await served({ creatures: 64, bytes: PROOF_MAX_BYTES, records: 12 })).status).toBe(413);
    expect((await served({ creatures: 64, bytes: PROOF_MAX_BYTES, records: 13 })).status).toBe(200);
    // Bytes: a limit under the chain's own size.
    expect((await served({ creatures: 64, bytes: 2_000, records: 4_096 })).status).toBe(413);
    expect((await served({ creatures: 64, bytes: PROOF_MAX_BYTES, records: 4_096 })).status).toBe(
      200,
    );
  });

  it('serves 413 too-big over HTTP, cached for a minute, for a chain past the real caps', {
    tags: ['heavy'],
  }, async () => {
    const P = await newPlayer();
    const id = await authority((o) => {
      let head = hatchInLedger(o.ledger, P.playerId);
      for (let i = 0; i < PROOF_CAPS.records; i++) head = step(o.ledger, checkpoint(head));
      return head.id;
    });
    const res = await get(`/v1/proof/${id}`);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'too-big' });
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
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
