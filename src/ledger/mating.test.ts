import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { genomeHash } from '../genome/codec';
import { genesisGenome } from '../genome/genesis';
import { offspringPair } from '../genome/offspring';
import { seedFromString } from '../sim/prng';
import { RULES_VERSION } from '../sim/rules';
import { canonicalize } from './canonical';
import { type Beacon, randomnessOf } from './drand';
import { type Commitment, commitmentId } from './genesis';
import { createIdentity, type Identity, memoryKeyStore, toBase64Url } from './identity';
import { birthRequest, checkBirth, checkMatePair, type MateAsk, signMateAsk } from './mating';
import {
  type LedgerRecord,
  REQUEST_DOMAIN,
  recordHash,
  recordProblems,
  type StoredRecord,
} from './record';

const H = (c: string) => c.repeat(64);
const NONCE = 'n'.repeat(22);

async function id(byte: number): Promise<Identity> {
  return createIdentity(memoryKeyStore(new Uint8Array(32).fill(byte)));
}

async function pair() {
  const [a, b] = [await id(1), await id(2)];
  const askA = signMateAsk(a, {
    creature: H('a'),
    partner: b.playerId,
    partnerCreature: H('b'),
    nonce: NONCE,
  });
  const askB = signMateAsk(b, {
    creature: H('b'),
    partner: a.playerId,
    partnerCreature: H('a'),
    nonce: NONCE,
  });
  return { a, b, askA, askB };
}

const flip = (s: string) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);

describe('mate asks', () => {
  it('accepts two asks that name each other with one nonce', async () => {
    const { a, b, askA, askB } = await pair();
    expect(askA).toMatchObject({ v: 1, kind: 'mate', creature: H('a') });
    expect(checkMatePair(askA, a.playerId, askB, b.playerId)).toEqual([]);
  });

  it('signs under the request domain, so the signature is deterministic', async () => {
    const { a, askA } = await pair();
    expect(
      signMateAsk(a, {
        creature: H('a'),
        partner: askA.partner,
        partnerCreature: H('b'),
        nonce: NONCE,
      }),
    ).toEqual(askA);
    expect(askA.sig).toMatch(/^[A-Za-z0-9_-]{86}$/);
  });

  it('names pair-mismatch for a changed nonce, creature, partner or partner creature', async () => {
    const { a, b, askA, askB } = await pair();
    const c = await id(3);
    const resign = (who: Identity, ask: MateAsk, change: Partial<MateAsk>) => {
      const { v: _v, kind: _k, sig: _s, ...rest } = ask;
      return signMateAsk(who, { ...rest, ...change });
    };
    const changes: Partial<MateAsk>[] = [
      { nonce: 'm'.repeat(22) },
      { creature: H('c') },
      { partner: c.playerId },
      { partnerCreature: H('c') },
    ];
    for (const change of changes) {
      const bad = resign(a, askA, change);
      expect(checkMatePair(bad, a.playerId, askB, b.playerId), JSON.stringify(change)).toEqual([
        'pair-mismatch',
      ]);
    }
  });

  it('names pair-mismatch for a swapped pair', async () => {
    const { a, b, askA, askB } = await pair();
    expect(checkMatePair(askB, b.playerId, askA, a.playerId)).toEqual([]);
    expect(checkMatePair(askA, b.playerId, askB, a.playerId)).toContain('pair-mismatch');
  });

  it('names self when one owner stands on both sides', async () => {
    const { a, askA } = await pair();
    const self = signMateAsk(a, {
      creature: H('b'),
      partner: a.playerId,
      partnerCreature: H('a'),
      nonce: NONCE,
    });
    const selfA = signMateAsk(a, {
      creature: H('a'),
      partner: a.playerId,
      partnerCreature: H('b'),
      nonce: NONCE,
    });
    expect(checkMatePair(selfA, a.playerId, self, a.playerId)).toContain('self');
    expect(checkMatePair(askA, a.playerId, askA, a.playerId)).toContain('self');
  });

  it('names bad-signature for a flipped bit and for an ask signed by anyone but its owner', async () => {
    const { a, b, askA, askB } = await pair();
    expect(checkMatePair({ ...askA, sig: flip(askA.sig) }, a.playerId, askB, b.playerId)).toEqual([
      'bad-signature',
    ]);
    expect(checkMatePair(askA, a.playerId, { ...askB, sig: flip(askB.sig) }, b.playerId)).toEqual([
      'bad-signature',
    ]);
    const c = await id(3);
    const forged = signMateAsk(c, {
      creature: H('b'),
      partner: a.playerId,
      partnerCreature: H('a'),
      nonce: NONCE,
    });
    expect(checkMatePair(askA, a.playerId, forged, b.playerId)).toEqual(['bad-signature']);
    // The wrong domain does not verify either.
    const { sig: _s, ...rest } = askB;
    const wrong = toBase64Url(
      b.sign('bs/hello/v1', new TextEncoder().encode(JSON.stringify(rest))),
    );
    expect(checkMatePair(askA, a.playerId, { ...askB, sig: wrong }, b.playerId)).toEqual([
      'bad-signature',
    ]);
    void REQUEST_DOMAIN;
  });

  it('names bad-ask and never throws on junk', async () => {
    const { a, b, askA, askB } = await pair();
    const junk: unknown[] = [
      null,
      1,
      'x',
      [],
      {},
      { ...askA, v: 2 },
      { ...askA, kind: 'genesis' },
      { ...askA, creature: 'zz' },
      { ...askA, nonce: 5 },
      { ...askA, extra: 1 },
    ];
    for (const j of junk) {
      expect(
        checkMatePair(j as MateAsk, a.playerId, askB, b.playerId),
        JSON.stringify(j),
      ).toContain('bad-ask');
      expect(checkMatePair(askA, a.playerId, j as MateAsk, b.playerId)).toContain('bad-ask');
    }
  });
});

const rounds: { beacons: Beacon[] } = JSON.parse(
  readFileSync(new URL('../../tests/fixtures/drand/rounds.json', import.meta.url), 'utf8'),
);
const beaconOf = (i: number): Beacon => rounds.beacons[i] as Beacon;

const stored = (record: LedgerRecord): StoredRecord => ({
  record,
  hash: recordHash(record),
  ownerSig: null,
  authSig: '',
  keyId: '',
});

/** A whole mating: two players, their creatures, the commitment, both mate-commits and both births. */
async function mating(generations: [number, number] = [2, 5], { rules = RULES_VERSION } = {}) {
  const [a, b] = [await id(1), await id(2)];
  const genomeA = genesisGenome(seedFromString('birth-a'));
  const genomeB = genesisGenome(seedFromString('birth-b'));
  const creatureA = H('c');
  const creatureB = H('d');
  const ask = (who: Identity, mine: string, theirs: string, partner: Identity) =>
    signMateAsk(who, {
      creature: mine,
      partner: partner.playerId,
      partnerCreature: theirs,
      nonce: NONCE,
    });
  const asks = [ask(a, creatureA, creatureB, b), ask(b, creatureB, creatureA, a)] as const;
  const beacon = beaconOf(4);
  const commit: Commitment = {
    v: 1,
    kind: 'mate',
    owner: a.playerId,
    round: beacon.round,
    req: H('1'),
    t: 1_700_000_000_000,
    data: { a: asks[0], b: asks[1] } as unknown as Commitment['data'],
  };
  const commitId = commitmentId(commit);
  const mateRecord = (
    owner: Identity,
    partner: Identity,
    creature: string,
    other: string,
    role: 'a' | 'b',
    mine: string,
    theirs: string,
    generation: number,
  ): LedgerRecord => ({
    v: 1,
    rules,
    kind: 'mate-commit',
    creature,
    seq: 1,
    prev: H('e'),
    owner: owner.playerId,
    t: commit.t + 1000,
    body: {
      commit: commitId,
      round: commit.round,
      role,
      partner: partner.playerId,
      partnerCreature: other,
      genome: mine,
      partnerGenome: theirs,
      generation,
      activeMs: 600_000,
      biomass: 4000,
      energy: 5000,
      health: 10_000,
      cooldownUntilMs: 960_000,
    },
  });
  const hashA = genomeHash(genomeA);
  const hashB = genomeHash(genomeB);
  const mates: [StoredRecord, StoredRecord] = [
    stored(mateRecord(a, b, creatureA, creatureB, 'a', hashA, hashB, generations[0])),
    stored(mateRecord(b, a, creatureB, creatureA, 'b', hashB, hashA, generations[1])),
  ];
  const { children, slots } = offspringPair(randomnessOf(beacon), commitId, genomeA, genomeB);
  const generation = Math.max(...generations) + 1;
  const births = [0, 1].map((i): LedgerRecord => {
    const request = birthRequest(
      rules,
      commit,
      [mates[0].hash, mates[1].hash],
      slots[i] as number,
      [creatureA, creatureB],
      children[i as 0 | 1],
      generation,
      (i === 0 ? a : b).playerId,
    );
    return { ...request, t: commit.t + 5000 };
  });
  return {
    a,
    b,
    commit,
    commitId,
    beacon,
    genomes: [genomeA, genomeB] as const,
    mates,
    births,
    children,
    slots,
  };
}

describe('birthRequest', () => {
  it('shapes a birth like a genesis and names the commitment, parents and mate-commits', async () => {
    const m = await mating();
    const [b0, b1] = m.births as [LedgerRecord, LedgerRecord];
    expect(recordProblems(b0)).toEqual([]);
    expect(recordProblems(b1)).toEqual([]);
    expect(b0).toMatchObject({
      kind: 'birth',
      creature: '',
      seq: 0,
      prev: '',
      owner: m.a.playerId,
    });
    expect(b1.owner).toBe(m.b.playerId);
    expect(b0.body).toMatchObject({
      commit: m.commitId,
      round: m.commit.round,
      slot: 0,
      parents: [H('c'), H('d')],
      mates: [m.mates[0].hash, m.mates[1].hash],
      genome: genomeHash(m.children[0]),
      generation: 6,
      karyotype: 2,
    });
    expect(b1.body.slot).toBe(m.slots[1]);
    expect(b0.body.genome).not.toBe(b1.body.genome);
  });
});

describe('checkBirth', () => {
  const check = (
    m: Awaited<ReturnType<typeof mating>>,
    which: 0 | 1 = 0,
    over: {
      record?: LedgerRecord;
      commit?: Commitment;
      beacon?: Beacon;
      genomes?: readonly [(typeof m.genomes)[0], (typeof m.genomes)[1]];
      mates?: [StoredRecord, StoredRecord];
    } = {},
  ) =>
    checkBirth(
      over.record ?? (m.births[which] as LedgerRecord),
      over.commit ?? m.commit,
      over.beacon ?? m.beacon,
      (over.genomes ?? m.genomes) as [(typeof m.genomes)[0], (typeof m.genomes)[1]],
      over.mates ?? m.mates,
    );
  const withBody = (r: LedgerRecord, body: LedgerRecord['body']): LedgerRecord => ({
    ...r,
    body: { ...r.body, ...body },
  });

  it('accepts both children of an honest mating', async () => {
    const m = await mating();
    expect(check(m, 0)).toEqual([]);
    expect(check(m, 1)).toEqual([]);
  });

  it('answers rules-retired for a birth of a rules version before the reset (ADR 0040)', async () => {
    const m = await mating([2, 5], { rules: 7 });
    expect(check(m, 0)).toEqual(['rules-retired']);
    expect(check(m, 1)).toEqual(['rules-retired']);
  });

  it('names a karyotype other than v2', async () => {
    const m = await mating();
    const r = m.births[0] as LedgerRecord;
    expect(check(m, 0, { record: { ...r, body: { ...r.body, karyotype: 1 } } })).toEqual([
      'karyotype-mismatch',
    ]);
  });

  it('generation is the larger parent generation plus one, whichever parent is older', async () => {
    for (const g of [
      [0, 0],
      [7, 3],
      [3, 7],
    ] as [number, number][]) {
      const m = await mating(g);
      expect((m.births[0] as LedgerRecord).body.generation).toBe(Math.max(...g) + 1);
      expect(check(m, 0)).toEqual([]);
      expect(check(m, 1)).toEqual([]);
    }
  });

  it('names a swapped child genome', async () => {
    const m = await mating();
    const swapped = withBody(m.births[0] as LedgerRecord, {
      genome: (m.births[1] as LedgerRecord).body.genome as string,
    });
    expect(check(m, 0, { record: swapped })).toContain('genome-mismatch');
  });

  it('names a wrong slot', async () => {
    const m = await mating();
    const r = withBody(m.births[1] as LedgerRecord, { slot: 9 });
    expect(check(m, 1, { record: r })).toContain('slot-mismatch');
  });

  it('names a different parent', async () => {
    const m = await mating();
    const r = withBody(m.births[0] as LedgerRecord, { parents: [H('c'), H('f')] });
    expect(check(m, 0, { record: r })).toContain('parent-mismatch');
  });

  it('names a wrong generation', async () => {
    const m = await mating();
    const r = withBody(m.births[0] as LedgerRecord, { generation: 3 });
    expect(check(m, 0, { record: r })).toContain('generation-mismatch');
  });

  it("names a wrong round, and another round's beacon", async () => {
    const m = await mating();
    const wrong = withBody(m.births[0] as LedgerRecord, { round: m.commit.round + 1 });
    expect(check(m, 0, { record: wrong })).toContain('round-mismatch');
    expect(check(m, 0, { beacon: beaconOf(5) })).toContain('beacon-round');
    expect(check(m, 0, { beacon: { ...m.beacon, signature: beaconOf(5).signature } })).toContain(
      'bad-beacon',
    );
  });

  it('names a mate-commit that does not name this commitment, or whose hash is not in the birth', async () => {
    const m = await mating();
    const other = stored({
      ...m.mates[0].record,
      body: { ...m.mates[0].record.body, commit: H('9') },
    });
    expect(check(m, 0, { mates: [other, m.mates[1]] })).toContain('mate-commit-mismatch');
    const lying = { ...m.mates[1], hash: H('8') };
    expect(check(m, 0, { mates: [m.mates[0], lying] })).toContain('mate-hash');
    const r = withBody(m.births[0] as LedgerRecord, { mates: [m.mates[1].hash, m.mates[0].hash] });
    expect(check(m, 0, { record: r })).toContain('mate-hash');
  });

  it('names a mate-commit whose parent genome is not the one supplied', async () => {
    const m = await mating();
    const other = genesisGenome(seedFromString('someone-else'));
    expect(check(m, 0, { genomes: [other, m.genomes[1]] })).toContain('parent-genome-mismatch');
  });

  it('names a commitment of another kind, a bad pair and a wrong owner', async () => {
    const m = await mating();
    const genesisLike = { ...m.commit, kind: 'genesis' };
    expect(check(m, 0, { commit: genesisLike })).toContain('not-mate');
    const broken = {
      ...m.commit,
      data: {
        a: m.commit.data && (m.commit.data as { b: unknown }).b,
        b: (m.commit.data as { b: unknown }).b,
      },
    } as unknown as Commitment;
    expect(check(m, 0, { commit: broken }).some((f) => f.startsWith('pair:'))).toBe(true);
    const thief = { ...(m.births[0] as LedgerRecord), owner: (await id(9)).playerId };
    expect(check(m, 0, { record: thief })).toContain('owner-mismatch');
  });

  it('names a rules version that differs from the mate-commits, and a commitment without asks', async () => {
    const m = await mating();
    const r = { ...(m.births[0] as LedgerRecord), rules: RULES_VERSION + 1 };
    expect(check(m, 0, { record: r })).toContain('rules-mismatch');
    const empty = { ...m.commit, data: {} };
    expect(check(m, 0, { commit: empty })).toEqual(['bad-commit']);
    expect(check(m, 0, { commit: { ...m.commit, data: null as never } })).toEqual(['bad-commit']);
  });

  it('names a record that is not a birth, and never throws on junk', async () => {
    const m = await mating();
    const notBirth = { ...(m.births[0] as LedgerRecord), kind: 'genesis' } as LedgerRecord;
    expect(check(m, 0, { record: notBirth })).not.toEqual([]);
    for (const junk of [null, 1, 'x', {}, []]) {
      expect(
        checkBirth(junk as never, junk as never, junk as never, junk as never, junk as never),
      ).not.toEqual([]);
    }
    expect(canonicalize(m.births[0]?.body ?? {})).toContain('"slot"');
  });
});
