import { describe, expect, it } from 'vitest';
import { createRng, seedFromString } from '../sim/prng';
import { playerIdOf, publicKeyFromSecret, signWithSecret, toBase64Url, verify } from './identity';
import { keyVerifier } from './key-verify';

// The tabled verifier must answer exactly as `verify` does (M9 T3).

const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const rng = createRng(seedFromString('key-verify'), 'cases');
const bytes = (n: number) => Uint8Array.from({ length: n }, () => rng.int(0, 255));
const DOMAIN = 'bs/auth/v1';

/** `sig` with its scalar s replaced by s + L: the same point equation, a non-canonical encoding. */
function unreduced(sig: Uint8Array): Uint8Array {
  let s = 0n;
  for (let i = 63; i >= 32; i--) s = (s << 8n) | BigInt(sig[i] as number);
  s += L;
  const out = sig.slice();
  for (let i = 32; i < 64; i++) {
    out[i] = Number(s & 0xffn);
    s >>= 8n;
  }
  return out;
}

describe('keyVerifier', () => {
  it('agrees with verify on good, flipped, unreduced and foreign signatures', () => {
    const fresh = () => {
      const secret = bytes(32);
      const id = playerIdOf(publicKeyFromSecret(secret));
      const check = keyVerifier(id);
      if (!check) throw new Error('a real key has a verifier');
      return { secret, id, check };
    };
    let key = fresh();
    // Tabling a key takes tens of ms, so a few keys sign many messages.
    for (let n = 0; n < 60; n++) {
      if (n > 0 && n % 12 === 0) key = fresh();
      const { secret, id, check } = key;
      const message = bytes(rng.int(0, 80));
      const sig = signWithSecret(secret, DOMAIN, message);
      const flipped = sig.slice();
      const bit = rng.int(0, 511);
      flipped[bit >> 3] = (flipped[bit >> 3] as number) ^ (1 << (bit & 7));
      const other = signWithSecret(bytes(32), DOMAIN, message);
      const cases: [Uint8Array, Uint8Array, string, boolean][] = [
        [sig, message, DOMAIN, true],
        [flipped, message, DOMAIN, false],
        [unreduced(sig), message, DOMAIN, false],
        [other, message, DOMAIN, false],
        [sig, bytes(8), DOMAIN, false],
        [sig, message, 'bs/rec/v1', false],
        [sig.subarray(0, 63), message, DOMAIN, false],
      ];
      for (const [i, [s, m, d, want]] of cases.entries()) {
        expect(verify(id, d, m, s), `${n}/${i}`).toBe(want);
        expect(check(d, m, s), `${n}/${i}`).toBe(want);
      }
    }
  });

  it('has none for a malformed, non-canonical or small-order key', () => {
    const identity = new Uint8Array(32);
    identity[0] = 1;
    const unreducedY = new Uint8Array(32).fill(0xff);
    unreducedY[31] = 0x7f;
    for (const key of ['', 'x', toBase64Url(identity), toBase64Url(unreducedY)]) {
      expect(keyVerifier(key), key).toBeNull();
    }
  });
});
