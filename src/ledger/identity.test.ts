import { describe, expect, it } from 'vitest';
import {
  createIdentity,
  fromBase64Url,
  importRecoveryCode,
  type KeyStore,
  memoryKeyStore,
  playerIdOf,
  toBase64Url,
  verify,
} from './identity';
import { decodeRecoveryCode, encodeRecoveryCode } from './recovery';

const text = (s: string) => new TextEncoder().encode(s);
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => Number.parseInt(x, 16));

// RFC 8032 test 1 seed; the signature was produced independently with node:crypto.
const KAT_SEED = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const KAT_PLAYER = '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo';
const KAT_SIG =
  '36e7eec70d1b81d5cd1a80c6edfed253a4afc9bf4b8d4bd0242f4fcf95534753b39a28d57b7bb812aecd1efe705167dc5290b9db128fca1144efa8d350b8c602';

const storeWith = (seed: Uint8Array): KeyStore => memoryKeyStore(seed);

describe('createIdentity', () => {
  it('keeps the same playerId for the same store and differs across stores', async () => {
    const store = memoryKeyStore();
    const a = await createIdentity(store);
    const b = await createIdentity(store);
    const c = await createIdentity(memoryKeyStore());
    expect(a.playerId).toBe(b.playerId);
    expect(c.playerId).not.toBe(a.playerId);
    expect(a.playerId).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('replaces a stored seed of the wrong length', async () => {
    const id = await createIdentity(storeWith(new Uint8Array(5)));
    expect(id.playerId).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('never exposes the seed', async () => {
    const seed = fromHex(KAT_SEED);
    const id = await createIdentity(storeWith(seed));
    const dump = JSON.stringify(id);
    expect(dump).not.toContain(KAT_SEED);
    expect(dump).not.toContain(btoa(String.fromCharCode(...seed)));
    expect(Object.keys(id).sort()).toEqual(['exportRecoveryCode', 'playerId', 'sign']);
    // Only the explicit export carries the seed, and only as the recovery code.
    expect(dump).not.toContain(id.exportRecoveryCode());
  });
});

describe('sign and verify', () => {
  it('round trips and rejects any change', async () => {
    const id = await createIdentity(memoryKeyStore());
    const other = await createIdentity(memoryKeyStore());
    const msg = text('hello');
    const sig = id.sign('bs/hello/v1', msg);
    expect(sig).toHaveLength(64);
    expect(verify(id.playerId, 'bs/hello/v1', msg, sig)).toBe(true);
    expect(verify(id.playerId, 'bs/other/v1', msg, sig)).toBe(false);
    expect(verify(id.playerId, 'bs/hello/v1', text('hellp'), sig)).toBe(false);
    expect(verify(other.playerId, 'bs/hello/v1', msg, sig)).toBe(false);
    const flipped = sig.slice();
    flipped[10] = (flipped[10] ?? 0) ^ 1;
    expect(verify(id.playerId, 'bs/hello/v1', msg, flipped)).toBe(false);
  });

  it('returns false on garbage and never throws', () => {
    const msg = text('x');
    expect(verify('', 'd', msg, new Uint8Array(64))).toBe(false);
    expect(verify('not base64url!!', 'd', msg, new Uint8Array(64))).toBe(false);
    expect(verify('A'.repeat(43), 'd', msg, new Uint8Array(64))).toBe(false);
    expect(verify('A'.repeat(43), 'd', msg, new Uint8Array(3))).toBe(false);
    expect(verify('A'.repeat(50), 'd', msg, new Uint8Array(64))).toBe(false);
    expect(verify(KAT_PLAYER, 'd', msg, new Uint8Array(64).fill(255))).toBe(false);
  });

  it('matches the known answer', async () => {
    const id = await createIdentity(storeWith(fromHex(KAT_SEED)));
    expect(id.playerId).toBe(KAT_PLAYER);
    const sig = id.sign('bs/hello/v1', text('known answer'));
    expect(hex(sig)).toBe(KAT_SIG);
    expect(verify(KAT_PLAYER, 'bs/hello/v1', text('known answer'), fromHex(KAT_SIG))).toBe(true);
  });

  it('derives the playerId from a public key', () => {
    expect(
      playerIdOf(fromHex('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a')),
    ).toBe(KAT_PLAYER);
  });
});

describe('base64url helpers', () => {
  it('round trips bytes and rejects malformed text', () => {
    const bytes = Uint8Array.from({ length: 37 }, (_, i) => i * 7);
    expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
    expect(fromBase64Url('ab+/')).toBeNull();
    expect(fromBase64Url('abcde')).toBeNull();
    expect(fromBase64Url('')).toEqual(new Uint8Array());
    // 'AB' has non-zero spare bits: the canonical form of the same byte is 'AA'.
    expect(fromBase64Url('AA')).toEqual(new Uint8Array([0]));
    expect(fromBase64Url('AB')).toBeNull();
  });
});

describe('playerId canonical form', () => {
  it('rejects a playerId whose last character has non-zero spare bits', async () => {
    const id = await createIdentity(memoryKeyStore(fromHex(KAT_SEED)));
    expect(id.playerId).toBe(KAT_PLAYER);
    const variant = `${KAT_PLAYER.slice(0, -1)}${KAT_PLAYER.endsWith('o') ? 'p' : 'o'}`;
    const sig = id.sign('bs/hello/v1', text('x'));
    expect(verify(KAT_PLAYER, 'bs/hello/v1', text('x'), sig)).toBe(true);
    expect(verify(variant, 'bs/hello/v1', text('x'), sig)).toBe(false);
  });
});

describe('recovery code', () => {
  it('exports the stored seed, and importing it elsewhere gives the same playerId', async () => {
    const a = await createIdentity(memoryKeyStore());
    const code = a.exportRecoveryCode();
    const store = memoryKeyStore();
    const b = await importRecoveryCode(store, code);
    expect(b.playerId).toBe(a.playerId);
    expect((await createIdentity(store)).playerId).toBe(a.playerId);
    expect(b.exportRecoveryCode()).toBe(code);
    expect(b.sign('d', text('m'))).toEqual(a.sign('d', text('m')));
  });

  it('replaces, not merges, the identity already in the store', async () => {
    const a = await createIdentity(memoryKeyStore());
    const store = memoryKeyStore();
    const old = await createIdentity(store);
    const next = await importRecoveryCode(store, a.exportRecoveryCode());
    expect(next.playerId).toBe(a.playerId);
    expect(next.playerId).not.toBe(old.playerId);
    expect((await createIdentity(store)).playerId).toBe(a.playerId);
  });

  it('leaves the store alone when the code is bad', async () => {
    const store = memoryKeyStore();
    const before = await createIdentity(store);
    const code = encodeRecoveryCode(new Uint8Array(32));
    const bad = `${code.slice(0, -1)}${code.endsWith('0') ? '1' : '0'}`;
    await expect(importRecoveryCode(store, bad)).rejects.toThrow('recovery code');
    await expect(importRecoveryCode(store, 'nope')).rejects.toThrow('recovery code');
    expect((await createIdentity(store)).playerId).toBe(before.playerId);
  });

  it('exports a code that decodes to the 32-byte seed', async () => {
    const seed = Uint8Array.from({ length: 32 }, (_, i) => i + 7);
    const id = await createIdentity(memoryKeyStore(seed));
    expect(decodeRecoveryCode(id.exportRecoveryCode())).toEqual(seed);
  });
});
