import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { bls12_381 } from '@noble/curves/bls12-381.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import {
  type Beacon,
  DST,
  fetchBeacon,
  QUICKNET,
  randomnessOf,
  roundAt,
  roundMessage,
  roundTime,
  verifyBeacon,
} from './drand';

const read = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../tests/fixtures/drand/${name}`, import.meta.url), 'utf8'));
const info = read('info.json');
const rounds: { first: number; last: number; beacons: Beacon[] } = read('rounds.json');
const beacon = (i: number): Beacon => rounds.beacons[i] as Beacon;
const HOSTS = ['https://a.test', 'https://b.test', 'https://c.test'] as const;

describe('quicknet constants', () => {
  it('match the recorded /info', () => {
    expect(QUICKNET.chain).toBe(info.hash);
    expect(QUICKNET.publicKey).toBe(info.public_key);
    expect(QUICKNET.genesis).toBe(info.genesis_time);
    expect(QUICKNET.period).toBe(info.period);
    expect(info.schemeID).toBe('bls-unchained-g1-rfc9380');
    expect(QUICKNET.chain).toMatch(/^52db9ba7[0-9a-f]{52}e971$/);
  });

  it('rounds start at 1 on genesis and advance every 3 s', () => {
    const g = 1692803367000;
    expect(roundAt(g)).toBe(1);
    expect(roundAt(g + 2999)).toBe(1);
    expect(roundAt(g + 3000)).toBe(2);
    expect(roundAt(g - 1)).toBe(0);
    for (let r = 1; r < 50; r++) expect(roundAt(roundTime(r + 1) - 1)).toBe(r);
    for (let r = 1; r < 50; r++) expect(roundAt(roundTime(r))).toBe(r);
    expect(roundTime(2) - roundTime(1)).toBe(3000);
    expect(() => roundAt(Number.NaN)).toThrow(RangeError);
  });
});

describe('fixtures', () => {
  it('hold 600 consecutive rounds in the recorded shape', () => {
    expect(rounds.beacons).toHaveLength(600);
    expect(rounds.last - rounds.first).toBe(599);
    rounds.beacons.forEach((b, i) => {
      expect(b.round).toBe(rounds.first + i);
      expect(b.signature).toMatch(/^[0-9a-f]{96}$/);
    });
  });
});

describe('verifyBeacon', () => {
  it('accepts every recorded beacon', () => {
    // One aggregate check over all 600 (about 7 s) instead of 600 single ones (about 17 s); the
    // recorder already verified each beacon singly. Ten spread beacons also go through the real path.
    const sigs = bls12_381.shortSignatures;
    const message = (round: number) => sigs.hash(roundMessage(round), DST);
    const publicKey = hexToBytes(QUICKNET.publicKey);
    const aggregate = sigs.aggregateSignatures(rounds.beacons.map((b) => hexToBytes(b.signature)));
    const items = rounds.beacons.map((b) => ({ message: message(b.round), publicKey }));
    expect(sigs.verifyBatch(aggregate, items)).toBe(true);
    for (let i = 0; i < 600; i += 60) expect(verifyBeacon(beacon(i))).toBe(true);
    expect(verifyBeacon(beacon(599))).toBe(true);
  }, 30000);

  it('rejects tampered beacons without throwing', () => {
    const b = beacon(10);
    const flip = (s: string, at: number) =>
      s.slice(0, at) + (s[at] === '0' ? '1' : '0') + s.slice(at + 1);
    const bad: Beacon[] = [
      { round: b.round, signature: flip(b.signature, 40) },
      { round: b.round, signature: flip(b.signature, 95) },
      { round: b.round, signature: beacon(11).signature },
      { round: b.round + 1, signature: b.signature },
      { round: b.round, signature: b.signature.slice(2) },
      { round: b.round, signature: `${b.signature}00` },
      { round: b.round, signature: 'z'.repeat(96) },
      { round: b.round, signature: b.signature.toUpperCase() },
      { round: b.round, signature: `80${'0'.repeat(94)}` },
      { round: b.round, signature: `c0${'0'.repeat(94)}` },
      { round: b.round, signature: '' },
      { round: 0, signature: b.signature },
      { round: -1, signature: b.signature },
      { round: 1.5, signature: b.signature },
      { round: Number.NaN, signature: b.signature },
      { round: b.round, signature: 42 as unknown as string },
    ];
    for (const x of bad) expect(verifyBeacon(x)).toBe(false);
  });

  it('rejects a point that is on no curve', () => {
    // A compressed-G1 flag byte with an x that has no square root for some values; try a few.
    for (let i = 1; i < 40; i++) {
      const sig = `8${(i % 16).toString(16)}${'ab'.repeat(46)}${i.toString(16).padStart(2, '0')}`;
      expect(verifyBeacon({ round: 5, signature: sig })).toBe(false);
    }
  });

  it('costs under 250 ms per beacon', () => {
    verifyBeacon(beacon(0)); // warm the pairing tables
    const start = performance.now();
    for (let i = 1; i <= 4; i++) verifyBeacon(beacon(i));
    const each = (performance.now() - start) / 4;
    console.info(`verifyBeacon: ${each.toFixed(1)} ms per beacon`);
    expect(each).toBeLessThan(250);
  });
});

describe('randomnessOf', () => {
  // The `randomness` field api.drand.sh published for these fixture rounds (fetched once by hand).
  const PUBLISHED: [number, string][] = [
    [33409837, '0e69ec571506fdbbc8aa307d964d25baa4651cb5f87752f200be6a7c1e540fcf'],
    [33410136, '7422922eddda82c4be224bf4a1c40e0b029bf6ce3b97cdca58a6d178fc6bddb4'],
    [33410436, '8a0f2d6d1412cb1bb0856c4fb63e575ca6d3a1acdbe224a49de529e370e6d8bd'],
  ];

  it('equals the randomness drand publishes for the round', () => {
    for (const [round, randomness] of PUBLISHED) {
      const b = rounds.beacons.find((x) => x.round === round) as Beacon;
      expect(bytesToHex(randomnessOf(b))).toBe(randomness);
    }
  });
});

type Reply = { status?: number; body?: unknown; throws?: boolean; hang?: boolean };

function fakeFetch(replies: Record<string, Reply>, calls: string[] = []) {
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const host = HOSTS.find((h) => url.startsWith(h)) ?? '';
    const r = replies[host] ?? { status: 404 };
    if (r.throws) throw new Error('network');
    if (r.hang)
      return new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
      );
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  }) as typeof fetch;
  return f;
}

describe('fetchBeacon', () => {
  const good = beacon(7);
  const goodBody = { round: good.round, signature: good.signature, randomness: 'ignored' };

  it('uses the v1 paths', async () => {
    const calls: string[] = [];
    const f = fakeFetch({ [HOSTS[0]]: { body: goodBody } }, calls);
    expect(await fetchBeacon(good.round, f, HOSTS)).toEqual(good);
    expect(calls).toEqual([`${HOSTS[0]}/${QUICKNET.chain}/public/${good.round}`]);
    const latestCalls: string[] = [];
    const g = fakeFetch({ [HOSTS[0]]: { body: goodBody } }, latestCalls);
    expect(await fetchBeacon('latest', g, HOSTS)).toEqual(good);
    expect(latestCalls).toEqual([`${HOSTS[0]}/${QUICKNET.chain}/public/latest`]);
  });

  it('skips hosts that error, lie, answer the wrong round or time out', async () => {
    const tampered = { round: good.round, signature: beacon(8).signature };
    const wrongRound = { round: beacon(8).round, signature: beacon(8).signature };
    const calls: string[] = [];
    const replies = {
      [HOSTS[0]]: { throws: true },
      [HOSTS[1]]: { status: 500 },
      [HOSTS[2]]: { body: goodBody },
    };
    expect(await fetchBeacon(good.round, fakeFetch(replies, calls), HOSTS)).toEqual(good);
    expect(calls.map((c) => new URL(c).origin)).toEqual([...HOSTS]);

    for (const bad of [tampered, wrongRound, 'nope', null, { round: 'x', signature: 1 }]) {
      const f = fakeFetch({
        [HOSTS[0]]: { body: bad },
        [HOSTS[1]]: { body: goodBody },
      });
      expect(await fetchBeacon(good.round, f, HOSTS)).toEqual(good);
    }
  });

  it('times out a host that never answers', async () => {
    const f = fakeFetch({
      [HOSTS[0]]: { hang: true },
      [HOSTS[1]]: { body: goodBody },
    });
    expect(await fetchBeacon(good.round, f, HOSTS, 50)).toEqual(good);
  });

  it('throws when every host fails, and never returns an unverified beacon', async () => {
    const bad = { round: good.round, signature: beacon(9).signature };
    const f = fakeFetch({
      [HOSTS[0]]: { body: bad },
      [HOSTS[1]]: { throws: true },
      [HOSTS[2]]: { status: 503 },
    });
    await expect(fetchBeacon(good.round, f, HOSTS)).rejects.toThrow(/no drand host/);
    await expect(fetchBeacon('latest', f, HOSTS)).rejects.toThrow(/no drand host/);
  });
});

describe('lazy loading', () => {
  const SRC = resolve(import.meta.dirname, '..');
  const STATIC_IMPORT =
    /^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm;

  function resolveLocal(from: string, spec: string): string | null {
    const base = resolve(dirname(from), spec);
    for (const candidate of [base, `${base}.ts`, `${base}/index.ts`]) {
      try {
        readFileSync(candidate);
        return candidate;
      } catch {}
    }
    return null;
  }

  it('leaves no static import path from the app shell to @noble/curves or drand.ts', () => {
    const seen = new Set<string>();
    const queue = [resolve(SRC, 'game/app.ts')];
    while (queue.length > 0) {
      const file = queue.pop() as string;
      if (seen.has(file)) continue;
      seen.add(file);
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(STATIC_IMPORT)) {
        // A type-only import is erased at build time, so it can't pull in code.
        if (/^\s*(?:import|export)\s+type\s/.test(m[0])) continue;
        const spec = (m[1] ?? m[2]) as string;
        expect(spec, `${file} imports ${spec}`).not.toMatch(/@noble\/curves/);
        if (!spec.startsWith('.')) continue;
        const next = resolveLocal(file, spec);
        if (next) {
          expect(next, `${file} imports ${spec}`).not.toMatch(/ledger\/drand\.ts$/);
          queue.push(next);
        }
      }
    }
    expect(seen.size).toBeGreaterThan(5);
  });
});
