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

  describe('duty links (M10 T6)', () => {
    it('connects a duty peer outside the roster only once announced, holds it through an eviction pass, and closes it when off', () => {
      const p = new ConnectionPolicy({ selfId: 'a', cap: 2 });
      expect(p.admit('w')).toEqual({ accepted: false });
      expect(p.plan().connect).toEqual([]);
      p.duty('w', true);
      expect(p.isDuty('w')).toBe(true);
      expect(p.plan()).toEqual({ connect: ['w'], evict: [] });
      // A roster pass of nearer peers fills the cap and evicts among themselves, never the duty link.
      p.upsert('b', { distance: 5 });
      p.upsert('c', { distance: 9 });
      p.plan();
      p.upsert('d', { distance: 1 });
      expect(p.plan()).toEqual({ connect: ['d'], evict: ['c'] });
      expect(p.isHeld('w')).toBe(true);
      // Leaving a roster it was never in changes nothing; off closes it.
      p.remove('w');
      expect(p.isHeld('w')).toBe(true);
      expect(p.duty('w', false)).toBe(true);
      expect(p.isHeld('w')).toBe(false);
      expect(p.plan().connect).toEqual([]);
    });

    it('keeps a pond member that was also a duty peer', () => {
      const p = new ConnectionPolicy({ selfId: 'a' });
      p.upsert('w', { distance: 3 });
      p.duty('w', true);
      expect(p.plan().connect).toEqual(['w']);
      expect(p.duty('w', false)).toBe(false);
      expect(p.isHeld('w')).toBe(true);
      // And a duty peer that leaves the roster stays held until its duty ends.
      p.duty('w', true);
      p.remove('w');
      expect(p.isHeld('w')).toBe(true);
      expect(p.duty('w', false)).toBe(true);
    });

    it('holds 25 with 24 pond links and a duty link, and never more than 32', () => {
      const p = filled('a', 30);
      p.plan();
      expect(p.held()).toHaveLength(DEFAULT_CAP);
      p.duty('w00', true);
      expect(p.plan().connect).toEqual(['w00']);
      expect(p.held()).toHaveLength(DEFAULT_CAP + 1);
      // An offer from a duty peer this side doesn't call is admitted past the cap too.
      p.duty('0w', true);
      expect(p.admit('0w')).toEqual({ accepted: true });
      expect(p.held()).toHaveLength(DEFAULT_CAP + 2);
      // A pond peer still waits for room under the default cap.
      p.upsert('b-near', { distance: 0.5 });
      expect(p.plan()).toEqual({ connect: ['b-near'], evict: [id(24)] });
      expect(p.held()).toHaveLength(DEFAULT_CAP + 2);
      for (let i = 1; i <= 10; i++) p.duty(`w${String(i).padStart(2, '0')}`, true);
      const plan = p.plan();
      // Six more fill the browser's 32; the other four each take a pond peer's place (P2).
      expect(plan.connect).toHaveLength(10);
      expect(plan.evict).toHaveLength(4);
      expect(p.held()).toHaveLength(MAX_CAP);
      // With every slot a duty link, one more is refused.
      for (let i = 11; i <= 40; i++) p.duty(`w${String(i).padStart(2, '0')}`, true);
      p.plan();
      expect(p.held()).toHaveLength(MAX_CAP);
      p.duty('0x', true);
      expect(p.admit('0x')).toEqual({ accepted: false });
      expect(p.held().length).toBeLessThanOrEqual(MAX_CAP);
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
