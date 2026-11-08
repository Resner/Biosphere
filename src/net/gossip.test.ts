import { describe, expect, it } from 'vitest';
import { createRng, seedFromString } from '../sim/prng';
import {
  type Fix,
  GOSSIP_EVERY_MS,
  GOSSIP_TTL_MS,
  Gossip,
  gossipFor,
  type PeersEvent,
} from './gossip';
import { byteLength, GOSSIP_MAX, parsePeerEvent } from './protocol';

// Gossip (M11 T9): B tells A about B's linked peers nearest A, and A keeps them for 10 s.

const id = (n: number) => `P${String(n).padStart(3, '0')}${'x'.repeat(39)}`;
const A = id(0);
const B = id(1);
const T = 1_700_000_000_000;
const C = 131_072;

describe('gossipFor', () => {
  it('lists the linked peers nearest the receiver, linkable with it, from snapshots under 2 s old', () => {
    const fixes = new Map<string, Fix>([[A, { x: C, y: C, r: 10, at: T }]]);
    // 20 comparable peers east of A, 100 wu apart, the nearest first.
    for (let i = 1; i <= 20; i++) fixes.set(id(10 + i), { x: C + 100 * i, y: C, r: 12, at: T });
    fixes.set(id(40), { x: C + 1, y: C, r: 200, at: T }); // two tiers up: never told to A
    fixes.set(id(41), { x: C + 2, y: C, r: 10, at: T - 2001 }); // a stale snapshot
    fixes.set(id(42), { x: C + 3, y: C, r: 10, at: T - 2000 }); // just fresh enough
    const event = gossipFor(A, fixes, T);
    expect(event?.t).toBe('peers');
    const ids = event?.list.map((e) => e[0]);
    expect(ids).toHaveLength(GOSSIP_MAX);
    expect(ids?.[0]).toBe(id(42));
    expect(ids?.slice(1)).toEqual(Array.from({ length: 15 }, (_, i) => id(11 + i)));
    expect(ids).not.toContain(A);
    expect(ids).not.toContain(id(40));
    expect(ids).not.toContain(id(41));
    // A fix with no instance is in the open water.
    expect(event?.list[1]).toEqual([id(11), C + 100, C, 12, 0]);
  });

  it('tells nothing to a receiver it has no snapshot of, or when no one qualifies', () => {
    const fixes = new Map<string, Fix>([[id(5), { x: C, y: C, r: 10, at: T }]]);
    expect(gossipFor(A, fixes, T)).toBeNull();
    fixes.set(A, { x: C, y: C, r: 10, at: T });
    fixes.set(id(5), { x: C, y: C, r: 10, at: T - 5000 });
    expect(gossipFor(A, fixes, T)).toBeNull();
  });

  it('gossip about 16 peers at world-scale positions stays within 1,100 bytes and parses', () => {
    const rng = createRng(seedFromString('gossip-size'), 'gossip');
    for (let round = 0; round < 50; round++) {
      const fixes = new Map<string, Fix>([[A, { x: 250_000, y: 250_000, r: 10, at: T }]]);
      for (let i = 1; i <= 30; i++) {
        fixes.set(id(i), {
          x: 200_000 + rng.next() * 62_143,
          y: 200_000 + rng.next() * 62_143,
          r: 1 + rng.next() * 20,
          at: T,
        });
      }
      const event = gossipFor(A, fixes, T);
      expect(event?.list).toHaveLength(GOSSIP_MAX);
      const text = JSON.stringify(event);
      expect(byteLength(text)).toBeLessThanOrEqual(1100);
      expect(parsePeerEvent(text)).toEqual(event);
    }
  });
});

describe('Gossip', () => {
  const fixes = (at = T) =>
    new Map<string, Fix>([
      [A, { x: C, y: C, r: 10, at }],
      [B, { x: C + 500, y: C, r: 10, at }],
      [id(7), { x: C + 900, y: C, r: 10, at }],
    ]);

  it('tells each link at once, then every 4 s', () => {
    const g = new Gossip(id(9));
    const first = g.due([A, B, id(7)], fixes(), T);
    expect(first.map(([to]) => to)).toEqual([A, B, id(7)]);
    expect(first[0]?.[1].list.map((e) => e[0])).toEqual([B, id(7)]);
    const later = T + GOSSIP_EVERY_MS;
    expect(g.due([A, B, id(7)], fixes(later - 1), later - 1)).toEqual([]);
    expect(g.due([A, B, id(7)], fixes(later), later)).toHaveLength(3);
  });

  it('lists only linked peers, and tells a new link at once', () => {
    const g = new Gossip(id(9));
    expect(g.due([A], fixes(), T)).toEqual([]); // A's only linked peer is A
    const later = g.due([A, B], fixes(), T + 100);
    expect(later.map(([to, e]) => [to, e.list.map((x) => x[0])])).toEqual([
      [A, [B]],
      [B, [A]],
    ]);
  });

  it('keeps gossip as `gossip` sightings for 10 s unless refreshed, never itself or the sender', () => {
    const g = new Gossip(A);
    g.receive(
      B,
      {
        t: 'peers',
        list: [
          [id(7), C + 900, C, 10, 0],
          [A, C, C, 10, 0],
          [B, C, C, 10, 0],
        ],
      },
      T,
    );
    expect(g.known(T)).toEqual([
      { id: id(7), x: C + 900, y: C, r: 10, at: T, n: 0, source: 'gossip' },
    ]);
    expect(g.heard(id(7), T + 1000)).toEqual([
      { via: B, fix: { x: C + 900, y: C, r: 10, at: T, n: 0 } },
    ]);
    expect(g.known(T + GOSSIP_TTL_MS)).toHaveLength(1);
    expect(g.known(T + GOSSIP_TTL_MS + 1)).toEqual([]);
    expect(g.heard(id(7), T + GOSSIP_TTL_MS + 1)).toEqual([]);
    // A refresh keeps it 10 s from the refresh.
    g.receive(B, { t: 'peers', list: [[id(7), C + 950, C, 10, 0]] }, T + 20_000);
    g.receive(id(8), { t: 'peers', list: [[id(7), C + 960, C, 10, 0]] }, T + 25_000);
    expect(g.heard(id(7), T + 29_000).map((h) => h.via)).toEqual([B, id(8)]);
    expect(g.heard(id(7), T + 30_001).map((h) => h.via)).toEqual([id(8)]);
    expect(g.known(T + 34_000)).toEqual([
      { id: id(7), x: C + 960, y: C, r: 10, at: T + 25_000, n: 0, source: 'gossip' },
    ]);
    g.drop(id(8));
    expect(g.known(T + 30_001)).toEqual([]);
  });

  it('keeps a bounded number of sightings from one sender', () => {
    const g = new Gossip(A);
    for (let round = 0; round < 20; round++) {
      const list = Array.from({ length: GOSSIP_MAX }, (_, i): PeersEvent['list'][number] => [
        id(100 + round * GOSSIP_MAX + i),
        C,
        C,
        10,
        0,
      ]);
      g.receive(B, { t: 'peers', list }, T);
    }
    expect(g.known(T)).toHaveLength(3 * GOSSIP_MAX);
  });
});

describe('gossip across crowd instances (M12 T3)', () => {
  it('each entry carries its instance, and a receiver in other water is told none of it', () => {
    const fixes = new Map<string, Fix>([
      [A, { x: C, y: C, r: 10, at: T, n: 1 }],
      [id(1), { x: C + 100, y: C, r: 10, at: T, n: 1 }],
      [id(2), { x: C + 200, y: C, r: 10, at: T, n: 0 }],
      [id(3), { x: C + 300, y: C, r: 10, at: T, n: 2 }],
      [id(4), { x: C + 400, y: C, r: 10, at: T }],
    ]);
    expect(gossipFor(A, fixes, T)?.list).toEqual([
      [id(1), C + 100, C, 10, 1],
      [id(2), C + 200, C, 10, 0],
      [id(4), C + 400, C, 10, 0],
    ]);
    // A receiver in the open water hears of every instance.
    fixes.set(A, { x: C, y: C, r: 10, at: T, n: 0 });
    expect(gossipFor(A, fixes, T)?.list.map((e) => e[4])).toEqual([1, 0, 2, 0]);
  });

  it('a receiver drops an entry from water it does not share', () => {
    const g = new Gossip(A);
    const list: PeersEvent['list'] = [
      [id(11), C, C, 10, 1],
      [id(12), C, C, 10, 0],
      [id(13), C, C, 10, 2],
    ];
    g.receive(B, { t: 'peers', list }, T, 1);
    expect(g.known(T).map((k) => [k.id, k.n])).toEqual([
      [id(11), 1],
      [id(12), 0],
    ]);
    expect(g.heard(id(13), T)).toEqual([]);
    const open = new Gossip(A);
    open.receive(B, { t: 'peers', list }, T);
    expect(open.known(T).map((k) => k.n)).toEqual([1, 0, 2]);
  });
});
