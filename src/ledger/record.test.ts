import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RULES_VERSION } from '../sim/rules';
import { canonicalize } from './canonical';
import { createIdentity, memoryKeyStore, toBase64Url } from './identity';
import {
  authorityKeyId,
  authorityPublicKey,
  authoritySign,
  checkStored,
  creatureId,
  hundredths,
  type LedgerRecord,
  type PubKey,
  recordHash,
  recordProblems,
  requestHash,
  requestMessage,
  type StoredRecord,
} from './record';

const GOLDEN = new URL('./__golden__/records.json', import.meta.url);
const OWNER = '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo';
const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);

const genesis: LedgerRecord = {
  v: 1,
  rules: RULES_VERSION,
  kind: 'genesis',
  creature: '',
  seq: 0,
  prev: '',
  owner: OWNER,
  t: 1_700_000_000_000,
  body: { commit: HEX_A, round: 12345, genome: HEX_B, generation: 0, karyotype: 1 },
};
const genesisId = creatureId(genesis);
const checkpoint: LedgerRecord = {
  v: 1,
  rules: RULES_VERSION,
  kind: 'checkpoint',
  creature: genesisId,
  seq: 1,
  prev: genesisId,
  owner: OWNER,
  t: 1_700_000_900_000,
  body: { activeMs: 900_000, biomass: hundredths(1.2345), energy: 8100, health: 10000 },
};
const death: LedgerRecord = {
  v: 1,
  rules: RULES_VERSION,
  kind: 'death',
  creature: genesisId,
  seq: 2,
  prev: recordHash(checkpoint),
  owner: OWNER,
  t: 1_700_001_800_000,
  body: { cause: 'old-age', activeMs: 4_500_000 },
};
const RECORDS = { genesis, checkpoint, death };

function golden() {
  return Object.fromEntries(
    Object.entries(RECORDS).map(([name, record]) => [
      name,
      { record, hash: recordHash(record), requestHash: requestHash(record) },
    ]),
  );
}

const secret = new Uint8Array(32).fill(7);
const keys: PubKey[] = [
  { id: authorityKeyId(authorityPublicKey(secret)), publicKey: authorityPublicKey(secret) },
];

function stored(record: LedgerRecord, ownerSig: string | null = null): StoredRecord {
  const hash = recordHash(record);
  return { record, hash, ownerSig, authSig: authoritySign(secret, hash), keyId: keys[0]?.id ?? '' };
}

describe('golden records', () => {
  if (process.env.UPDATE_GOLDENS) {
    writeFileSync(
      GOLDEN,
      `${JSON.stringify({ rulesVersion: RULES_VERSION, ...golden() }, null, 1)}\n`,
    );
  }

  it('hash to the committed values', () => {
    const file = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, unknown>;
    expect(file).toEqual({ rulesVersion: RULES_VERSION, ...golden() });
  });

  it('are valid records', () => {
    for (const record of Object.values(RECORDS)) expect(recordProblems(record)).toEqual([]);
  });
});

describe('hashes', () => {
  it('uses the record domain and the request domain over the record without t', () => {
    expect(recordHash(genesis)).toMatch(/^[0-9a-f]{64}$/);
    expect(recordHash(genesis)).not.toBe(requestHash(genesis));
    const { t: _t, ...request } = genesis;
    expect(requestHash(request)).toBe(requestHash(genesis));
    expect(requestMessage(genesis)).toEqual(new TextEncoder().encode(canonicalize(request)));
  });

  it('changing t changes only the record hash; any other field changes both', () => {
    const base = checkpoint;
    expect(recordHash({ ...base, t: base.t + 1 })).not.toBe(recordHash(base));
    expect(requestHash({ ...base, t: base.t + 1 })).toBe(requestHash(base));
    const changed: LedgerRecord[] = [
      { ...base, rules: base.rules + 1 },
      { ...base, kind: 'death' },
      { ...base, creature: HEX_A },
      { ...base, seq: 2 },
      { ...base, prev: HEX_A },
      { ...base, owner: `${OWNER.slice(0, 42)}Q` },
      { ...base, body: { ...base.body, energy: 1 } },
      { ...base, body: { ...base.body, extra: 1 } },
    ];
    for (const next of changed) {
      expect(recordHash(next)).not.toBe(recordHash(base));
      expect(requestHash(next)).not.toBe(requestHash(base));
    }
  });

  it('does not depend on key order', () => {
    const reordered = Object.fromEntries(Object.entries(checkpoint).reverse()) as LedgerRecord;
    expect(recordHash(reordered)).toBe(recordHash(checkpoint));
  });
});

describe('creature ids and record shape', () => {
  it('names a creature by its genesis record hash', () => {
    expect(creatureId(genesis)).toBe(recordHash(genesis));
  });

  it('allows an empty creature only for genesis seq 0 with an empty prev', () => {
    expect(recordProblems({ ...genesis, seq: 1 })).not.toEqual([]);
    expect(recordProblems({ ...genesis, prev: HEX_A })).not.toEqual([]);
    expect(recordProblems({ ...genesis, creature: HEX_A })).not.toEqual([]);
    expect(recordProblems({ ...checkpoint, creature: '' })).not.toEqual([]);
    expect(recordProblems({ ...checkpoint, prev: '' })).not.toEqual([]);
    expect(recordProblems({ ...checkpoint, creature: HEX_A.toUpperCase() })).not.toEqual([]);
    expect(recordProblems({ ...checkpoint, seq: 0 })).not.toEqual([]);
    expect(recordProblems({ ...death, prev: 'abc' })).not.toEqual([]);
  });

  it('rejects malformed fields and unknown kinds', () => {
    const bad: unknown[] = [
      null,
      'x',
      [],
      { ...checkpoint, v: 2 },
      { ...checkpoint, kind: 'mate' },
      { ...checkpoint, rules: 1.5 },
      { ...checkpoint, seq: -1 },
      { ...checkpoint, t: 2 ** 53 },
      { ...checkpoint, owner: 'short' },
      { ...checkpoint, body: null },
      { ...checkpoint, body: [] },
      { ...checkpoint, body: { a: true } },
      { ...checkpoint, body: { a: null } },
    ];
    for (const value of bad) expect(recordProblems(value), JSON.stringify(value)).not.toEqual([]);
  });

  it('turns floats into integers through hundredths only', () => {
    expect(hundredths(1.2345)).toBe(123);
    expect(hundredths(0.005)).toBe(1);
    expect(hundredths(-0.001)).toBe(0);
    expect(Object.is(hundredths(-0.001), 0)).toBe(true);
    expect(() => hundredths(Number.NaN)).toThrow(RangeError);
    expect(() => hundredths(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    const withFloat = { ...checkpoint, body: { biomass: 1.2345 } };
    expect(recordProblems(withFloat)).not.toEqual([]);
    expect(() => recordHash(withFloat)).toThrow(RangeError);
    expect(recordProblems({ ...checkpoint, body: { biomass: hundredths(1.2345) } })).toEqual([]);
  });
});

describe('authority signatures', () => {
  it('derives the key id from the public key', () => {
    const pub = authorityPublicKey(secret);
    expect(pub).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorityKeyId(pub)).toMatch(/^[A-Za-z0-9_-]{8}$/);
    expect(authorityKeyId(authorityPublicKey(new Uint8Array(32).fill(8)))).not.toBe(
      authorityKeyId(pub),
    );
  });

  it('verifies a freshly signed record', () => {
    for (const record of Object.values(RECORDS))
      expect(checkStored(stored(record), keys)).toEqual([]);
  });

  it('names a failure for each kind of tampering', () => {
    const good = stored(checkpoint);
    const flipHex = (h: string) => (h[0] === '0' ? '1' : '0') + h.slice(1);
    const flipB64 = (s: string) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
    const other = new Uint8Array(32).fill(9);
    const otherKeys: PubKey[] = [
      { id: authorityKeyId(authorityPublicKey(other)), publicKey: authorityPublicKey(other) },
    ];
    const cases: [string, StoredRecord, readonly PubKey[], string][] = [
      ['record', { ...good, record: { ...checkpoint, seq: 5 } }, keys, 'hash-mismatch'],
      ['hash', { ...good, hash: flipHex(good.hash) }, keys, 'hash-mismatch'],
      ['signature', { ...good, authSig: flipB64(good.authSig) }, keys, 'bad-auth-signature'],
      ['signature text', { ...good, authSig: 'zz' }, keys, 'bad-auth-signature'],
      ['key id', { ...good, keyId: flipB64(good.keyId) }, keys, 'unknown-key'],
      ['no keys', good, [], 'unknown-key'],
      ['wrong key', good, [{ ...otherKeys[0], id: good.keyId } as PubKey], 'bad-auth-signature'],
      ['bad record', stored({ ...checkpoint, seq: 0 }), keys, 'invalid-record'],
    ];
    for (const [name, s, list, failure] of cases) {
      expect(
        checkStored(s, list).some((f) => f.startsWith(failure)),
        name,
      ).toBe(true);
    }
  });

  it('never throws on a record that is not one', () => {
    const junk = { record: { x: 1.5 }, hash: 3, ownerSig: 4, authSig: null, keyId: {} };
    expect(checkStored(junk as unknown as StoredRecord, keys)).not.toEqual([]);
  });

  it('checks an owner signature under the request domain', async () => {
    const id = await createIdentity(memoryKeyStore(new Uint8Array(32).fill(3)));
    const record: LedgerRecord = { ...checkpoint, owner: id.playerId };
    const sig = toBase64Url(id.sign('bs/req/v1', requestMessage(record)));
    expect(checkStored(stored(record, sig), keys)).toEqual([]);
    // Authority time does not touch the owner's signature.
    expect(checkStored(stored({ ...record, t: record.t + 99 }, sig), keys)).toEqual([]);
    const wrongDomain = toBase64Url(id.sign('bs/hello/v1', requestMessage(record)));
    expect(checkStored(stored(record, wrongDomain), keys)).toContain('bad-owner-signature');
    expect(checkStored(stored({ ...record, seq: 9 }, sig), keys)).toContain('bad-owner-signature');
    expect(checkStored(stored({ ...record, owner: OWNER }, sig), keys)).toContain(
      'bad-owner-signature',
    );
    expect(checkStored(stored(record, 'AAAA'), keys)).toContain('bad-owner-signature');
  });

  it('signs the hash bytes, not the text', () => {
    const hash = recordHash(death);
    expect(authoritySign(secret, hash)).toBe(authoritySign(secret, hash));
    expect(authoritySign(secret, hash)).not.toBe(authoritySign(secret, recordHash(checkpoint)));
  });
});
