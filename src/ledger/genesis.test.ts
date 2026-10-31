import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { genomeHash, genomeKaryotype, genomeToBase64url } from '../genome/codec';
import { RULES_VERSION } from '../sim/rules';
import { type GenesisAsk, genesisAskMessage, verifyGenesisAsk } from './ask';
import { type Beacon, randomnessOf } from './drand';
import {
  type Commitment,
  checkGenesis,
  commitmentId,
  genesisFor,
  genesisRequest,
  genesisSeed,
} from './genesis';
import { createIdentity, memoryKeyStore, toBase64Url } from './identity';
import { type LedgerRecord, REQUEST_DOMAIN, recordHash } from './record';

const rounds: { first: number; beacons: Beacon[] } = JSON.parse(
  readFileSync(new URL('../../tests/fixtures/drand/rounds.json', import.meta.url), 'utf8'),
);
const beaconOf = (i: number): Beacon => rounds.beacons[i] as Beacon;

/**
 * The genome hash for the fixture's third beacon and a fixed commit id, pinned for Node and workerd:
 * under rules 5 (the M4 golden, karyotype v1, frozen) and under rules 6 (karyotype v2).
 */
const GOLDEN = {
  commitId: 'ab'.repeat(32),
  beaconIndex: 2,
  genomeHash: 'f3f00a538769f2625bf8059c78d6d50f1b99424e9f098f6691db299475d2e7d3',
  genomeHashV6: 'eacba69a06de03be8480bbd6a9f706f043dfb24788481be4bebde32b9027a127',
};

async function ask(nonce = 'n'.repeat(22)) {
  const id = await createIdentity(memoryKeyStore());
  const sig = toBase64Url(id.sign(REQUEST_DOMAIN, genesisAskMessage(id.playerId, nonce)));
  return { id, ask: { nonce, sig } as GenesisAsk };
}

async function made(beaconIndex = 3, nonce?: string, rules = RULES_VERSION) {
  const { id, ask: a } = await ask(nonce);
  const beacon = beaconOf(beaconIndex);
  const commit: Commitment = {
    v: 1,
    kind: 'genesis',
    owner: id.playerId,
    round: beacon.round,
    req: '1'.repeat(64),
    t: 1_700_000_000_000,
    data: a,
  };
  const commitId = commitmentId(commit);
  const genome = genesisFor(randomnessOf(beacon), commitId, rules);
  const body = genesisRequest(rules, commit, genome);
  const record: LedgerRecord = { ...body, t: commit.t + 5000 };
  return { id, commit, commitId, beacon, genome, record };
}

describe('genesis DNA', () => {
  it('is a pure function of the randomness and the commit id', () => {
    const r = randomnessOf(beaconOf(GOLDEN.beaconIndex));
    const a = genesisFor(r, GOLDEN.commitId);
    expect(genomeToBase64url(a)).toBe(genomeToBase64url(genesisFor(r, GOLDEN.commitId)));
    expect(genesisSeed(r, GOLDEN.commitId)).toEqual(genesisSeed(r, GOLDEN.commitId));
    expect(genomeHash(genesisFor(r, GOLDEN.commitId, 5))).toBe(GOLDEN.genomeHash);
    expect(genomeHash(a)).toBe(GOLDEN.genomeHashV6);
    expect(genomeHash(genesisFor(r, GOLDEN.commitId, 6))).toBe(GOLDEN.genomeHashV6);
    expect(genomeToBase64url(genesisFor(r, GOLDEN.commitId, 7))).toBe(genomeToBase64url(a));
  });

  it('differs for another commit id or another round', () => {
    const r = randomnessOf(beaconOf(2));
    expect(genomeHash(genesisFor(r, 'cd'.repeat(32)))).not.toBe(
      genomeHash(genesisFor(r, GOLDEN.commitId)),
    );
    expect(genomeHash(genesisFor(randomnessOf(beaconOf(3)), GOLDEN.commitId))).not.toBe(
      genomeHash(genesisFor(r, GOLDEN.commitId)),
    );
  });

  it('gives 200 requests 200 different genomes', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const commit: Commitment = {
        v: 1,
        kind: 'genesis',
        owner: 'a'.repeat(43),
        round: rounds.first + (i % 50),
        req: i.toString(16).padStart(64, '0'),
        t: i,
        data: { nonce: String(i).padEnd(22, 'x'), sig: 's' },
      };
      const r = randomnessOf(beaconOf(i % 50));
      seen.add(genomeHash(genesisFor(r, commitmentId(commit))));
    }
    expect(seen.size).toBe(200);
  });
});

describe('genesis ask', () => {
  it('verifies for its owner and no one else', async () => {
    const { id, ask: a } = await ask();
    expect(verifyGenesisAsk(id.playerId, a)).toBe(true);
    expect(verifyGenesisAsk('B'.repeat(43), a)).toBe(false);
    expect(verifyGenesisAsk(id.playerId, { ...a, nonce: 'm'.repeat(22) })).toBe(false);
    expect(verifyGenesisAsk(id.playerId, { ...a, sig: 'not a signature' })).toBe(false);
  });
});

describe('checkGenesis', () => {
  it("recomputes by the record's rules: v1 DNA for rules 5, v2 DNA for rules 6", async () => {
    for (const [rules, karyotype] of [
      [5, 1],
      [6, 2],
    ] as const) {
      const m = await made(3, undefined, rules);
      expect(m.record.body.karyotype).toBe(karyotype);
      expect(genomeKaryotype(m.genome)).toBe(karyotype);
      expect(checkGenesis(m.record, m.commit, m.beacon, genomeToBase64url(m.genome))).toEqual([]);
    }
    // A rules 6 record cannot claim the v5 cell, nor a rules 5 record the v6 one.
    const v5 = await made(3, 'p'.repeat(22), 5);
    expect(checkGenesis({ ...v5.record, rules: 6 }, v5.commit, v5.beacon)).toContain(
      'body-mismatch',
    );
    const v6 = await made(3, 'p'.repeat(22), 6);
    expect(checkGenesis({ ...v6.record, rules: 5 }, v6.commit, v6.beacon)).toContain(
      'body-mismatch',
    );
  });

  it('accepts what the commitment and beacon produce', async () => {
    const m = await made();
    expect(checkGenesis(m.record, m.commit, m.beacon, genomeToBase64url(m.genome))).toEqual([]);
    expect(m.record.body.genome).toBe(genomeHash(m.genome));
    expect(recordHash(m.record)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('names a changed genome text', async () => {
    const m = await made();
    const other = genomeToBase64url(genesisFor(randomnessOf(m.beacon), 'ef'.repeat(32)));
    expect(checkGenesis(m.record, m.commit, m.beacon, other)).toContain('genome-mismatch');
  });

  it('names a record whose round differs from the commitment', async () => {
    const m = await made();
    const record = { ...m.record, body: { ...m.record.body, round: m.commit.round + 1 } };
    expect(checkGenesis(record, m.commit, m.beacon)).toContain('round-mismatch');
  });

  it("names a beacon of another round and a forged beacon's signature", async () => {
    const m = await made();
    expect(checkGenesis(m.record, m.commit, beaconOf(4))).toContain('beacon-round');
    const forged = { round: m.beacon.round, signature: beaconOf(4).signature };
    expect(checkGenesis(m.record, m.commit, forged)).toContain('bad-beacon');
  });

  it('names a record that claims DNA the beacon did not produce', async () => {
    const m = await made();
    const record = { ...m.record, body: { ...m.record.body, genome: '0'.repeat(64) } };
    expect(checkGenesis(record, m.commit, m.beacon)).toContain('body-mismatch');
  });

  it('names a record of another commitment and another owner', async () => {
    const m = await made();
    const other = await made(3, 'q'.repeat(22));
    expect(checkGenesis(m.record, other.commit, m.beacon)).toEqual(
      expect.arrayContaining(['owner-mismatch', 'commit-mismatch']),
    );
  });

  it('names an owner request that its owner did not sign', async () => {
    const m = await made();
    const stranger = await ask();
    const commit = { ...m.commit, data: stranger.ask };
    expect(checkGenesis(m.record, commit, m.beacon)).toContain('bad-ask');
  });

  it('never throws on garbage', async () => {
    const m = await made();
    expect(checkGenesis({} as LedgerRecord, m.commit, m.beacon).length).toBeGreaterThan(0);
    const noData = { ...m.commit, data: null } as unknown as Commitment;
    expect(checkGenesis(m.record, noData, m.beacon).length).toBeGreaterThan(0);
  });
});
