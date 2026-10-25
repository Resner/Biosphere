import { describe, expect, it } from 'vitest';
import { createIdentity, memoryKeyStore, verify } from '../src/ledger/identity';

describe('identity in workerd', () => {
  it('signs and verifies', async () => {
    const id = await createIdentity(memoryKeyStore());
    const msg = new TextEncoder().encode('hello');
    const sig = id.sign('bs/hello/v1', msg);
    expect(verify(id.playerId, 'bs/hello/v1', msg, sig)).toBe(true);
    expect(verify(id.playerId, 'bs/other/v1', msg, sig)).toBe(false);
  });
});
