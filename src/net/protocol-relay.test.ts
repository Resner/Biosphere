import { describe, expect, it } from 'vitest';
import { createRng, seedFromString } from '../sim/prng';
import {
  type ClientMsg,
  type HubMsg,
  PROTOCOL_VERSION,
  parseClientMsg,
  parseHubMsg,
  QUEUE_WHYS,
  RELAY_KB_MAX,
} from './protocol';

// Protocol 13 (M13 T4, ADR 0067): a `progress` may carry the page's relay report, and `queued` says
// why the session waits.

const progress = {
  t: 'progress',
  n: 7,
  ticks: 12_000,
  biomass: 14_250,
  energy: 20_000,
  health: 3_700,
};
const relay = { links: 3, relayed: 1, kb: 120 };
const client = (m: unknown) => parseClientMsg(JSON.stringify(m));
const hub = (m: unknown) => parseHubMsg(JSON.stringify(m));

describe('protocol 14', () => {
  it('is version 14: a protocol-13 hello parses to null', () => {
    expect(PROTOCOL_VERSION).toBe(14);
    const hello = { t: 'hello', playerId: 'A'.repeat(43), name: 'Alice_9', sig: 'c'.repeat(86) };
    expect(client({ ...hello, v: 14 })).not.toBeNull();
    expect(client({ ...hello, v: 13 })).toBeNull();
    expect(client({ ...hello, v: 12 })).toBeNull();
  });

  it.each<ClientMsg>([
    { ...progress, relay } as ClientMsg,
    { ...progress, relay: { links: 0, relayed: 0, kb: 0 } } as ClientMsg,
    { ...progress, relay: { links: 32, relayed: 32, kb: RELAY_KB_MAX } } as ClientMsg,
    progress as ClientMsg,
  ])('round-trips the client message %j', (m) => {
    expect(client(m)).toEqual(m);
  });

  it.each<HubMsg>(QUEUE_WHYS.map((why) => ({ t: 'queued', position: 2, etaS: 60, why })))(
    'round-trips the hub message %j',
    (m) => {
      expect(hub(m)).toEqual(m);
    },
  );

  it.each([
    ['33 links', { links: 33, relayed: 0, kb: 0 }],
    ['relayed above links', { links: 2, relayed: 3, kb: 0 }],
    ['kb of -1', { links: 2, relayed: 1, kb: -1 }],
    ['kb of 1.5', { links: 2, relayed: 1, kb: 1.5 }],
    ['kb of 16,385', { links: 2, relayed: 1, kb: 16_385 }],
    ['an extra field', { links: 2, relayed: 1, kb: 3, ms: 10 }],
    ['a missing field', { links: 2, relayed: 1 }],
    ['negative links', { links: -1, relayed: 0, kb: 0 }],
    ['a string', 'relay'],
    ['null', null],
    ['an array', [2, 1, 3]],
  ])('refuses a relay report with %s', (_label, bad) => {
    expect(client({ ...progress, relay: bad })).toBeNull();
  });

  it('refuses a queued without a known why', () => {
    expect(hub({ t: 'queued', position: 1, etaS: 30 })).toBeNull();
    expect(hub({ t: 'queued', position: 1, etaS: 30, why: 'later' })).toBeNull();
    expect(hub({ t: 'queued', position: 1, etaS: 30, why: null })).toBeNull();
    expect(hub({ t: 'queued', position: 1, etaS: 30, why: 'FULL' })).toBeNull();
  });

  it('never throws on 10,000 fuzzed values, and what parses round-trips', () => {
    const rng = createRng(seedFromString('fuzz-protocol-13'), 'net');
    const atoms = [
      0,
      1,
      2,
      32,
      33,
      -1,
      1.5,
      16_384,
      16_385,
      2 ** 53,
      'full',
      'budget',
      'storage',
      'later',
      null,
      true,
    ];
    const keys = ['links', 'relayed', 'kb', 'extra', 't', 'position', 'etaS', 'why'];
    const value = (depth: number): unknown => {
      switch (rng.int(0, depth > 1 ? 1 : 3)) {
        case 0:
        case 1:
          return atoms[rng.int(0, atoms.length - 1)];
        case 2:
          return Array.from({ length: rng.int(0, 3) }, () => value(depth + 1));
        default:
          return Object.fromEntries(
            Array.from({ length: rng.int(0, 5) }, () => [
              keys[rng.int(0, keys.length - 1)],
              value(depth + 1),
            ]),
          );
      }
    };
    let parsed = 0;
    for (let n = 0; n < 10_000; n++) {
      const pick = rng.int(0, 2);
      const relayValue =
        pick === 0
          ? value(0)
          : { links: value(1), relayed: value(1), kb: value(1), ...(pick === 2 ? {} : { x: 1 }) };
      const c = { ...progress, relay: relayValue };
      const q = { t: 'queued', position: rng.int(0, 3), etaS: rng.int(-1, 90), why: value(1) };
      for (const raw of [JSON.stringify(c), JSON.stringify(q)]) {
        const got = raw.includes('"queued"') ? parseHubMsg(raw) : parseClientMsg(raw);
        if (!got) continue;
        parsed++;
        const again = raw.includes('"queued"')
          ? parseHubMsg(JSON.stringify(got))
          : parseClientMsg(JSON.stringify(got));
        expect(again).toEqual(got);
        if (got.t === 'progress' && got.relay) {
          const r = got.relay;
          expect(r.links).toBeLessThanOrEqual(32);
          expect(r.relayed).toBeLessThanOrEqual(r.links);
          expect(r.kb).toBeLessThanOrEqual(RELAY_KB_MAX);
        }
      }
    }
    expect(parsed).toBeGreaterThan(0);
  });
});
