import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { speedTest } from '../../tests/heavy';
import {
  bundleOf,
  commit,
  lineageHistory,
  OWNER_SECRETS,
  PLAYERS,
  resign,
  store,
} from '../../tests/lineage-fixture';
import { genomeHash, genomeToBase64url } from '../genome/codec';
import { RULES_VERSION } from '../sim/rules';
import { genesisAskMessage } from './ask';
import type { Canonical } from './canonical';
import { type Beacon, randomnessOf, roundTime } from './drand';
import { commitmentId, genesisFor, genesisRequest } from './genesis';
import { playerIdOf, publicKeyFromSecret, signWithSecret, toBase64Url } from './identity';
import type { ProofBundle } from './proof';
import { type LedgerRecord, REQUEST_DOMAIN, type StoredRecord } from './record';
import { indexBundle, PROBLEM_TEXT, type Problem, verifyLineage } from './verify';
import { verifyOrigin } from './verify-origin';

// M9 T4: the origin family of the lineage verifier. Every genesis and birth is recomputed from its
// committed drand round and its parents, against the golden bundle of the fixture's honest history
// (A1 as subject: its birth, and A0's and B0's geneses).

const GOLDEN = new URL('./__golden__/lineage.json', import.meta.url);
const history = lineageHistory();
const { A0, B0, A1 } = history.ids;
const golden = (): ProofBundle => JSON.parse(readFileSync(GOLDEN, 'utf8')) as ProofBundle;

const at = (creature: string, seq: number | null, code: string): Problem => ({
  creature,
  seq,
  family: 'origin',
  code,
});

/**
 * The origin problems of a tampered bundle, after checking the chain and signature families find
 * nothing: each tamper is re-signed and relinked as a forger holding the key would, so only the
 * origin family can catch it.
 */
function originOnly(b: ProofBundle): Problem[] {
  const { problems } = verifyLineage(b);
  expect(problems.filter((p) => p.family === 'chain' || p.family === 'signature')).toEqual([]);
  return problems.filter((p) => p.family === 'origin');
}

const idOf = (s: StoredRecord) => s.record.creature || s.hash;
const chainIn = (b: ProofBundle, creature: string): StoredRecord[] =>
  b.records.filter((s) => idOf(s) === creature).sort((x, y) => x.record.seq - y.record.seq);

/**
 * Applies `change` to `creature`'s record `seq`, stores it again and relinks every later record of
 * the creature. A change to the first record changes the creature's id, which every later record,
 * the bundle's creature list and (for the subject) the subject follow. Returns the creature's id.
 */
function rechain(
  b: ProofBundle,
  creature: string,
  seq: number,
  change: (r: LedgerRecord) => void,
): string {
  let id = creature;
  let prev = '';
  for (const s of chainIn(b, creature)) {
    if (s.record.seq < seq) {
      prev = s.hash;
      continue;
    }
    const record = structuredClone(s.record);
    if (record.seq === seq) change(record);
    if (record.seq > 0) Object.assign(record, { creature: id, prev });
    const stored = resign(s, record);
    b.records[b.records.indexOf(s)] = stored;
    if (record.seq === 0) id = stored.hash;
    prev = stored.hash;
  }
  for (const c of b.creatures) if (c.id === creature) c.id = id;
  if (b.subject === creature) b.subject = id;
  return id;
}

const firstOf = (b: ProofBundle, creature: string) => chainIn(b, creature)[0] as StoredRecord;

/** `creature`'s genesis made to rest on a fresh commitment: its own, with `change` applied first. */
function recommit(
  b: ProofBundle,
  creature: string,
  change: (c: { data: Canonical; t: number }) => void,
): string {
  const named = firstOf(b, creature).record.body.commit;
  const i = b.commits.findIndex((c) => commitmentId(c.commitment) === named);
  const old = b.commits[i]?.commitment;
  if (!old) throw new Error('no commitment');
  const fields = { data: structuredClone(old.data), t: old.t };
  change(fields);
  const fresh = commit(old.kind, old.owner, fields.data, old.round, fields.t);
  b.commits[i] = fresh;
  // The draw follows the commitment's id, so the genome is drawn again as the authority would.
  const beacon = b.beacons.find((x) => x.round === old.round) as Beacon;
  const genome = genesisFor(randomnessOf(beacon), commitmentId(fresh.commitment));
  const id = rechain(b, creature, 0, (r) => {
    r.body.commit = commitmentId(fresh.commitment);
    r.body.genome = genomeHash(genome);
  });
  for (const c of b.creatures) if (c.id === id) c.genome = genomeToBase64url(genome);
  return id;
}

describe('the origin family on the honest history', () => {
  it('finds nothing in the golden, and reaches genesis one generation back', () => {
    const report = verifyLineage(golden());
    expect(report.problems).toEqual([]);
    expect(report).toMatchObject({ toGenesis: true, generations: 1, unchecked: [] });
  });

  it('reaches genesis at once from a genesis creature', () => {
    const report = verifyLineage(bundleOf(history, A0));
    expect(report.problems.filter((p) => p.family === 'origin')).toEqual([]);
    expect(report).toMatchObject({ toGenesis: true, generations: 0, unchecked: [] });
  });

  it('finds nothing under test scales', () => {
    const scaled = lineageHistory({ lifespan: 0.05, mating: 0.01 });
    const report = verifyLineage(bundleOf(scaled, scaled.ids.A1));
    expect(report.problems.filter((p) => p.family === 'origin')).toEqual([]);
    expect(report.toGenesis).toBe(true);
  });

  it('reports a birth whose parent is left out as unchecked, which is no problem', () => {
    const b = bundleOf(history, A1, [A0]);
    expect(b.more).toEqual([A0]);
    const report = verifyLineage(b);
    expect(report.problems).toEqual([]);
    expect(report).toMatchObject({
      toGenesis: false,
      generations: 0,
      unchecked: [A1],
      missing: [A0],
    });
  });
});

describe('the origin family names each tamper', () => {
  it('a genesis genome hash', () => {
    const b = bundleOf(history, A0);
    const id = rechain(b, A0, 0, (r) => {
      r.body.genome = 'e'.repeat(64);
    });
    // The record is no longer the draw, and the genome text no longer hashes to it.
    expect(originOnly(b)).toEqual([at(id, 0, 'genome-text'), at(id, 0, 'body-mismatch')]);
  });

  it("a beacon's signature, on the genesis and on the birth it decides", () => {
    for (const [creature, round] of [
      [A0, firstOf(golden(), A0).record.body.round],
      [A1, firstOf(golden(), A1).record.body.round],
    ] as const) {
      const b = golden();
      const beacon = b.beacons.find((x) => x.round === round) as Beacon;
      beacon.signature = (beacon.signature[0] === 'a' ? 'b' : 'a') + beacon.signature.slice(1);
      expect(originOnly(b)).toEqual([at(creature, 0, 'bad-beacon')]);
    }
  });

  it("the record's round", () => {
    const b = bundleOf(history, A0);
    const id = rechain(b, A0, 0, (r) => {
      r.body.round = (r.body.round as number) + 1;
    });
    expect(originOnly(b)).toEqual([at(id, 0, 'round-mismatch')]);
  });

  it('a commitment whose round was published before its t (round-not-future)', () => {
    const b = bundleOf(history, A0);
    const round = firstOf(b, A0).record.body.round as number;
    const id = recommit(b, A0, (c) => {
      c.t = roundTime(round);
    });
    expect(originOnly(b)).toEqual([at(id, 0, 'round-not-future')]);
  });

  it('a genesis ask signature', () => {
    const b = bundleOf(history, A0);
    const id = recommit(b, A0, (c) => {
      // Signed by B for A: a well-formed signature that is not A's.
      const ask = c.data as { nonce: string; sig: string };
      ask.sig = toBase64Url(
        signWithSecret(OWNER_SECRETS.B, REQUEST_DOMAIN, genesisAskMessage(PLAYERS.A, ask.nonce)),
      );
    });
    expect(originOnly(b)).toEqual([at(id, 0, 'bad-ask')]);
  });

  it("a birth's slot", () => {
    const b = golden();
    const id = rechain(b, A1, 0, (r) => {
      r.body.slot = 1;
    });
    expect(originOnly(b)).toEqual([at(id, 0, 'slot-mismatch')]);
  });

  it('its parents swapped', () => {
    const b = golden();
    const id = rechain(b, A1, 0, (r) => {
      r.body.parents = [...(r.body.parents as string[])].reverse();
    });
    expect(originOnly(b)).toEqual([at(id, 0, 'parent-mismatch')]);
  });

  it("a parent genome text that doesn't hash to its first record", () => {
    const b = golden();
    const a0 = b.creatures.find((c) => c.id === A0)?.genome as string;
    for (const c of b.creatures) if (c.id === B0) c.genome = a0;
    expect(originOnly(b)).toEqual([at(A1, 0, 'parent-genome'), at(B0, 0, 'genome-text')]);
  });

  it('a mate-commit from another mating', () => {
    const b = golden();
    const other = b.commits.find((c) => c.commitment.kind === 'genesis')?.commitment;
    if (!other) throw new Error('no genesis commitment');
    rechain(b, A0, 3, (r) => {
      r.body.commit = commitmentId(other);
    });
    const mate = chainIn(b, A0)[3] as StoredRecord;
    const id = rechain(b, A1, 0, (r) => {
      r.body.mates = [mate.hash, (r.body.mates as string[])[1] as string];
    });
    expect(originOnly(b)).toEqual([at(id, 0, 'mate-commit-mismatch')]);
  });

  it("a birth's generation", () => {
    const b = golden();
    const id = rechain(b, A1, 0, (r) => {
      r.body.generation = 2;
    });
    expect(originOnly(b)).toEqual([at(id, 0, 'generation-mismatch')]);
  });

  it("a mate-commit's generation that is not its creature's", () => {
    const b = golden();
    rechain(b, A0, 3, (r) => {
      r.body.generation = 1;
    });
    const mate = chainIn(b, A0)[3] as StoredRecord;
    const id = rechain(b, A1, 0, (r) => {
      r.body.mates = [mate.hash, (r.body.mates as string[])[1] as string];
      r.body.generation = 2;
    });
    expect(originOnly(b)).toEqual([at(id, 0, 'mate-generation')]);
  });

  it('a parent prefix that stops before the mate-commit the birth names', () => {
    const b = golden();
    const last = chainIn(b, B0).at(-1) as StoredRecord;
    expect(last.record.kind).toBe('mate-commit');
    b.records.splice(b.records.indexOf(last), 1);
    expect(originOnly(b)).toEqual([at(A1, 0, 'mate-not-held')]);
  });

  it('a parent that is neither held nor listed as left out', () => {
    const b = golden();
    b.creatures = b.creatures.filter((c) => c.id !== B0);
    b.records = b.records.filter((s) => idOf(s) !== B0);
    const report = verifyLineage(b);
    expect(report.problems.filter((p) => p.family === 'origin')).toEqual([
      at(A1, 0, 'parent-missing'),
    ]);
    expect(report.toGenesis).toBe(false);
  });

  it('a commitment or a beacon the proof does not hold', () => {
    const b = golden();
    const named = firstOf(b, A0).record.body.commit;
    b.commits = b.commits.filter((c) => commitmentId(c.commitment) !== named);
    expect(originOnly(b)).toEqual([at(A0, 0, 'commit-missing')]);
    const c = golden();
    const round = firstOf(c, A1).record.body.round;
    c.beacons = c.beacons.filter((x) => x.round !== round);
    expect(originOnly(c)).toEqual([at(A1, 0, 'beacon-missing')]);
  });

  it('gives every code it can name a plain sentence', () => {
    const codes = [
      ...['commit-missing', 'beacon-missing', 'round-not-future', 'genome-text', 'parent-genome'],
      ...['parent-missing', 'mate-not-held', 'mate-generation', 'origin-unreadable'],
      ...['not-genesis', 'not-mate', 'bad-commit', 'owner-mismatch', 'bad-ask', 'commit-mismatch'],
      ...['round-mismatch', 'beacon-round', 'bad-beacon', 'body-mismatch', 'rules-mismatch'],
      ...['parent-mismatch', 'mate-commit-mismatch', 'parent-genome-mismatch', 'mate-hash'],
      ...['slot-mismatch', 'genome-mismatch', 'generation-mismatch', 'karyotype-mismatch'],
      ...['bad-ask', 'self', 'pair-mismatch', 'bad-signature'].map((c) => `pair:${c}`),
    ];
    for (const code of codes) expect(Object.hasOwn(PROBLEM_TEXT, code), code).toBe(true);
  });
});

/** 64 genesis creatures, each on its own commitment and its own recorded drand round. */
function manyGeneses(): ProofBundle {
  const rounds = JSON.parse(
    readFileSync(new URL('../../tests/fixtures/drand/rounds.json', import.meta.url), 'utf8'),
  ) as { beacons: Beacon[] };
  const b = golden();
  const creatures: ProofBundle['creatures'] = [];
  const records: StoredRecord[] = [];
  const commits: ProofBundle['commits'] = [];
  const beacons = rounds.beacons.slice(10, 74);
  for (const [i, beacon] of beacons.entries()) {
    const secret = i % 2 === 0 ? OWNER_SECRETS.A : OWNER_SECRETS.B;
    const owner = playerIdOf(publicKeyFromSecret(secret));
    const nonce = `n${i.toString().padStart(21, '0')}`;
    const sig = toBase64Url(
      signWithSecret(secret, REQUEST_DOMAIN, genesisAskMessage(owner, nonce)),
    );
    const c = commit(
      'genesis',
      owner,
      { nonce, sig },
      beacon.round,
      roundTime(beacon.round) - 5000,
    );
    const genome = genesisFor(randomnessOf(beacon), commitmentId(c.commitment));
    const request = genesisRequest(RULES_VERSION, c.commitment, genome);
    const first = store({ ...request, t: roundTime(beacon.round) + 1000 });
    creatures.push({ id: first.hash, genome: genomeToBase64url(genome) });
    records.push(first);
    commits.push(c);
  }
  return {
    ...b,
    subject: creatures[0]?.id as string,
    creatures,
    records,
    commits,
    beacons,
    settlements: [],
  };
}

describe('speed', () => {
  speedTest('recomputes the origins of 64 creatures in under 5 s', () => {
    const b = manyGeneses();
    const started = performance.now();
    const problems = verifyOrigin(indexBundle(b), {});
    const ms = performance.now() - started;
    expect(problems).toEqual([]);
    console.log('SPEED', ms);
    expect(ms).toBeLessThan(5000);
  });
});
