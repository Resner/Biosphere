import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createRng, seedFromString } from '../sim/prng';
import {
  decodeSnapshot,
  EVENT_MAX_BYTES,
  encodeSnapshot,
  GENOME_DATA_MAX_CHARS,
  genomeRefOf,
  HUB_MAX_BYTES,
  type HubMsg,
  parseClientMsg,
  parseHubMsg,
  parsePeerEvent,
  SDP_MAX_BYTES,
  SNAPSHOT_BYTES,
  type Snapshot,
  WELCOME_MAX_BYTES,
} from './protocol';

const TAU = 2 * Math.PI;
const PID = 'A'.repeat(43);
const PID2 = 'B'.repeat(43);
const SIG = 'c'.repeat(86);
const NONCE = 'd'.repeat(22);

const snap: Snapshot = {
  seq: 7,
  tick: 123456,
  x: 4000.3,
  y: 17.77,
  heading: 3.1,
  vx: -12.4,
  vy: 6.6,
  biomass: 123.4,
  energy: 0.731,
  health: 0.5,
  alive: true,
  dashing: true,
  genomeRef: 0xbeef,
};

describe('snapshot codec', () => {
  it('is exactly 25 bytes and round trips within quantization', () => {
    const bytes = encodeSnapshot(snap);
    expect(bytes.length).toBe(SNAPSHOT_BYTES);
    expect(SNAPSHOT_BYTES).toBe(25);
    expect(bytes[24]).toBe(2);
    const d = decodeSnapshot(bytes);
    expect(d).not.toBeNull();
    if (!d) return;
    expect(d.seq).toBe(snap.seq);
    expect(d.tick).toBe(snap.tick);
    expect(Math.abs(d.x - snap.x)).toBeLessThanOrEqual(0.0625 + 1e-9);
    expect(Math.abs(d.y - snap.y)).toBeLessThanOrEqual(0.0625 + 1e-9);
    expect(Math.abs(d.heading - snap.heading)).toBeLessThanOrEqual(TAU / 512 + 1e-9);
    expect(Math.abs(d.vx - snap.vx)).toBeLessThanOrEqual(0.125 + 1e-9);
    expect(Math.abs(d.vy - snap.vy)).toBeLessThanOrEqual(0.125 + 1e-9);
    expect(Math.abs(d.biomass / snap.biomass - 1)).toBeLessThanOrEqual(0.0003);
    expect(d.genomeRef).toBe(0xbeef);
    expect(Math.abs(d.energy - snap.energy)).toBeLessThanOrEqual(0.005);
    expect(Math.abs(d.health - snap.health)).toBeLessThanOrEqual(0.005);
    expect(d.alive).toBe(true);
    expect(d.dashing).toBe(true);
  });

  it('keeps the flags independent', () => {
    for (const [alive, dashing] of [
      [true, false],
      [false, true],
      [false, false],
    ] as const) {
      const d = decodeSnapshot(encodeSnapshot({ ...snap, alive, dashing }));
      expect([d?.alive, d?.dashing]).toEqual([alive, dashing]);
    }
  });

  it('wraps seq modulo 65536 and tick modulo 2^32', () => {
    const d = decodeSnapshot(encodeSnapshot({ ...snap, seq: 65536 + 5, tick: 2 ** 32 + 9 }));
    expect(d?.seq).toBe(5);
    expect(d?.tick).toBe(9);
  });

  it('wraps and normalizes the heading, including negative and huge values', () => {
    for (const h of [-0.5, TAU - 0.0001, TAU, 7 * TAU + 1, 0]) {
      const d = decodeSnapshot(encodeSnapshot({ ...snap, heading: h }));
      const turns = ((h / TAU) % 1) + 1;
      const want = (turns % 1) * TAU;
      const diff = Math.abs((d?.heading ?? -9) - want);
      const circular = Math.min(diff, TAU - diff);
      expect(circular).toBeLessThanOrEqual(TAU / 512 + 1e-6);
    }
  });

  it('clamps out-of-range and non-finite values instead of throwing', () => {
    const d = decodeSnapshot(
      encodeSnapshot({
        ...snap,
        x: 99999,
        y: -5,
        vx: Number.NaN,
        vy: Number.POSITIVE_INFINITY,
        biomass: -1,
        energy: 3,
        health: Number.NaN,
      }),
    );
    expect(d).not.toBeNull();
    expect(d?.x).toBeLessThanOrEqual(8192);
    expect(d?.y).toBe(0);
    expect(d?.vx).toBe(0);
    expect(d?.biomass).toBe(1);
    expect(d?.energy).toBe(1);
    expect(d?.health).toBe(0);
  });

  it('carries biomass from 1 to 2^24 within 0.03% (100, 900 and 1e6)', () => {
    for (const biomass of [1, 100, 900, 12_345, 1e6, 2 ** 24]) {
      const d = decodeSnapshot(encodeSnapshot({ ...snap, biomass }));
      expect(Math.abs((d?.biomass ?? 0) / biomass - 1), String(biomass)).toBeLessThanOrEqual(
        0.0003,
      );
    }
    expect(decodeSnapshot(encodeSnapshot({ ...snap, biomass: 0.2 }))?.biomass).toBe(1);
    expect(decodeSnapshot(encodeSnapshot({ ...snap, biomass: 1e12 }))?.biomass).toBeCloseTo(
      2 ** 24,
      -3,
    );
  });

  it('drops a version 1 snapshot (24 bytes) and a wrong version byte', () => {
    expect(decodeSnapshot(encodeSnapshot(snap).subarray(0, 24))).toBeNull();
    for (const version of [0, 1, 3, 255]) {
      const bytes = encodeSnapshot(snap);
      bytes[24] = version;
      expect(decodeSnapshot(bytes), String(version)).toBeNull();
    }
  });

  it('derives the genome ref from the first two bytes of the hash', () => {
    expect(genomeRefOf('beef0123')).toBe(0xbeef);
    expect(genomeRefOf('0000ffff')).toBe(0);
    expect(genomeRefOf('zz')).toBe(0);
  });

  it('covers the whole world at 0.125 wu', () => {
    expect(decodeSnapshot(encodeSnapshot({ ...snap, x: 8192, y: 8192 }))?.x).toBeGreaterThan(
      8191.8,
    );
  });
});

describe('snapshot fuzz', () => {
  it('never throws, and decodes only 25-byte arrays with a valid flag and version byte', () => {
    const rng = createRng(seedFromString('fuzz-snapshot'), 'net');
    let decoded = 0;
    for (let i = 0; i < 100_000; i++) {
      const len = rng.int(0, 64);
      const b = new Uint8Array(len);
      for (let j = 0; j < len; j++) b[j] = rng.int(0, 255);
      // Random bytes almost never carry version 2, so half the arrays get it.
      if (len === 25 && rng.int(0, 1) === 1) b[24] = 2;
      const d = decodeSnapshot(b);
      if (d) {
        decoded++;
        expect(len).toBe(25);
        expect((b[11] as number) & ~3).toBe(0);
        expect(b[24]).toBe(2);
      } else if (len === 25 && b[24] === 2) {
        expect((b[11] as number) & ~3).not.toBe(0);
      }
    }
    expect(decoded).toBeGreaterThan(0);
  });

  it('rejects non-Uint8Array input', () => {
    expect(decodeSnapshot([] as unknown as Uint8Array)).toBeNull();
    expect(decodeSnapshot(null as unknown as Uint8Array)).toBeNull();
  });
});

const clientMsgs = [
  { t: 'hello', v: 1, playerId: PID, name: 'Alice_9', sig: SIG },
  { t: 'ping', id: 42 },
  { t: 'signal', to: PID2, kind: 'offer', sdp: 'v=0\r\no=- 1 2 IN IP4 0.0.0.0\r\n' },
  { t: 'signal', to: PID2, kind: 'answer', sdp: 'v=0' },
  { t: 'leave' },
];

const hubMsgs: HubMsg[] = [
  { t: 'challenge', nonce: NONCE },
  {
    t: 'welcome',
    pond: {
      id: 'p1',
      seed: 'abc123',
      epoch: 1_700_000_000_000,
      centre: { x: 4096, y: 4096 },
      size: 8192,
    },
    you: { spawnHint: { x: 4400, y: 4000.5 } },
    members: [{ playerId: PID, name: 'bob' }],
    ice: [
      { urls: 'stun:stun.example.org' },
      { urls: ['turn:t.example.org?transport=udp'], username: 'u', credential: 'c' },
    ],
    turn: true,
    now: 1_700_000_001_234,
  },
  { t: 'pong', id: 3, now: 1_700_000_001_234 },
  { t: 'member', op: 'join', member: { playerId: PID, name: 'bob' } },
  { t: 'member', op: 'leave', member: { playerId: PID, name: 'bob' } },
  { t: 'signal', from: PID, kind: 'offer', sdp: 'v=0' },
  { t: 'error', code: 'no-peer' },
];

const peerEvents = [
  { t: 'claim', slot: 'c3_5_s2', k: 2, tick: 900 },
  { t: 'consumed', part: 0, of: 2, entries: [['c3_5_s2', 2, 1500]] },
  { t: 'chat', text: 'hello pond' },
  { t: 'genome', data: 'Ab-_09'.repeat(100) },
  { t: 'emote', id: 5 },
  { t: 'ping', kind: 3, x: 100.5, y: -20 },
];

describe('welcome size', () => {
  it('parses the worst case: 23 members with 16-character names, STUN and two TURN entries with maximal credentials', () => {
    const members = Array.from({ length: 23 }, (_, i) => ({
      playerId: String.fromCharCode(65 + i).repeat(43),
      name: 'n'.repeat(16),
    }));
    const welcome: HubMsg = {
      t: 'welcome',
      pond: {
        id: 'p'.repeat(6),
        seed: 's'.repeat(16),
        epoch: Number.MAX_SAFE_INTEGER,
        centre: { x: 4096.123456789, y: 4096.123456789 },
        size: 8192,
      },
      you: { spawnHint: { x: 4400.123456789012, y: 4000.123456789012 } },
      members,
      ice: [
        { urls: 'stun:stun.cloudflare.com:3478' },
        { urls: 'stun:stun.l.google.com:19302' },
        ...[0, 1].map((k) => ({
          urls: [0, 1, 2, 3].map((i) => `turn:turn${k}${i}.cloudflare.com:3478?transport=udp`),
          username: 'u'.repeat(512),
          credential: 'c'.repeat(512),
        })),
      ],
      turn: true,
      now: Number.MAX_SAFE_INTEGER,
    };
    const raw = JSON.stringify(welcome);
    expect(raw.length).toBeGreaterThan(HUB_MAX_BYTES);
    expect(raw.length).toBeLessThanOrEqual(WELCOME_MAX_BYTES);
    expect(parseHubMsg(raw)).toEqual(welcome);
  });

  it('still caps a welcome at WELCOME_MAX_BYTES', () => {
    const raw = JSON.stringify({ ...(hubMsgs[1] as object), pad: 'x'.repeat(WELCOME_MAX_BYTES) });
    expect(parseHubMsg(raw)).toBeNull();
  });
});

describe('message round trips', () => {
  it.each(clientMsgs)('client %j', (m) => {
    expect(parseClientMsg(JSON.stringify(m))).toEqual(m);
  });
  it.each(hubMsgs)('hub %j', (m) => {
    expect(parseHubMsg(JSON.stringify(m))).toEqual(m);
  });
  it.each(peerEvents)('peer %j', (m) => {
    expect(parsePeerEvent(JSON.stringify(m))).toEqual(m);
  });

  it('strips unknown fields', () => {
    expect(parseClientMsg('{"t":"ping","id":1,"extra":{"a":1}}')).toEqual({ t: 'ping', id: 1 });
  });
});

describe('rejections', () => {
  const hello = clientMsgs[0] as Record<string, unknown>;
  const bad = (m: unknown) => parseClientMsg(JSON.stringify(m));

  it('rejects unknown t, wrong v, bad names and bad ids', () => {
    expect(bad({ t: 'nope' })).toBeNull();
    expect(bad({ ...hello, v: 2 })).toBeNull();
    expect(bad({ ...hello, v: undefined })).toBeNull();
    expect(bad({ ...hello, name: 'x'.repeat(17) })).toBeNull();
    expect(bad({ ...hello, name: 'ab' })).toBeNull();
    expect(bad({ ...hello, name: 'bad name' })).toBeNull();
    expect(bad({ ...hello, playerId: 'short' })).toBeNull();
    expect(bad({ ...hello, sig: 'short' })).toBeNull();
    expect(bad({ t: 'ping', id: 1.5 })).toBeNull();
    expect(bad({ t: 'ping', id: -1 })).toBeNull();
    expect(bad({ t: 'signal', to: PID, kind: 'rollback', sdp: 'v=0' })).toBeNull();
    expect(bad({ t: 'signal', to: PID, kind: 'offer', sdp: '' })).toBeNull();
    expect(bad({ t: 'signal', to: 'nope', kind: 'offer', sdp: 'v=0' })).toBeNull();
  });

  it('rejects non-integer ticks, NaN and Infinity', () => {
    expect(parsePeerEvent('{"t":"claim","slot":"a","k":1,"tick":1.5}')).toBeNull();
    expect(parsePeerEvent('{"t":"claim","slot":"a","k":1,"tick":1e999}')).toBeNull();
    expect(parsePeerEvent('{"t":"ping","kind":0,"x":1e999,"y":0}')).toBeNull();
    expect(parsePeerEvent('{"t":"ping","kind":0,"x":null,"y":0}')).toBeNull();
    expect(parseHubMsg('{"t":"pong","id":1,"now":1e999}')).toBeNull();
    expect(parseHubMsg('{"t":"pong","id":1,"now":2.5}')).toBeNull();
  });

  it('rejects __proto__ keys at any depth', () => {
    expect(parseClientMsg('{"t":"ping","id":1,"__proto__":{"x":1}}')).toBeNull();
    expect(parseClientMsg('{"__proto__":{"t":"leave"},"t":"leave"}')).toBeNull();
    expect(parsePeerEvent('{"t":"emote","id":1,"a":{"__proto__":1}}')).toBeNull();
    expect(parseHubMsg('{"t":"error","code":"x","__proto__":null}')).toBeNull();
  });

  it('rejects non-objects and bad JSON', () => {
    for (const raw of ['', 'null', '[]', '1', '"x"', '{', '{"t":}', 'undefined']) {
      expect(parseClientMsg(raw)).toBeNull();
      expect(parseHubMsg(raw)).toBeNull();
      expect(parsePeerEvent(raw)).toBeNull();
    }
    expect(parseClientMsg(undefined as unknown as string)).toBeNull();
  });

  it('limits consumed parts to 40 entries and chat to 140 characters', () => {
    const entry = ['s', 1, 2];
    const consumed = (n: number) =>
      JSON.stringify({ t: 'consumed', part: 0, of: 1, entries: Array(n).fill(entry) });
    expect(parsePeerEvent(consumed(40))).not.toBeNull();
    expect(parsePeerEvent(consumed(41))).toBeNull();
    expect(parsePeerEvent(JSON.stringify({ t: 'chat', text: 'a'.repeat(140) }))).not.toBeNull();
    expect(parsePeerEvent(JSON.stringify({ t: 'chat', text: 'a'.repeat(141) }))).toBeNull();
    expect(parsePeerEvent(JSON.stringify({ t: 'chat', text: '' }))).toBeNull();
    expect(parsePeerEvent('{"t":"consumed","part":2,"of":2,"entries":[]}')).toBeNull();
  });

  it('accepts a genome event only as base64url text that fits the 2 KB event cap', () => {
    const genome = (data: unknown) => parsePeerEvent(JSON.stringify({ t: 'genome', data }));
    expect(genome('A'.repeat(GENOME_DATA_MAX_CHARS))).not.toBeNull();
    expect(
      JSON.stringify({ t: 'genome', data: 'A'.repeat(GENOME_DATA_MAX_CHARS) }).length,
    ).toBeLessThan(EVENT_MAX_BYTES);
    expect(genome('A'.repeat(5000))).toBeNull();
    expect(genome('A'.repeat(GENOME_DATA_MAX_CHARS + 1))).toBeNull();
    expect(genome('')).toBeNull();
    expect(genome('not base64url!')).toBeNull();
    expect(genome('AB+/')).toBeNull();
    expect(genome(12)).toBeNull();
    expect(genome(undefined)).toBeNull();
  });

  it('limits emote and ping kinds', () => {
    expect(parsePeerEvent('{"t":"emote","id":6}')).toBeNull();
    expect(parsePeerEvent('{"t":"ping","kind":4,"x":0,"y":0}')).toBeNull();
  });

  it('caps message sizes in bytes: hub 4 KB, events 2 KB, signal up to its SDP cap', () => {
    const big = (n: number) => 'x'.repeat(n);
    expect(
      parseHubMsg(JSON.stringify({ t: 'error', code: 'a', pad: big(HUB_MAX_BYTES) })),
    ).toBeNull();
    expect(
      parsePeerEvent(JSON.stringify({ t: 'emote', id: 1, pad: big(EVENT_MAX_BYTES) })),
    ).toBeNull();
    // A chat of 140 three-byte characters is 420 bytes: fine. Multi-byte padding counts as bytes.
    expect(
      parsePeerEvent(JSON.stringify({ t: 'emote', id: 1, pad: '€'.repeat(EVENT_MAX_BYTES / 3) })),
    ).toBeNull();
    const sdp = (n: number) => JSON.stringify({ t: 'signal', to: PID, kind: 'offer', sdp: big(n) });
    expect(parseClientMsg(sdp(SDP_MAX_BYTES))).not.toBeNull();
    expect(parseClientMsg(sdp(20_000))).toBeNull();
    expect(
      parseClientMsg(JSON.stringify({ t: 'ping', id: 1, pad: big(HUB_MAX_BYTES) })),
    ).toBeNull();
  });
});

describe('parser fuzz', () => {
  const samples = [...clientMsgs, ...hubMsgs, ...peerEvents].map((m) => JSON.stringify(m));
  const parsers = [parseClientMsg, parseHubMsg, parsePeerEvent];

  it('never throws on random strings or mutations of valid messages (100,000 cases)', () => {
    const rng = createRng(seedFromString('fuzz-json'), 'net');
    let threw = 0;
    const alphabet = '{}[]":,0123456789abt_-.\\ \nxé€\u0000';
    for (let i = 0; i < 100_000; i++) {
      let s: string;
      if (i % 2 === 0) {
        const len = rng.int(0, 79);
        s = '';
        for (let j = 0; j < len; j++) s += alphabet[rng.int(0, alphabet.length - 1)];
      } else {
        const chars = (samples[rng.int(0, samples.length - 1)] as string).split('');
        const edits = rng.int(1, 4);
        for (let e = 0; e < edits; e++) {
          const at = rng.int(0, chars.length);
          const kind = rng.int(0, 2);
          if (kind === 0) chars.splice(at, 1);
          else if (kind === 1)
            chars.splice(at, 0, alphabet[rng.int(0, alphabet.length - 1)] as string);
          else chars[at] = alphabet[rng.int(0, alphabet.length - 1)] as string;
        }
        s = chars.join('');
      }
      for (const p of parsers) {
        try {
          p(s);
        } catch {
          threw++;
        }
      }
    }
    expect(threw).toBe(0);
    // The 100,000 cases take about 5 s alone, so the default 5 s limit flaked under load.
  }, 30_000);
});

describe('module hygiene', () => {
  it('imports nothing and uses no DOM, Node or runtime globals', () => {
    const code = readFileSync(new URL('./protocol.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/^\s*import\s/m);
    expect(code).not.toMatch(
      /\b(window|document|navigator|process|Buffer|require|TextEncoder|TextDecoder|btoa|atob|performance|crypto|setTimeout|Date)\b/,
    );
  });
});
