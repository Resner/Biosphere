import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GENOME_TEXT_LENGTH } from '../genome/codec';
import { createRng, seedFromString } from '../sim/prng';
import {
  BORN_MAX_BYTES,
  type Born,
  decodeSnapshot,
  EVENT_MAX_BYTES,
  encodeSnapshot,
  GENESIS_MAX_BYTES,
  GENOME_DATA_MAX_CHARS,
  genomeRefOf,
  HUB_MAX_BYTES,
  type HubMsg,
  LINEAGE_MAX_BYTES,
  PROTOCOL_VERSION,
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
  ready: true,
  egg: false,
  genomeRef: 0xbeef,
};

describe('snapshot codec', () => {
  it('is exactly 25 bytes and round trips within quantization', () => {
    const bytes = encodeSnapshot(snap);
    expect(bytes.length).toBe(SNAPSHOT_BYTES);
    expect(SNAPSHOT_BYTES).toBe(25);
    expect(bytes[24]).toBe(3);
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
    expect(d.ready).toBe(true);
    expect(d.egg).toBe(false);
  });

  it('keeps the four flags independent', () => {
    for (let bits = 0; bits < 16; bits++) {
      const flags = {
        alive: (bits & 1) !== 0,
        dashing: (bits & 2) !== 0,
        ready: (bits & 4) !== 0,
        egg: (bits & 8) !== 0,
      };
      const d = decodeSnapshot(encodeSnapshot({ ...snap, ...flags }));
      expect(d && { alive: d.alive, dashing: d.dashing, ready: d.ready, egg: d.egg }).toEqual(
        flags,
      );
    }
  });

  it('drops a snapshot with a flag bit it does not know', () => {
    for (const bit of [16, 32, 64, 128]) {
      const bytes = encodeSnapshot(snap);
      bytes[11] = (bytes[11] as number) | bit;
      expect(decodeSnapshot(bytes), String(bit)).toBeNull();
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
    // Version 2 had the same length but no ready or egg bits (M6 T19).
    for (const version of [0, 1, 2, 4, 255]) {
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
      // Random bytes almost never carry version 3, so half the arrays get it.
      if (len === 25 && rng.int(0, 1) === 1) b[24] = 3;
      const d = decodeSnapshot(b);
      if (d) {
        decoded++;
        expect(len).toBe(25);
        expect((b[11] as number) & ~15).toBe(0);
        expect(b[24]).toBe(3);
      } else if (len === 25 && b[24] === 3) {
        expect((b[11] as number) & ~15).not.toBe(0);
      }
    }
    expect(decoded).toBeGreaterThan(0);
  });

  it('rejects non-Uint8Array input', () => {
    expect(decodeSnapshot([] as unknown as Uint8Array)).toBeNull();
    expect(decodeSnapshot(null as unknown as Uint8Array)).toBeNull();
  });
});

const HEX = 'ab'.repeat(32);
const BEACON_SIG = 'cd'.repeat(48);
const KEY_ID = 'AbCdEf_-';
const commit = {
  commitment: {
    v: 1,
    kind: 'genesis',
    owner: PID,
    round: 33_409_900,
    req: HEX,
    t: 1_700_000_000_000,
    data: { nonce: NONCE, sig: SIG },
  },
  authSig: SIG,
  keyId: KEY_ID,
} as const;
const storedRecord = {
  record: {
    v: 1,
    rules: 4,
    kind: 'genesis',
    creature: '',
    seq: 0,
    prev: '',
    owner: PID,
    t: 1_700_000_005_000,
    body: { commit: HEX, round: 33_409_900, genome: HEX, generation: 0, karyotype: 1 },
  },
  hash: HEX,
  ownerSig: null,
  authSig: SIG,
  keyId: KEY_ID,
} as const;
const genesisMsg = {
  t: 'genesis',
  record: storedRecord,
  ownerRequest: { nonce: NONCE, sig: SIG },
  commit,
  beacon: { round: 33_409_900, signature: BEACON_SIG },
  genome: 'Ab-_09'.repeat(100),
} as const;
const life = {
  creature: HEX,
  seq: 3,
  genome: 'Ab-_09'.repeat(100),
  biomass: 40_000,
  energy: 9_000,
  health: 5_000,
  activeMs: 600_000,
  lifespanMs: 4_500_000,
  matureAtMs: 900_000,
  cooldownUntilMs: 0,
} as const;

const GENOME = 'Ab-_09'.repeat(100);
const born = {
  record: storedRecord,
  commit,
  beacon: { round: 33_409_900, signature: BEACON_SIG },
  genome: GENOME,
  parents: [GENOME, GENOME],
  mates: [storedRecord, storedRecord],
} as unknown as Born;

const mateAsk = {
  v: 1,
  kind: 'mate',
  creature: HEX,
  partner: PID2,
  partnerCreature: HEX,
  nonce: NONCE,
  sig: SIG,
} as const;
const mateCommit = {
  ...commit,
  commitment: {
    ...commit.commitment,
    kind: 'mate',
    data: { a: mateAsk, b: { ...mateAsk, partner: PID, creature: HEX } },
  },
} as const;
const mateRecord = {
  ...storedRecord,
  record: { ...storedRecord.record, kind: 'mate-commit' },
} as const;

const clientMsgs = [
  { t: 'hello', v: PROTOCOL_VERSION, playerId: PID, name: 'Alice_9', sig: SIG },
  { t: 'ping', id: 42 },
  { t: 'signal', to: PID2, kind: 'offer', sdp: 'v=0\r\no=- 1 2 IN IP4 0.0.0.0\r\n' },
  { t: 'signal', to: PID2, kind: 'answer', sdp: 'v=0' },
  { t: 'leave' },
  { t: 'genesis-request', nonce: NONCE, sig: SIG },
  { t: 'progress', n: 7, ticks: 12_000, biomass: 14_250, energy: 20_000, health: 3_700 },
  { t: 'death', cause: 'toxin', ticks: 12_345 },
  { t: 'death', cause: 'old-age', ticks: 0 },
  { t: 'history' },
  { t: 'mate-check', partner: PID2 },
  { t: 'court', ask: mateAsk },
  { t: 'accept', ask: mateAsk },
  { t: 'decline', partner: PID2 },
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
  { t: 'life', life: null, genesisIn: 0 },
  { t: 'life', life, genesisIn: 299_000 },
  { t: 'commit', commit, hatchesLeft: 2 },
  genesisMsg as unknown as HubMsg,
  { t: 'refused', reason: 'active' },
  { t: 'queued', position: 3, etaS: 90 },
  { t: 'refused', reason: 'limit', genesisIn: 300_000 },
  {
    t: 'ack',
    n: 7,
    activeMs: 400_000,
    lifespanMs: 4_500_000,
    matureAtMs: 900_000,
    cooldownUntilMs: 0,
  },
  { t: 'died', cause: 'old-age', record: genesisMsg.record },
  {
    t: 'mate-info',
    partner: PID2,
    creature: mateAsk.creature,
    reason: 'partner-cooldown',
    kinship: 0.125,
    generation: 2,
    tier: 1,
    cooldownLeftMs: 4000,
  },
  {
    t: 'mate-info',
    partner: PID2,
    creature: null,
    reason: null,
    kinship: 0,
    generation: 0,
    tier: 0,
    cooldownLeftMs: 0,
  },
  { t: 'invite', from: PID2, ask: mateAsk, kinship: 0.0625, generation: 3 },
  { t: 'declined', by: PID2 },
  { t: 'mating', commit: mateCommit, record: mateRecord },
  { t: 'born', ...born },
  { t: 'life', life: null, genesisIn: 0, pending: born },
  { t: 'history', lives: [] },
  {
    t: 'history',
    lives: [
      {
        creature: HEX,
        species: 'Aquoris natans',
        cause: 'starved',
        activeMs: 1000,
        bornT: 5,
        diedT: 9,
      },
    ],
  },
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
    expect(bad({ ...hello, v: 1 })).toBeNull();
    // Karyotype v2 genomes were a wire change (version 3), and so are the snapshot's ready and
    // egg bits (version 4, M6 T19): older clients are turned away.
    expect(PROTOCOL_VERSION).toBe(4);
    expect(bad({ ...hello, v: 2 })).toBeNull();
    expect(bad({ ...hello, v: 3 })).toBeNull();
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

describe('genesis messages', () => {
  const hubBad = (m: unknown) => parseHubMsg(JSON.stringify(m));
  const clientBad = (m: unknown) => parseClientMsg(JSON.stringify(m));
  const rec = storedRecord.record;

  it('rejects a malformed genesis-request', () => {
    expect(clientBad({ t: 'genesis-request', nonce: 'short', sig: SIG })).toBeNull();
    expect(clientBad({ t: 'genesis-request', nonce: NONCE, sig: 'short' })).toBeNull();
    expect(clientBad({ t: 'genesis-request', nonce: 5, sig: SIG })).toBeNull();
    expect(clientBad({ t: 'genesis-request', nonce: NONCE })).toBeNull();
  });

  it('rejects a malformed progress or ack', () => {
    const ok = { t: 'progress', n: 1, ticks: 30, biomass: 10_000, energy: 100, health: 100 };
    expect(clientBad(ok)).toEqual(ok);
    for (const key of ['n', 'ticks', 'biomass', 'energy', 'health']) {
      expect(clientBad({ ...ok, [key]: -1 })).toBeNull();
      expect(clientBad({ ...ok, [key]: 1.5 })).toBeNull();
      expect(clientBad({ ...ok, [key]: '3' })).toBeNull();
      expect(clientBad({ ...ok, [key]: null })).toBeNull();
      const { [key]: _gone, ...missing } = ok as Record<string, unknown>;
      expect(clientBad(missing)).toBeNull();
    }
    expect(clientBad({ ...ok, biomass: Number.MAX_SAFE_INTEGER })).toBeNull();
    expect(hubBad({ t: 'ack', n: 1 })).toBeNull();
    expect(hubBad({ t: 'ack', n: -1, activeMs: 0 })).toBeNull();
    expect(hubBad({ t: 'ack', n: 1, activeMs: 1.5 })).toBeNull();
  });

  it('rejects wrong-typed or malformed life, commit and refused', () => {
    expect(hubBad({ t: 'life', life: null })).toBeNull();
    expect(hubBad({ t: 'life', life: null, genesisIn: -1 })).toBeNull();
    expect(hubBad({ t: 'life', life: { ...life, creature: 'x' }, genesisIn: 0 })).toBeNull();
    expect(hubBad({ t: 'life', life: { ...life, seq: 1.5 }, genesisIn: 0 })).toBeNull();
    expect(hubBad({ t: 'life', life: 'none', genesisIn: 0 })).toBeNull();
    expect(hubBad({ t: 'commit', commit, hatchesLeft: -1 })).toBeNull();
    expect(hubBad({ t: 'commit', commit: { ...commit, keyId: 'no' }, hatchesLeft: 1 })).toBeNull();
    expect(
      hubBad({ t: 'commit', commit: { ...commit, authSig: 'no' }, hatchesLeft: 1 }),
    ).toBeNull();
    expect(hubBad({ t: 'queued', position: 0, etaS: 0 })).toBeNull();
    expect(hubBad({ t: 'queued', position: 1.5, etaS: 0 })).toBeNull();
    expect(hubBad({ t: 'queued', position: 1, etaS: -1 })).toBeNull();
    expect(hubBad({ t: 'queued', position: 1 })).toBeNull();
    expect(hubBad({ t: 'refused', reason: 'Not Allowed' })).toBeNull();
    expect(hubBad({ t: 'refused', reason: 'limit', genesisIn: 'soon' })).toBeNull();
  });

  it('rejects a commitment of another kind, a float round or a bad owner', () => {
    const c = commit.commitment;
    const with_ = (commitment: object) =>
      hubBad({ t: 'commit', commit: { ...commit, commitment }, hatchesLeft: 1 });
    expect(with_({ ...c, kind: 'mate' })).toBeNull();
    expect(with_({ ...c, round: 1.5 })).toBeNull();
    expect(with_({ ...c, owner: 'short' })).toBeNull();
    expect(with_({ ...c, data: { nonce: 'x' } })).toBeNull();
    expect(with_({ ...c, v: 2 })).toBeNull();
  });

  it('rejects a malformed genesis', () => {
    const g = genesisMsg as unknown as Record<string, unknown>;
    expect(hubBad({ ...g, genome: 'not base64 !' })).toBeNull();
    expect(hubBad({ ...g, genome: 'A'.repeat(GENOME_DATA_MAX_CHARS + 1) })).toBeNull();
    expect(hubBad({ ...g, beacon: { round: 5, signature: 'zz' } })).toBeNull();
    expect(hubBad({ ...g, beacon: { round: 0, signature: BEACON_SIG } })).toBeNull();
    expect(hubBad({ ...g, ownerRequest: { nonce: NONCE } })).toBeNull();
    expect(hubBad({ ...g, record: { ...storedRecord, hash: 'abc' } })).toBeNull();
    expect(hubBad({ ...g, record: { ...storedRecord, ownerSig: 'short' } })).toBeNull();
    expect(
      hubBad({ ...g, record: { ...storedRecord, record: { ...rec, kind: 'mate' } } }),
    ).toBeNull();
    expect(hubBad({ ...g, record: { ...storedRecord, record: { ...rec, v: 2 } } })).toBeNull();
    expect(
      hubBad({ ...g, record: { ...storedRecord, record: { ...rec, owner: 'x' } } }),
    ).toBeNull();
    expect(hubBad({ ...g, record: { ...storedRecord, record: { ...rec, body: [1] } } })).toBeNull();
    expect(
      hubBad({ ...g, record: { ...storedRecord, record: { ...rec, body: { a: 1.5 } } } }),
    ).toBeNull();
    expect(
      hubBad({ ...g, record: { ...storedRecord, record: { ...rec, body: { a: null } } } }),
    ).toBeNull();
    expect(
      hubBad({ ...g, record: { ...storedRecord, record: { ...rec, body: { a: true } } } }),
    ).toBeNull();
  });

  it('bounds a record body by depth, entries and string length', () => {
    const g = genesisMsg as unknown as Record<string, unknown>;
    const withBody = (body: unknown) =>
      hubBad({ ...g, record: { ...storedRecord, record: { ...rec, body } } });
    expect(withBody({ a: { b: { c: { d: { e: 1 } } } } })).toBeNull();
    expect(withBody({ a: 'x'.repeat(257) })).toBeNull();
    expect(
      withBody(Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, i]))),
    ).toBeNull();
    expect(withBody({ list: Array.from({ length: 33 }, (_, i) => i) })).toBeNull();
    expect(withBody({ a: { b: 1 }, list: [1, 2, 'x'] })).not.toBeNull();
  });

  it('keeps the largest genesis within GENESIS_MAX_BYTES and caps anything bigger', () => {
    const body = Object.fromEntries(
      Array.from({ length: 32 }, (_, i) => [`k${String(i).padStart(2, '0')}`, 'x'.repeat(40)]),
    );
    const big = {
      ...genesisMsg,
      record: { ...storedRecord, record: { ...rec, body } },
      genome: 'A'.repeat(GENOME_DATA_MAX_CHARS),
    };
    const raw = JSON.stringify(big);
    expect(raw.length).toBeGreaterThan(HUB_MAX_BYTES);
    expect(raw.length).toBeLessThanOrEqual(GENESIS_MAX_BYTES);
    expect(parseHubMsg(raw)).not.toBeNull();
    expect(parseHubMsg(JSON.stringify({ ...big, pad: 'x'.repeat(GENESIS_MAX_BYTES) }))).toBeNull();
  });

  it('caps born at BORN_MAX_BYTES and rejects a malformed one', () => {
    const msg = { t: 'born', ...born };
    expect(parseHubMsg(JSON.stringify(msg))).not.toBeNull();
    expect(parseHubMsg(JSON.stringify({ ...msg, pad: 'x'.repeat(BORN_MAX_BYTES) }))).toBeNull();
    expect(parseHubMsg(JSON.stringify({ ...msg, parents: [GENOME] }))).toBeNull();
    expect(parseHubMsg(JSON.stringify({ ...msg, mates: [msg.mates[0]] }))).toBeNull();
    expect(parseHubMsg(JSON.stringify({ ...msg, genome: 'no spaces allowed' }))).toBeNull();
    expect(
      parseHubMsg(JSON.stringify({ t: 'life', life: null, genesisIn: 0, pending: { x: 1 } })),
    ).toBeNull();
  });

  it('caps the other new messages at HUB_MAX_BYTES', () => {
    const pad = 'x'.repeat(HUB_MAX_BYTES);
    expect(parseHubMsg(JSON.stringify({ t: 'life', life: null, genesisIn: 0, pad }))).toBeNull();
    expect(parseHubMsg(JSON.stringify({ t: 'commit', commit, hatchesLeft: 1, pad }))).toBeNull();
    expect(
      parseClientMsg(JSON.stringify({ t: 'genesis-request', nonce: NONCE, sig: SIG, pad })),
    ).toBeNull();
  });

  it.each([
    { t: 'court', ask: { ...mateAsk, kind: 'genesis' } },
    { t: 'court', ask: { ...mateAsk, nonce: 'short' } },
    { t: 'accept', ask: 'nope' },
    { t: 'mate-check', partner: 'short' },
    { t: 'decline' },
  ])('rejects the malformed client message %j', (m) => {
    expect(parseClientMsg(JSON.stringify(m))).toBeNull();
  });

  it('rejects a mating whose commitment is not a pair of asks, and an oversized one', () => {
    const bad = { ...mateCommit, commitment: { ...mateCommit.commitment, data: { a: mateAsk } } };
    expect(
      parseHubMsg(JSON.stringify({ t: 'mating', commit: bad, record: mateRecord })),
    ).toBeNull();
    const pad = 'x'.repeat(GENESIS_MAX_BYTES);
    expect(
      parseHubMsg(JSON.stringify({ t: 'mating', commit: mateCommit, record: mateRecord, pad })),
    ).toBeNull();
    expect(
      parseHubMsg(
        JSON.stringify({
          t: 'mate-info',
          partner: PID2,
          creature: null,
          reason: null,
          kinship: 2,
          generation: 0,
          tier: 0,
          cooldownLeftMs: 0,
        }),
      ),
    ).toBeNull();
  });

  it('never throws on 2,000 random strings or mutated valid messages', () => {
    const rng = createRng(seedFromString('fuzz-genesis'), 'net');
    const samples = [
      { t: 'genesis-request', nonce: NONCE, sig: SIG },
      { t: 'life', life, genesisIn: 1 },
      { t: 'commit', commit, hatchesLeft: 1 },
      genesisMsg,
      { t: 'refused', reason: 'limit', genesisIn: 5 },
      { t: 'progress', n: 1, ticks: 30, biomass: 10_000, energy: 100, health: 100 },
      {
        t: 'ack',
        n: 1,
        activeMs: 1000,
        lifespanMs: 4_500_000,
        matureAtMs: 900_000,
        cooldownUntilMs: 0,
      },
      { t: 'death', cause: 'uv', ticks: 90 },
      { t: 'died', cause: 'uv', record: genesisMsg.record },
      { t: 'history', lives: [] },
      { t: 'mate-check', partner: PID2 },
      { t: 'court', ask: mateAsk },
      { t: 'mating', commit: mateCommit, record: mateRecord },
      { t: 'invite', from: PID2, ask: mateAsk, kinship: 0.5, generation: 3 },
      { t: 'promote', request: promoteRequest, sig: SIG },
      { t: 'restored', life },
      { t: 'promoted', life, parent: null },
      { t: 'lineage', creatures: [lineageEntry], pedigree: [pedigreeNode] },
      { t: 'life', life: null, genesisIn: 0, fallback: { pending: true, ancestor } },
    ].map((m) => JSON.stringify(m));
    const alphabet = '{}[]":,0123456789abt_-.\\ \nxé€';
    let threw = 0;
    for (let i = 0; i < 2000; i++) {
      let text: string;
      if (i % 2 === 0) {
        text = Array.from(
          { length: rng.int(0, 79) },
          () => alphabet[rng.int(0, alphabet.length - 1)],
        ).join('');
      } else {
        const chars = (samples[rng.int(0, samples.length - 1)] as string).split('');
        for (let e = rng.int(1, 4); e > 0; e--) {
          const at = rng.int(0, chars.length - 1);
          chars[at] = alphabet[rng.int(0, alphabet.length - 1)] as string;
        }
        text = chars.join('');
      }
      for (const parse of [parseClientMsg, parseHubMsg]) {
        try {
          parse(text);
        } catch {
          threw++;
        }
      }
    }
    expect(threw).toBe(0);
  });
});

const promoteRequest = {
  v: 1,
  rules: 5,
  kind: 'promote',
  creature: HEX,
  seq: 1,
  prev: HEX,
  owner: PID,
  body: { role: 'child', parent: HEX },
};
const ancestor = { ...life, hash: HEX };
const lineageEntry = {
  creature: HEX,
  status: 'checkpoint',
  generation: 2,
  species: 'Aquoris natans',
  genome: 'A'.repeat(GENOME_TEXT_LENGTH),
  activeMs: 5,
  lifespanMs: 10,
  hash: HEX,
  chainParent: null,
};
const pedigreeNode = {
  id: HEX,
  parents: [HEX, HEX],
  species: 'Aquoris natans',
  genome: 'A'.repeat(GENOME_TEXT_LENGTH),
};

describe('promotion, restore and lineage messages', () => {
  it('round trips requests, answers and the fallback', () => {
    for (const t of ['promote', 'restore'] as const) {
      const msg = { t, request: { ...promoteRequest, kind: t }, sig: SIG };
      expect(parseClientMsg(JSON.stringify(msg))).toEqual(msg);
    }
    expect(parseClientMsg('{"t":"lineage"}')).toEqual({ t: 'lineage' });
    for (const msg of [
      { t: 'restored', life },
      { t: 'promoted', life, parent: null },
      { t: 'promoted', life, parent: storedRecord },
      { t: 'lineage', creatures: [lineageEntry], pedigree: [pedigreeNode] },
      { t: 'life', life: null, genesisIn: 3, fallback: { pending: false, ancestor } },
      { t: 'died', cause: 'uv', record: storedRecord, fallback: { pending: true, ancestor: null } },
    ]) {
      expect(parseHubMsg(JSON.stringify(msg))).toEqual(msg);
    }
  });

  it('rejects malformed requests, fallbacks and lineage entries', () => {
    const bad = (m: unknown) => parseClientMsg(JSON.stringify(m));
    expect(bad({ t: 'promote', request: { ...promoteRequest, t: 1 }, sig: SIG })).toBeNull();
    expect(bad({ t: 'promote', request: { ...promoteRequest, seq: 1.5 }, sig: SIG })).toBeNull();
    expect(bad({ t: 'promote', request: { ...promoteRequest, owner: 'x' }, sig: SIG })).toBeNull();
    expect(bad({ t: 'promote', request: promoteRequest, sig: 'short' })).toBeNull();
    expect(bad({ t: 'restore', request: promoteRequest })).toBeNull();
    const hub = (m: unknown) => parseHubMsg(JSON.stringify(m));
    expect(
      hub({ t: 'life', life: null, genesisIn: 0, fallback: { pending: 1, ancestor: null } }),
    ).toBeNull();
    expect(
      hub({ t: 'life', life: null, genesisIn: 0, fallback: { pending: true, ancestor: life } }),
    ).toBeNull();
    expect(
      hub({ t: 'lineage', creatures: [{ ...lineageEntry, status: 'zombie' }], pedigree: [] }),
    ).toBeNull();
    expect(
      hub({ t: 'lineage', creatures: [], pedigree: [{ ...pedigreeNode, parents: [HEX] }] }),
    ).toBeNull();
    expect(hub({ t: 'lineage', creatures: Array(65).fill(lineageEntry), pedigree: [] })).toBeNull();
    expect(hub({ t: 'lineage', creatures: [], pedigree: Array(65).fill(pedigreeNode) })).toBeNull();
    expect(hub({ t: 'died', cause: 'uv', record: storedRecord, fallback: 3 })).toBeNull();
  });

  it('fits a full lineage of karyotype v2 genomes in LINEAGE_MAX_BYTES', () => {
    const full = JSON.stringify({
      t: 'lineage',
      creatures: Array(64).fill(lineageEntry),
      pedigree: Array(64).fill(pedigreeNode),
    });
    expect(full.length).toBeLessThan(LINEAGE_MAX_BYTES);
    expect(parseHubMsg(full)).not.toBeNull();
  });
});

describe('death and history messages', () => {
  it('rejects an unknown cause, a missing tick count and more than 20 lives', () => {
    expect(parseClientMsg(JSON.stringify({ t: 'death', cause: 'boredom', ticks: 1 }))).toBeNull();
    expect(parseClientMsg(JSON.stringify({ t: 'death', cause: 'toxin' }))).toBeNull();
    expect(parseClientMsg(JSON.stringify({ t: 'death', cause: 'toxin', ticks: -1 }))).toBeNull();
    const one = {
      creature: HEX,
      species: 'Aquoris natans',
      cause: 'uv',
      activeMs: 1,
      bornT: 1,
      diedT: 2,
    };
    const many = (n: number) => JSON.stringify({ t: 'history', lives: Array(n).fill(one) });
    expect(parseHubMsg(many(20))).not.toBeNull();
    expect(parseHubMsg(many(21))).toBeNull();
    expect(
      parseHubMsg(JSON.stringify({ t: 'history', lives: [{ ...one, species: '<b>x</b>' }] })),
    ).toBeNull();
    expect(parseHubMsg(JSON.stringify({ t: 'ack', n: 1, activeMs: 2 }))).toBeNull();
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
  it('imports no runtime module and uses no DOM, Node or runtime globals', () => {
    const code = readFileSync(new URL('./protocol.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    // Type-only imports are erased, so they pull in no code.
    expect(code).not.toMatch(/^\s*import\s(?!type\s)/m);
    expect(code).not.toMatch(
      /\b(window|document|navigator|process|Buffer|require|TextEncoder|TextDecoder|btoa|atob|performance|crypto|setTimeout|Date)\b/,
    );
  });
});
