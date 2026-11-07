import { describe, expect, it } from 'vitest';
import { createRng, seedFromString } from '../sim/prng';
import {
  byteLength,
  EVENT_MAX_BYTES,
  GOSSIP_MAX,
  NEAR_MAX,
  NEAR_MAX_BYTES,
  parseClientMsg,
  parseHubMsg,
  parsePeerEvent,
  RELAY_MAX_BYTES,
  SDP_MAX_BYTES,
  SWARM_MAX,
  WELCOME_MAX_BYTES,
} from './protocol';

// Protocol 11 (M11 T2): the world, the directory's messages, seat tickets and the peer events of
// gossip, relayed signaling and snapshot rates. Every new message refuses a field it doesn't know.

const PID = 'A'.repeat(43);
const PID2 = 'B'.repeat(43);
const SIG = 'c'.repeat(86);
const TOP = 2 ** 29;

const ticket = {
  seat: {
    v: 1,
    kind: 'seat',
    player: PID,
    name: 'Alice_9',
    world: 'w1',
    t: 1_700_000_000_000,
    until: 1_700_000_900_000,
  },
  authSig: SIG,
  keyId: 'AbCdEf_-',
};

const welcome = {
  t: 'welcome',
  world: {
    id: 'w1',
    seed: 'seed12345678',
    epoch: 4,
    centre: { x: 131_072, y: 131_072 },
    size: 262_144,
  },
  you: { spawnHint: { x: 131_400, y: 131_000.5 } },
  members: [{ playerId: PID2, name: 'bob' }],
  ice: [{ urls: 'stun:stun.example.org' }],
  turn: false,
  now: 1_700_000_001_234,
  ticket,
};

const near = {
  t: 'near',
  leaf: { x: 131_072, y: 0, size: 131_072 },
  peers: [
    { id: PID2, name: 'bob', x: 131_100.5, y: 130_900, r: 12.5, age: 1500 },
    { id: 'C'.repeat(43), name: 'carol', x: 0, y: 262_143.875, r: 4096, age: 0 },
  ],
  swarm: [
    [131_000, 131_050.25],
    [0, 0],
  ],
};

const where = { t: 'where', x: 131_072.5, y: 0, r: 10, aoi: 233.2 };
const relay = {
  t: 'relay',
  from: PID,
  to: PID2,
  kind: 'offer',
  sdp: 'v=0\r\no=- 1 2 IN IP4 0.0.0.0\r\n',
  cls: 3,
  at: 1_700_000_000_123,
  pos: [131_072, 131_000.5, 10],
  sig: SIG,
};
const peers = {
  t: 'peers',
  list: [
    [PID2, 100, 200.5, 10],
    ['C'.repeat(43), 262_000, 3, 4096],
  ],
};

const clientMsgs: object[] = [where, { t: 'gone' }];
const hubMsgs: object[] = [
  welcome,
  { ...welcome, ticket: undefined },
  near,
  { ...near, peers: [], swarm: [] },
  { t: 'leaf', leaf: { x: 0, y: 65_536, size: 65_536 } },
  { t: 'seat', ticket },
  { t: 'signal', from: PID, kind: 'answer', sdp: 'v=0', at: [131_072, 5, 20] },
];
const peerEvents: object[] = [
  { t: 'hello', ticket },
  peers,
  { t: 'peers', list: [] },
  relay,
  { ...relay, kind: 'answer' },
  { ...relay, kind: 'refuse', sdp: '', cls: 0 },
  { t: 'rate', hz: 1 },
  { t: 'rate', hz: 2 },
  { t: 'rate', hz: 5 },
  { t: 'rate', hz: 10 },
  { t: 'claim', slot: 't2c4_7_s3', k: 1, tick: 9 },
  { t: 'consumed', part: 0, of: 1, entries: [['t4c0_0_s9', 3, 40]] },
];

const json = (m: unknown) => JSON.stringify(m);
const strip = (m: object) => JSON.parse(json(m)) as unknown;

describe('protocol 11 round trips', () => {
  it.each(clientMsgs)('client %j', (m) => expect(parseClientMsg(json(m))).toEqual(strip(m)));
  it.each(hubMsgs)('hub %j', (m) => expect(parseHubMsg(json(m))).toEqual(strip(m)));
  it.each(peerEvents)('peer %j', (m) => expect(parsePeerEvent(json(m))).toEqual(strip(m)));
});

type Parse = (raw: string) => unknown;
/** Every top-level field of `m` but `t` missing, and an extra field, parse to null. */
function refusesMissingAndExtra(parse: Parse, m: Record<string, unknown>) {
  for (const key of Object.keys(m)) {
    if (key === 't') continue;
    const { [key]: _, ...rest } = m;
    expect(parse(json(rest)), `without ${key}`).toBeNull();
  }
  expect(parse(json({ ...m, extra: 1 })), 'extra').toBeNull();
}

describe('where and gone', () => {
  const bad = (over: object) => parseClientMsg(json({ ...where, ...over }));

  it('refuses a missing or extra field', () => {
    refusesMissingAndExtra(parseClientMsg, where);
    expect(parseClientMsg(json({ t: 'gone', why: 'x' }))).toBeNull();
  });

  it('takes a position in 0 to 2^29, a radius of 1 to 4096 and an AoI of 1 to 40,000', () => {
    expect(bad({ x: 0, y: TOP - 0.125, r: 1, aoi: 1 })).not.toBeNull();
    expect(bad({ r: 4096, aoi: 40_000 })).not.toBeNull();
    for (const over of [
      { x: -0.5 },
      { y: TOP },
      { x: '5' },
      { y: null },
      { r: 0.99 },
      { r: 4097 },
      { aoi: 0.5 },
      { aoi: 40_001 },
      { x: 2 ** 30 },
    ]) {
      expect(bad(over), json(over)).toBeNull();
    }
  });
});

describe('the welcome', () => {
  it('names the world, not a pond, and refuses unknown fields in it', () => {
    expect(parseHubMsg(json({ ...welcome, pond: welcome.world, world: undefined }))).toBeNull();
    expect(parseHubMsg(json({ ...welcome, world: { ...welcome.world, extra: 1 } }))).toBeNull();
    for (const key of Object.keys(welcome.world)) {
      const { [key]: _, ...rest } = welcome.world as Record<string, unknown>;
      expect(parseHubMsg(json({ ...welcome, world: rest })), key).toBeNull();
    }
    expect(parseHubMsg(json({ ...welcome, world: { ...welcome.world, size: 0 } }))).toBeNull();
  });

  it('refuses a malformed ticket', () => {
    expect(parseHubMsg(json({ ...welcome, ticket: { ...ticket, keyId: 'x' } }))).toBeNull();
    expect(parseHubMsg(json({ ...welcome, ticket: null }))).toBeNull();
  });

  it('still fits the worst case with a ticket', () => {
    const members = Array.from({ length: 23 }, (_, i) => ({
      playerId: String.fromCharCode(65 + i).repeat(43),
      name: 'n'.repeat(16),
    }));
    const worst = {
      ...welcome,
      world: { ...welcome.world, id: 'w'.repeat(64), seed: 's'.repeat(64) },
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
      ticket: { ...ticket, seat: { ...ticket.seat, name: 'n'.repeat(16), world: 'w'.repeat(64) } },
    };
    expect(byteLength(json(worst))).toBeLessThanOrEqual(WELCOME_MAX_BYTES);
    expect(parseHubMsg(json(worst))).toEqual(worst);
  });
});

describe('the signal’s position', () => {
  const signal = hubMsgs[6] as Record<string, unknown>;
  it('is optional, and refused out of range or malformed', () => {
    expect(parseHubMsg(json({ ...signal, at: undefined }))).not.toBeNull();
    for (const at of [[0, 0], [0, 0, 0], [-1, 0, 5], [0, TOP, 5], [0, 0, 5, 1], 'x', null]) {
      expect(parseHubMsg(json({ ...signal, at })), json(at)).toBeNull();
    }
  });
});

describe('near', () => {
  const peer = near.peers[0] as Record<string, unknown>;
  const withPeers = (list: unknown[]) => parseHubMsg(json({ ...near, peers: list }));
  const ids = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      ...peer,
      id: `${i.toString(36).padStart(2, '0')}${'P'.repeat(41)}`,
    }));

  it('holds at most 48 peers and 64 swarm points', () => {
    expect(NEAR_MAX).toBe(48);
    expect(SWARM_MAX).toBe(64);
    expect(withPeers(ids(48))).not.toBeNull();
    expect(withPeers(ids(49))).toBeNull();
    const swarm = (n: number) => Array.from({ length: n }, (_, i) => [i, i]);
    expect(parseHubMsg(json({ ...near, swarm: swarm(64) }))).not.toBeNull();
    expect(parseHubMsg(json({ ...near, swarm: swarm(65) }))).toBeNull();
  });

  it('is within NEAR_MAX_BYTES', () => {
    const full = {
      ...near,
      leaf: { x: 262_144, y: 262_144, size: 1024 },
      peers: ids(48).map((p, i) => ({ ...p, x: 200_000.875 + i, y: 200_000.125, age: 29_999 })),
      swarm: Array.from({ length: 64 }, (_, i) => [200_000.5 + i, 200_000.25]),
    };
    const raw = json(full);
    expect(byteLength(raw)).toBeGreaterThan(EVENT_MAX_BYTES);
    expect(byteLength(raw)).toBeLessThan(NEAR_MAX_BYTES);
    expect(parseHubMsg(raw)).toEqual(full);
    const pad = (n: number) => `${raw.slice(0, -1)}${' '.repeat(n - byteLength(raw))}}`;
    expect(parseHubMsg(pad(NEAR_MAX_BYTES))).toEqual(full);
    expect(parseHubMsg(pad(NEAR_MAX_BYTES + 1))).toBeNull();
  });

  it('refuses a missing, extra or out-of-range field at every level', () => {
    refusesMissingAndExtra(parseHubMsg, near);
    for (const key of Object.keys(peer)) {
      const { [key]: _, ...rest } = peer;
      expect(withPeers([rest]), `peer without ${key}`).toBeNull();
    }
    expect(withPeers([{ ...peer, extra: 1 }])).toBeNull();
    for (const over of [
      { id: 'short' },
      { name: 'x' },
      { name: 'bad name' },
      { x: -1 },
      { y: TOP },
      { r: 0 },
      { r: 4097 },
      { age: -1 },
      { age: 1.5 },
    ]) {
      expect(withPeers([{ ...peer, ...over }]), json(over)).toBeNull();
    }
    expect(withPeers([peer, peer]), 'a repeated id').toBeNull();
    for (const leaf of [
      { x: 0, y: 0 },
      { x: 0, y: 0, size: 0 },
      { x: -1, y: 0, size: 1024 },
      { x: 0, y: 0, size: 1024.5 },
      { x: 0, y: 0, size: 1024, extra: 1 },
    ]) {
      expect(parseHubMsg(json({ ...near, leaf })), json(leaf)).toBeNull();
      expect(parseHubMsg(json({ t: 'leaf', leaf })), json(leaf)).toBeNull();
    }
    for (const point of [[1], [1, 2, 3], [-1, 0], [0, TOP], { x: 0, y: 0 }]) {
      expect(parseHubMsg(json({ ...near, swarm: [point] })), json(point)).toBeNull();
    }
  });

  it('leaf and seat refuse extra and missing fields', () => {
    refusesMissingAndExtra(parseHubMsg, hubMsgs[4] as Record<string, unknown>);
    refusesMissingAndExtra(parseHubMsg, hubMsgs[5] as Record<string, unknown>);
  });
});

describe('peer events', () => {
  const ev = (m: unknown) => parsePeerEvent(json(m));

  it('hello carries a well-formed ticket and nothing else', () => {
    refusesMissingAndExtra(parsePeerEvent, { t: 'hello', ticket });
    expect(ev({ t: 'hello', ticket: { ...ticket, authSig: 'short' } })).toBeNull();
  });

  it('peers lists at most 16 distinct, well-formed ids', () => {
    expect(GOSSIP_MAX).toBe(16);
    const entry = (i: number) => [`${i.toString(36).padStart(2, '0')}${'G'.repeat(41)}`, 1, 2, 3];
    const list = (n: number) => ({
      t: 'peers',
      list: Array.from({ length: n }, (_, i) => entry(i)),
    });
    expect(ev(list(16))).not.toBeNull();
    expect(ev(list(17))).toBeNull();
    expect(ev({ t: 'peers', list: [entry(1), entry(1)] })).toBeNull();
    refusesMissingAndExtra(parsePeerEvent, peers);
    for (const e of [
      ['short', 1, 2, 3],
      [PID, -1, 2, 3],
      [PID, 1, TOP, 3],
      [PID, 1, 2, 0],
      [PID, 1, 2, 4097],
      [PID, 1, 2],
      [PID, 1, 2, 3, 4],
    ]) {
      expect(ev({ t: 'peers', list: [e] }), json(e)).toBeNull();
    }
  });

  it('relay: its fields, its sdp within SDP_MAX_BYTES and the whole within RELAY_MAX_BYTES', () => {
    refusesMissingAndExtra(parsePeerEvent, relay);
    for (const over of [
      { from: 'short' },
      { to: 'short' },
      { kind: 'pranswer' },
      { sdp: '' },
      { kind: 'refuse' },
      { cls: 5 },
      { cls: 1.5 },
      { cls: -1 },
      { cls: '1' },
      { sdp: 5 },
      { at: 1.5 },
      { at: -1 },
      { pos: [1, 2] },
      { pos: [1, 2, 0] },
      { sig: 'short' },
    ]) {
      expect(ev({ ...relay, ...over }), json(over)).toBeNull();
    }
    const sdp = 'a'.repeat(SDP_MAX_BYTES);
    expect(ev({ ...relay, sdp })).not.toBeNull();
    expect(ev({ ...relay, sdp: `${sdp}a` })).toBeNull();
    const raw = json({ ...relay, sdp });
    expect(byteLength(raw)).toBeGreaterThan(EVENT_MAX_BYTES);
    const pad = (n: number) => `${raw.slice(0, -1)}${' '.repeat(n - byteLength(raw))}}`;
    expect(RELAY_MAX_BYTES).toBe(10_240);
    expect(byteLength(pad(RELAY_MAX_BYTES))).toBe(10_240);
    expect(parsePeerEvent(pad(RELAY_MAX_BYTES))).not.toBeNull();
    expect(parsePeerEvent(pad(RELAY_MAX_BYTES + 1))).toBeNull();
  });

  it('every other event stays within EVENT_MAX_BYTES', () => {
    const chat = json({ t: 'chat', text: 'hi' });
    const padded = `${chat.slice(0, -1)}${' '.repeat(EVENT_MAX_BYTES - chat.length + 1)}}`;
    expect(byteLength(padded)).toBe(EVENT_MAX_BYTES + 1);
    expect(parsePeerEvent(padded)).toBeNull();
    const rate = json({ t: 'rate', hz: 5 });
    expect(parsePeerEvent(`${rate.slice(0, -1)}${' '.repeat(EVENT_MAX_BYTES)}}`)).toBeNull();
  });

  it('rate is 1, 2, 5 or 10', () => {
    refusesMissingAndExtra(parsePeerEvent, { t: 'rate', hz: 5 });
    for (const hz of [0, 3, 4, 2.5, 20, '5', null])
      expect(ev({ t: 'rate', hz }), json(hz)).toBeNull();
  });

  it('claim and consumed take layer ids t1 to t4 before the cell', () => {
    const claim = (slot: string) => ev({ t: 'claim', slot, k: 1, tick: 2 });
    for (const slot of ['t1c0_0_s0', 't2c4_7_s3', 't4c12_99_s9', 'c3_5_s2', 'x0123456789abcdef_3'])
      expect(claim(slot), slot).not.toBeNull();
    for (const slot of ['t0c4_7_s3', 't5c4_7_s3', 't2c4_7', 't2x4_7_s3', 't2'])
      expect(claim(slot), slot).toBeNull();
    const consumed = (slot: string) =>
      ev({ t: 'consumed', part: 0, of: 1, entries: [[slot, 1, 2]] });
    expect(consumed('t3c1_1_s1')).not.toBeNull();
    expect(consumed('t0c1_1_s1')).toBeNull();
  });
});

/** Random JSON, and valid messages with random fields swapped, deleted or added. */
function fuzzed(seed: string, samples: object[], n: number): string[] {
  const rng = createRng(seedFromString(seed), 'net');
  const atoms = [0, -1, 1.5, 2 ** 29, 4096, 1e308, '', 'x', PID, SIG, null, true, [], {}];
  const pick = <T>(xs: readonly T[]): T => xs[rng.int(0, xs.length - 1)] as T;
  const value = (depth: number): unknown => {
    const k = rng.int(0, depth > 2 ? 0 : 3);
    if (k === 0) return pick(atoms);
    if (k === 1) return Array.from({ length: rng.int(0, 5) }, () => value(depth + 1));
    if (k === 2) return Object.fromEntries([['t', pick(['near', 'relay', 'where', 'hello'])]]);
    return mutate(structuredClone(pick(samples)), depth + 1);
  };
  const mutate = (v: unknown, depth: number): unknown => {
    if (Array.isArray(v)) {
      if (v.length > 0 && rng.int(0, 1)) v[rng.int(0, v.length - 1)] = value(depth);
      else v.push(value(depth));
      return v;
    }
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o);
      const key = pick(keys);
      const r = rng.int(0, 3);
      if (r === 0) delete o[key];
      else if (r === 1) o[key] = value(depth);
      else if (r === 2) o[key] = mutate(o[key], depth + 1);
      else o[`k${rng.int(0, 9)}`] = value(depth);
      return o;
    }
    return value(depth);
  };
  return Array.from({ length: n }, () => {
    const s = json(rng.int(0, 9) === 0 ? value(0) : mutate(structuredClone(pick(samples)), 0));
    return rng.int(0, 19) === 0 ? s.slice(0, rng.int(0, s.length)) : s;
  });
}

describe('fuzz', () => {
  it.each([
    ['client', parseClientMsg as Parse, clientMsgs],
    ['hub', parseHubMsg as Parse, hubMsgs],
    ['peer', parsePeerEvent as Parse, peerEvents],
  ] as const)('10,000 fuzzed %s messages never throw', (name, parse, samples) => {
    let parsed = 0;
    for (const raw of fuzzed(`protocol-world-${name}`, samples, 10_000)) {
      if (parse(raw) !== null) parsed++;
    }
    expect(parsed).toBeGreaterThan(0);
  });
});
