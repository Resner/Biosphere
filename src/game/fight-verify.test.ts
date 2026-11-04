import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PubKey } from '../ledger/record';
import type { FightLog, SignedSettlement } from '../ledger/settlement';
import {
  cachedKeys,
  FightVerify,
  type HeldFight,
  parsePubKeys,
  pubkeysUrl,
  settlementProblems,
} from './fight-verify';

// M8 T12: the client checks the settlement at `enc-end` against what it holds, off the frame loop.

const GOLDEN = JSON.parse(
  readFileSync(new URL('../ledger/__golden__/settlement.json', import.meta.url), 'utf8'),
) as {
  keys: PubKey[];
  fights: Record<string, { log: FightLog; settlement: SignedSettlement }>;
};
const KEYS = GOLDEN.keys;
const duel = GOLDEN.fights.duel as { log: FightLog; settlement: SignedSettlement };
const SIGNED = duel.settlement;
const held = (): HeldFight => ({
  enc: duel.log.start.enc,
  frames: duel.log.frames.map((f) => [...f]),
  hash: SIGNED.settlement.hash,
});

/** The settlement with one bit of a byte of its signature flipped. */
function flipped(s: SignedSettlement): SignedSettlement {
  const sig = s.authSig;
  const c = sig[10] === 'A' ? 'B' : 'A';
  return { ...s, authSig: `${sig.slice(0, 10)}${c}${sig.slice(11)}` };
}

/** A verifier whose later tasks wait in `queue` until the test runs them. */
function verifier(keys: () => Promise<PubKey[] | null> = () => Promise.resolve(KEYS)) {
  const queue: (() => void)[] = [];
  const v = new FightVerify({ keys, later: (run) => queue.push(run) });
  const settle = async () => {
    await Promise.resolve();
    await Promise.resolve();
    while (queue.length > 0) queue.shift()?.();
  };
  return { v, queue, settle };
}

describe('settlementProblems', () => {
  it('holds for the golden settlement and the frames it settles', () => {
    expect(settlementProblems(SIGNED, held(), KEYS)).toEqual([]);
  });

  it('names a flipped signature, an unknown key, a held root or count that differs, and another hash', () => {
    expect(settlementProblems(flipped(SIGNED), held(), KEYS)).toEqual(['signature']);
    expect(settlementProblems(SIGNED, held(), [])).toEqual(['key']);
    const other = held();
    (other.frames[3] as (number | null)[])[0] = null;
    expect(settlementProblems(SIGNED, other, KEYS)).toEqual(['root']);
    const short = { ...held(), frames: held().frames.slice(0, -1) };
    expect(settlementProblems(SIGNED, short, KEYS)).toEqual(['frames', 'root']);
    expect(settlementProblems(SIGNED, { ...held(), hash: '0000000000000000' }, KEYS)).toEqual([
      'hash',
    ]);
    expect(settlementProblems(SIGNED, { ...held(), hash: null }, KEYS)).toEqual(['hash']);
    expect(settlementProblems(SIGNED, { ...held(), enc: 'x'.repeat(64) }, KEYS)).toEqual(['enc']);
  });

  it('a tampered document fails its signature even with its root unchanged', () => {
    const doc = { ...SIGNED.settlement, results: SIGNED.settlement.results.map((r) => ({ ...r })) };
    (doc.results[0] as { biomass: number }).biomass += 1;
    expect(settlementProblems({ ...SIGNED, settlement: doc }, held(), KEYS)).toEqual(['signature']);
  });
});

describe('FightVerify', () => {
  it('is null at the end, then true once the check has run in a task of its own', async () => {
    const { v, queue, settle } = verifier();
    v.check(SIGNED, held());
    // Nothing runs in the end's own handler: the frame that follows does not wait on it.
    expect(v.verdict(SIGNED.settlement.enc)).toBeNull();
    expect(v.runs).toBe(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(queue.length).toBe(1);
    expect(v.verdict(SIGNED.settlement.enc)).toBeNull();
    await settle();
    expect(v.runs).toBe(1);
    expect(v.verdict(SIGNED.settlement.enc)).toBe(true);
    expect(v.verdict('another')).toBeNull();
  });

  it('is false for a flipped bit or a root other than the held frames', async () => {
    const a = verifier();
    a.v.check(flipped(SIGNED), held());
    await a.settle();
    expect(a.v.verdict(SIGNED.settlement.enc)).toBe(false);
    const b = verifier();
    const other = held();
    (other.frames[0] as (number | null)[])[1] = 7;
    b.v.check(SIGNED, other);
    await b.settle();
    expect(b.v.verdict(SIGNED.settlement.enc)).toBe(false);
  });

  it('checks the frames as they were at the end', async () => {
    const { v, settle } = verifier();
    const mine = held();
    v.check(SIGNED, mine);
    (mine.frames[0] as (number | null)[])[0] = 7;
    await settle();
    expect(v.verdict(SIGNED.settlement.enc)).toBe(true);
  });

  it('stays null with no settlement (a failed one) or no keys', async () => {
    const a = verifier();
    a.v.check(undefined, held());
    await a.settle();
    expect(a.v.verdict(SIGNED.settlement.enc)).toBeNull();
    const b = verifier(() => Promise.resolve(null));
    b.v.check(SIGNED, held());
    await b.settle();
    expect(b.v.verdict(SIGNED.settlement.enc)).toBeNull();
  });

  it('a later fight replaces the verdict of the one before', async () => {
    const { v, settle } = verifier();
    v.check(SIGNED, held());
    v.check(undefined, { ...held(), enc: 'b'.repeat(64) });
    await settle();
    expect(v.verdict(SIGNED.settlement.enc)).toBeNull();
    expect(v.runs).toBe(0);
  });
});

describe('the authority keys', () => {
  it('are fetched once and kept; a failure is asked again', async () => {
    let calls = 0;
    let fail = true;
    const keys = cachedKeys(() => {
      calls++;
      return fail ? Promise.reject(new Error('down')) : Promise.resolve({ keys: KEYS });
    });
    expect(await keys()).toBeNull();
    fail = false;
    expect(await keys()).toEqual(KEYS);
    expect(await keys()).toEqual(KEYS);
    expect(calls).toBe(2);
  });

  it('parse only a list of string ids and keys, and come from the hub URL', () => {
    expect(parsePubKeys({ keys: [{ id: 'a', publicKey: 'b', from: 1 }] })).toEqual([
      { id: 'a', publicKey: 'b' },
    ]);
    for (const bad of [null, 1, {}, { keys: 'x' }, { keys: [{ id: 1, publicKey: 'b' }] }]) {
      expect(parsePubKeys(bad)).toBeNull();
    }
    expect(pubkeysUrl('ws://127.0.0.1:8816/v1/hub?x=1')).toBe('http://127.0.0.1:8816/v1/pubkeys');
    expect(pubkeysUrl('wss://hub.example/v1/hub')).toBe('https://hub.example/v1/pubkeys');
  });
});
