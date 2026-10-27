import { describe, expect, it } from 'vitest';
import { createIdentity, type Identity, memoryKeyStore, toBase64Url } from './identity';
import { checkMatePair, type MateAsk, signMateAsk } from './mating';
import { REQUEST_DOMAIN } from './record';

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
