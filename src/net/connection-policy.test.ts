import { describe, expect, it } from 'vitest';
import {
  ConnectionPolicy,
  DEFAULT_CAP,
  type LinkClass,
  MAX_CAP,
  selectLinks,
} from './connection-policy';

const id = (n: number) => `p${String(n).padStart(2, '0')}`;

/** Policy for `self` with `n` roster peers at distance = their index. */
function filled(self: string, n: number, cap = DEFAULT_CAP): ConnectionPolicy {
  const p = new ConnectionPolicy({ selfId: self, cap });
  for (let i = 1; i <= n; i++) p.upsert(id(i), { distance: i });
  return p;
}

const QUIET = { connect: [], evict: [], crowded: false };

describe('ConnectionPolicy', () => {
  it('connects to the 24 nearest of a roster of 30 and never exceeds the cap', () => {
    const p = filled('a', 30);
    const { connect, evict } = p.plan();
    expect(evict).toEqual([]);
    expect(connect).toHaveLength(DEFAULT_CAP);
    expect(new Set(connect)).toEqual(new Set(Array.from({ length: 24 }, (_, i) => id(i + 1))));
    expect(p.held()).toHaveLength(24);
    expect(p.plan().connect).toEqual([]);
    expect(p.held().length).toBeLessThanOrEqual(DEFAULT_CAP);
  });

  it('treats an unknown distance as far', () => {
    const p = new ConnectionPolicy({ selfId: 'a', cap: 2 });
    p.upsert('b', {});
    p.upsert('c', { distance: 900 });
    p.upsert('d', { distance: 50 });
    expect(p.plan().connect.sort()).toEqual(['c', 'd']);
  });

  it('evicts the farthest for a closer joiner and never for a farther one', () => {
    const p = filled('a', 24);
    p.plan();
    p.upsert('q-far', { distance: 99 });
    expect(p.plan()).toEqual(QUIET);
    p.upsert('q-near', { distance: 0.5 });
    const plan = p.plan();
    expect(plan.evict).toEqual([id(24)]);
    expect(plan.connect).toEqual(['q-near']);
    expect(p.held()).toHaveLength(24);
    expect(p.isHeld(id(24))).toBe(false);
  });

  it('does not evict an equally distant peer', () => {
    const p = new ConnectionPolicy({ selfId: 'a', cap: 1 });
    p.upsert('b', { distance: 10 });
    p.plan();
    p.upsert('c', { distance: 10 });
    expect(p.plan()).toEqual(QUIET);
  });

  it('fills by class before distance, and holds P0 and P1 past the cap up to 32', () => {
    const p = new ConnectionPolicy({ selfId: 'a', cap: 4 });
    p.upsert('far0', { distance: 5000, linkClass: 0 });
    p.upsert('far1', { distance: 5000, linkClass: 1 });
    p.upsert('n3', { distance: 1, linkClass: 3 });
    p.upsert('n2', { distance: 2, linkClass: 2 });
    p.upsert('n4', { distance: 0, linkClass: 4 });
    expect(p.plan().connect).toEqual(['far0', 'far1', 'n2', 'n3']);
    // A P1 takes the worst P2–P4 place; the protected ones are never evicted.
    p.upsert('urgent', { distance: 8000, linkClass: 1 });
    expect(p.plan()).toEqual({ connect: ['urgent'], evict: ['n3'], crowded: false });
    for (let i = 0; i < 29; i++) {
      p.upsert(`u${String(i).padStart(2, '0')}`, { distance: 9000, linkClass: 1 });
    }
    const plan = p.plan();
    expect(plan.evict).toEqual(['n2']);
    expect(plan.connect).toHaveLength(29);
    expect(p.held()).toHaveLength(MAX_CAP);
    // A 33rd protected peer is crowded out: P0 and the nearest P1 stay.
    p.upsert('urgent2', { distance: 10, linkClass: 1 });
    expect(p.plan()).toEqual({ connect: ['urgent2'], evict: ['u28'], crowded: true });
    expect(p.isHeld('far0') && p.isHeld('far1')).toBe(true);
    expect(p.held()).toHaveLength(MAX_CAP);
  });

  it('moves a peer by its latest distance', () => {
    const p = new ConnectionPolicy({ selfId: 'a', cap: 1 });
    p.upsert('b', { distance: 10 });
    p.upsert('c', { distance: 20 });
    p.plan();
    expect(p.isHeld('b')).toBe(true);
    p.upsert('b', { distance: 100 });
    p.upsert('c', { distance: 5 });
    const plan = p.plan();
    expect(plan.evict).toEqual(['b']);
    expect(plan.connect).toEqual(['c']);
  });

  it('lets either side call', () => {
    const p = new ConnectionPolicy({ selfId: 'm' });
    p.upsert('a', { distance: 1 });
    p.upsert('z', { distance: 2 });
    expect(p.plan().connect).toEqual(['a', 'z']);
    expect(p.admit('a')).toEqual({ accepted: true });
    expect(p.isHeld('a')).toBe(true);
  });

  it('admits an inbound offer when there is room, or evicts a farther peer', () => {
    const p = new ConnectionPolicy({ selfId: 'a', cap: 2 });
    p.upsert('x', { distance: 10 });
    p.upsert('y', { distance: 20 });
    p.plan();
    p.upsert('b', { distance: 15 });
    expect(p.admit('b')).toEqual({ accepted: true, evict: 'y' });
    p.upsert('c', { distance: 30 });
    expect(p.admit('c')).toEqual({ accepted: false });
    expect(p.admit('stranger')).toEqual({ accepted: false });
    expect(p.held().sort()).toEqual(['b', 'x']);
  });

  it('decides an inbound offer by the caller’s class', () => {
    const p = new ConnectionPolicy({ selfId: 'a' });
    for (let i = 1; i <= 24; i++)
      p.upsert(id(i), { distance: i * 100, linkClass: (2 + (i % 3)) as LinkClass });
    p.plan();
    expect(p.held()).toHaveLength(24);
    // With 24 held, all nearer than the caller, a P4's offer is refused.
    p.upsert('c4', { distance: 5000, linkClass: 4 });
    expect(p.admit('c4')).toEqual({ accepted: false });
    // A P1's is admitted in the place of the worst P2–P4: the farthest P4.
    p.upsert('c1', { distance: 5000, linkClass: 1 });
    expect(p.admit('c1')).toEqual({ accepted: true, evict: id(23) });
    expect(p.held()).toHaveLength(24);
    // A duty peer is admitted up to 32, each in the place of a P2–P4 while one is held.
    for (let i = 0; i < 31; i++) {
      const w = `w${String(i).padStart(2, '0')}`;
      p.duty(w, true);
      const a = p.admit(w);
      expect(a.accepted).toBe(true);
      expect(a.accepted && a.evict !== undefined).toBe(i < 23);
    }
    expect(p.held()).toHaveLength(MAX_CAP);
    expect(p.isHeld('c1')).toBe(true);
    // Past 32, P0 goes before P1, and with every place a duty link one more is refused.
    p.duty('w98', true);
    expect(p.admit('w98')).toEqual({ accepted: true, evict: 'c1' });
    p.duty('w99', true);
    expect(p.admit('w99')).toEqual({ accepted: false });
    expect(p.held()).toHaveLength(MAX_CAP);
  });

  it('frees a slot on release and on removal from the roster', () => {
    const p = filled('a', 3, 2);
    p.plan();
    expect(p.held().sort()).toEqual([id(1), id(2)]);
    p.remove(id(1));
    expect(p.isHeld(id(1))).toBe(false);
    expect(p.plan().connect).toEqual([id(3)]);
    p.release(id(2));
    expect(p.plan().connect).toEqual([id(2)]);
  });

  it('accepts caps up to 32 and rejects anything else', () => {
    expect(() => new ConnectionPolicy({ selfId: 'a', cap: MAX_CAP })).not.toThrow();
    expect(() => new ConnectionPolicy({ selfId: 'a', cap: 33 })).toThrow(RangeError);
    expect(() => new ConnectionPolicy({ selfId: 'a', cap: 0 })).toThrow(RangeError);
    expect(() => new ConnectionPolicy({ selfId: 'a', cap: 2.5 })).toThrow(RangeError);
  });

  describe('duty links (M10 T6, P0 in M11)', () => {
    it('connects a duty peer outside the roster only once announced, holds it through an eviction pass, and closes it when off', () => {
      const p = new ConnectionPolicy({ selfId: 'a', cap: 2 });
      expect(p.admit('w')).toEqual({ accepted: false });
      expect(p.plan().connect).toEqual([]);
      p.duty('w', true);
      expect(p.isDuty('w')).toBe(true);
      expect(p.plan()).toEqual({ connect: ['w'], evict: [], crowded: false });
      // The duty link (P0) takes a place under the cap; the roster's nearest fills the rest.
      p.upsert('b', { distance: 5 });
      p.upsert('c', { distance: 9 });
      expect(p.plan()).toEqual({ connect: ['b'], evict: [], crowded: false });
      p.upsert('d', { distance: 1 });
      expect(p.plan()).toEqual({ connect: ['d'], evict: ['b'], crowded: false });
      expect(p.isHeld('w')).toBe(true);
      // Leaving a roster it was never in changes nothing; off closes it.
      p.remove('w');
      expect(p.isHeld('w')).toBe(true);
      expect(p.duty('w', false)).toBe(true);
      expect(p.isHeld('w')).toBe(false);
      expect(p.plan().connect).toEqual(['b']);
    });

    it('makes a roster peer P0 while on duty, and keeps it after', () => {
      const p = new ConnectionPolicy({ selfId: 'a', cap: 1 });
      p.upsert('near', { distance: 1 });
      p.upsert('w', { distance: 3 });
      expect(p.plan().connect).toEqual(['near']);
      p.duty('w', true);
      expect(p.plan()).toEqual({ connect: ['w'], evict: ['near'], crowded: false });
      expect(p.duty('w', false)).toBe(false);
      expect(p.isHeld('w')).toBe(true);
      // And a duty peer that leaves the roster stays held until its duty ends.
      p.duty('w', true);
      p.remove('w');
      expect(p.isHeld('w')).toBe(true);
      expect(p.duty('w', false)).toBe(true);
    });

    it('holds duty links past 24 up to 32, giving each a P2–P4 place while one is held', () => {
      const p = filled('a', 30);
      p.plan();
      expect(p.held()).toHaveLength(DEFAULT_CAP);
      p.duty('w00', true);
      expect(p.plan()).toEqual({ connect: ['w00'], evict: [id(24)], crowded: false });
      expect(p.held()).toHaveLength(DEFAULT_CAP);
      for (let i = 1; i <= 40; i++) p.duty(`w${String(i).padStart(2, '0')}`, true);
      const plan = p.plan();
      expect(plan.crowded).toBe(true);
      expect(p.held()).toHaveLength(MAX_CAP);
      expect(p.held().every((h) => p.isDuty(h))).toBe(true);
    });
  });

  it('fully connects a pond of 24: each peer ends with 23 connections', () => {
    const ids = Array.from({ length: 24 }, (_, i) => id(i));
    const policies = new Map(ids.map((s) => [s, new ConnectionPolicy({ selfId: s })]));
    for (const [s, p] of policies) for (const o of ids) if (o !== s) p.upsert(o, {});
    for (const [s, p] of policies) {
      for (const target of p.plan().connect) {
        expect(policies.get(target)?.admit(s).accepted).toBe(true);
      }
    }
    for (const p of policies.values()) expect(p.held()).toHaveLength(23);
  });
});

describe('selectLinks', () => {
  it('keeps P0 and P1 to 32, then P2–P4 under the cap, then peers in their grace', () => {
    const cands = [
      { id: 'g', linkClass: null, distance: 1, held: true },
      { id: 'p4', linkClass: 4 as const, distance: 1, held: false },
      { id: 'p2', linkClass: 2 as const, distance: 50, held: false },
      { id: 'p1', linkClass: 1 as const, distance: 99, held: false },
    ];
    expect([...selectLinks(cands, 3).keep]).toEqual(['p1', 'p2', 'p4']);
    expect([...selectLinks(cands, 4).keep]).toEqual(['p1', 'p2', 'p4', 'g']);
    expect([...selectLinks(cands, 1).keep]).toEqual(['p1']);
  });
});
