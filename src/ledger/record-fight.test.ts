import { describe, expect, it } from 'vitest';
import { RULES_VERSION } from '../sim/rules';
import { createIdentity, memoryKeyStore, toBase64Url } from './identity';
import {
  authorityKeyId,
  authorityPublicKey,
  authoritySign,
  bodyProblems,
  checkStored,
  type LedgerRecord,
  type PubKey,
  recordHash,
  recordProblems,
  requestMessage,
  type StoredRecord,
  transitionOutcome,
} from './record';

// M7 T13: a fight's results as records (ADR 0052): the `encounter` kind, deaths by a kill or an
// eaten egg, the pending child's one way to die, and that only the authority writes them.

const H = (c: string) => c.repeat(64);
const secret = new Uint8Array(32).fill(7);
const keys: PubKey[] = [
  { id: authorityKeyId(authorityPublicKey(secret)), publicKey: authorityPublicKey(secret) },
];

function stored(record: LedgerRecord, ownerSig: string | null = null): StoredRecord {
  const hash = recordHash(record);
  return { record, hash, ownerSig, authSig: authoritySign(secret, hash), keyId: keys[0]?.id ?? '' };
}

const chained = (owner: string, kind: LedgerRecord['kind'], body: LedgerRecord['body']) => ({
  v: 1 as const,
  rules: RULES_VERSION,
  kind,
  creature: H('c'),
  seq: 3,
  prev: H('d'),
  owner,
  t: 1_700_000_000_000,
  body,
});

const encounter = {
  enc: H('e'),
  outcome: 'stood',
  frames: 140,
  biomass: 42_000,
  energy: 51_000,
  health: 9000,
  reward: 16_800,
  activeMs: 900_000,
};
const killed = { cause: 'killed', activeMs: 900_000, biomass: 41_000, enc: H('e'), by: H('f') };
const eaten = { cause: 'eaten', activeMs: 0, biomass: 8000, enc: H('e'), by: H('f') };

describe('bodies', () => {
  it('takes an encounter body for a survivor only', () => {
    expect(bodyProblems('encounter', encounter)).toEqual([]);
    expect(bodyProblems('encounter', { ...encounter, outcome: 'escaped' })).toEqual([]);
    for (const outcome of ['killed', 'died', 'won', 1]) {
      expect(bodyProblems('encounter', { ...encounter, outcome })).toContain('bad:outcome');
    }
    expect(bodyProblems('encounter', { ...encounter, reward: 1.5 })).toContain('bad:reward');
    expect(bodyProblems('encounter', { ...encounter, by: H('f') })).toContain('unknown:by');
  });

  it('asks an encounter body for its life clock (ADR 0054)', () => {
    const owner = '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo';
    const { activeMs: _activeMs, ...rules9 } = encounter;
    expect(bodyProblems('encounter', rules9)).toEqual(['missing:activeMs']);
    expect(bodyProblems('encounter', { ...encounter, activeMs: -1 })).toEqual(['bad:activeMs']);
    expect(recordProblems(chained(owner, 'encounter', rules9))).toEqual(['body:missing:activeMs']);
    // A rules-9 record of M7's shape was retired with its world (ADR 0055): it no longer verifies.
    const old = { ...chained(owner, 'encounter', rules9), rules: 9 };
    expect(checkStored(stored(old), keys)).toEqual(['rules-retired']);
  });

  it('makes a death by a kill or an eaten egg name the encounter and who did it', () => {
    expect(bodyProblems('death', killed)).toEqual([]);
    expect(bodyProblems('death', eaten)).toEqual([]);
    for (const body of [killed, eaten]) {
      const { by: _by, ...noBy } = body;
      expect(bodyProblems('death', noBy)).toEqual(['missing:by']);
      expect(bodyProblems('death', { ...body, enc: 'zz' })).toEqual(['bad:enc']);
    }
    // Every other cause is the clock and the biomass, and the encounter when a fight's
    // settlement wrote it (a hazard in the fight), never a killer (rules 11, ADR 0055).
    const toxin = { cause: 'toxin', activeMs: 5, biomass: 9 };
    expect(bodyProblems('death', toxin)).toEqual([]);
    expect(bodyProblems('death', { ...toxin, enc: H('e') })).toEqual([]);
    expect(bodyProblems('death', { ...toxin, enc: H('e'), by: H('f') })).toEqual(['unknown:by']);
    expect(bodyProblems('death', { ...toxin, enc: 'zz' })).toEqual(['bad:enc']);
  });

  it('are valid records', () => {
    const owner = '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo';
    expect(recordProblems(chained(owner, 'encounter', encounter))).toEqual([]);
    expect(recordProblems(chained(owner, 'death', killed))).toEqual([]);
    expect(recordProblems(chained(owner, 'death', { cause: 'killed' }))).toContain(
      'body:missing:enc',
    );
  });
});

describe('the matrix', () => {
  it('lets a pending child die only of an eaten egg, and only a pending one', () => {
    expect(transitionOutcome('death', 'eaten', 'pending')).toEqual({ ok: true, next: 'dead' });
    for (const cause of [null, 'killed', 'toxin', 'starved']) {
      expect(transitionOutcome('death', cause, 'pending')).toEqual({
        ok: false,
        reason: 'status:pending',
      });
    }
    for (const status of ['active', 'checkpoint', 'dead', null] as const) {
      expect(transitionOutcome('death', 'eaten', status).ok, String(status)).toBe(false);
    }
    expect(transitionOutcome('death', 'killed', 'active')).toEqual({ ok: true, next: 'dead' });
  });

  it('records an encounter on an active creature only', () => {
    expect(transitionOutcome('encounter', null, 'active')).toEqual({ ok: true, next: 'active' });
    for (const status of ['pending', 'checkpoint', 'dead', null] as const) {
      expect(transitionOutcome('encounter', null, status).ok, String(status)).toBe(false);
    }
  });
});

describe('checkStored', () => {
  it('takes a fight record the authority wrote alone', () => {
    const owner = '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo';
    for (const [kind, body] of [
      ['encounter', encounter],
      ['death', killed],
      ['death', eaten],
    ] as const) {
      expect(checkStored(stored(chained(owner, kind, body)), keys)).toEqual([]);
    }
  });

  it('fails a fight record an owner signed, even with a good signature', async () => {
    const id = await createIdentity(memoryKeyStore(new Uint8Array(32).fill(3)));
    const sign = (r: LedgerRecord) => toBase64Url(id.sign('bs/req/v1', requestMessage(r)));
    for (const [kind, body] of [
      ['encounter', encounter],
      ['death', killed],
      ['death', eaten],
    ] as const) {
      const record = chained(id.playerId, kind, body);
      expect(checkStored(stored(record, sign(record)), keys), `${kind} ${body.enc}`).toEqual([
        'not-attested',
      ]);
    }
    // An owner may still sign a death the authority doesn't reserve (the M4 rule is unchanged).
    const toxin = chained(id.playerId, 'death', { cause: 'toxin', activeMs: 1, biomass: 9 });
    expect(checkStored(stored(toxin, sign(toxin)), keys)).toEqual([]);
  });
});
