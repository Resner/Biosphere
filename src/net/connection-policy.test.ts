import { describe, expect, it } from 'vitest';
import { ConnectionPolicy, DEFAULT_CAP, MAX_CAP } from './connection-policy';

const id = (n: number) => `p${String(n).padStart(2, '0')}`;

/** Policy for `self` with `n` roster peers at distance = their index. */
function filled(self: string, n: number, cap = DEFAULT_CAP): ConnectionPolicy {
  const p = new ConnectionPolicy({ selfId: self, cap });
  for (let i = 1; i <= n; i++) p.upsert(id(i), { distance: i });
  return p;
}

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
    expect(p.plan()).toEqual({ connect: [], evict: [] });
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
    expect(p.plan()).toEqual({ connect: [], evict: [] });
  });

  it('never evicts P0 or P1 peers for P2 peers', () => {
    const p = new ConnectionPolicy({ selfId: 'a', cap: 4 });
    p.upsert('far0', { distance: 5000, priority: 0 });
    p.upsert('far1', { distance: 5000, priority: 1 });
    p.upsert('n1', { distance: 1 });
    p.upsert('n2', { distance: 2 });
    p.plan();
    p.upsert('n0', { distance: 0 });
    const plan = p.plan();
    expect(plan.evict).toEqual(['n2']);
    expect(p.isHeld('far0')).toBe(true);
    expect(p.isHeld('far1')).toBe(true);
    // A new P0 may take a P2 slot, but a full house of protected peers has no victim.
    p.upsert('urgent', { distance: 9000, priority: 0 });
    expect(p.plan().evict).toEqual(['n1']);
    p.upsert('urgent2', { distance: 9000, priority: 0 });
    p.upsert('urgent3', { distance: 9000, priority: 0 });
    p.plan();
    p.upsert('urgent4', { distance: 9000, priority: 0 });
    expect(p.plan()).toEqual({ connect: [], evict: [] });
    expect(p.isHeld('far0') && p.isHeld('far1')).toBe(true);
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

  it('only initiates towards higher playerIds and waits for the others', () => {
    const p = new ConnectionPolicy({ selfId: 'm' });
    p.upsert('a', { distance: 1 });
    p.upsert('z', { distance: 2 });
    expect(p.plan().connect).toEqual(['z']);
    expect(p.admit('a')).toEqual({ accepted: true });
    expect(p.isHeld('a')).toBe(true);
  });

  it('admits an inbound offer when there is room, or evicts a farther peer', () => {
    const p = new ConnectionPolicy({ selfId: 'a', cap: 2 });
    p.upsert('x', { distance: 10 });
    p.upsert('y', { distance: 20 });
    p.plan();
    p.upsert('b', { distance: 15 });
    // 'a' is the lower id and would call 'b', but an offer that arrives anyway is judged the same way.
    expect(p.admit('b')).toEqual({ accepted: true, evict: 'y' });
    p.upsert('c', { distance: 30 });
    expect(p.admit('c')).toEqual({ accepted: false });
    expect(p.admit('stranger')).toEqual({ accepted: false });
    expect(p.held().sort()).toEqual(['b', 'x']);
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
