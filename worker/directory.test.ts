import { describe, expect, it } from 'vitest';
import { NEAR_MAX_BYTES, parseHubMsg } from '../src/net/protocol';
import { createRng, seedFromString } from '../src/sim/prng';
import { type DirMember, Directory, LEAF_MIN_SIZE, queryOf } from './directory';

// The authority's directory (M11 T6), pure: run in Node, as the headless harness (T10) runs it.

const WORLD = 262_144;
const seeded = (n: number) => {
  const rng = createRng(seedFromString(`directory-${n}`), 'test');
  return () => rng.next();
};
/** A starter's AoI (radius 10, adult 20): 2.65 × its view half-height of 88 wu. */
const STARTER_AOI = 233;
const id = (n: number) => `p${String(n).padStart(42, '0')}`;
const member = (n: number, x: number, y: number, over: Partial<DirMember> = {}): DirMember => ({
  id: id(n),
  name: `Pl${n}`,
  x,
  y,
  r: 10,
  aoi: STARTER_AOI,
  t: 0,
  ...over,
});

/** Every member sits in exactly one leaf, and that leaf's square holds its centre. */
function consistent(dir: Directory, ids: Iterable<string>): string | null {
  const leaves = dir.leaves();
  const counted = leaves.reduce((sum, l) => sum + l.members, 0);
  const all = [...ids];
  if (counted !== all.length) return `${counted} placed for ${all.length} members`;
  for (const who of all) {
    const m = dir.member(who);
    const leaf = dir.leafOf(who);
    if (!m || !leaf) return `lost ${who}`;
    const holding = leaves.filter(
      (l) =>
        m.x >= l.leaf.x &&
        m.x < l.leaf.x + l.leaf.size &&
        m.y >= l.leaf.y &&
        m.y < l.leaf.y + l.leaf.size,
    );
    if (holding.length !== 1) return `${who} lies in ${holding.length} leaves`;
    const [only] = holding;
    if (only?.leaf.x !== leaf.x || only.leaf.y !== leaf.y || only.leaf.size !== leaf.size)
      return `${who} is filed in another leaf`;
  }
  return null;
}

describe('splits and merges', () => {
  it('splits a leaf in four on its 17th member', () => {
    const dir = new Directory(WORLD);
    const rand = seeded(1);
    for (let n = 0; n < 16; n++) dir.report(member(n, rand() * WORLD, rand() * WORLD));
    expect(dir.leaves()).toHaveLength(1);
    dir.report(member(16, 1000, 1000));
    expect(dir.leaves().map((l) => l.leaf.size)).toEqual([
      WORLD / 2,
      WORLD / 2,
      WORLD / 2,
      WORLD / 2,
    ]);
  });

  it('holds no more than 16 in a leaf unless it is 1,024 wu wide', () => {
    const dir = new Directory(WORLD);
    const rand = seeded(2);
    // A crowd in one 1,000 wu square, and others spread out.
    for (let n = 0; n < 120; n++)
      dir.report(member(n, 50_000 + rand() * 1000, 70_000 + rand() * 1000));
    for (let n = 120; n < 400; n++) dir.report(member(n, rand() * WORLD, rand() * WORLD));
    for (const { leaf, members } of dir.leaves()) {
      if (leaf.size > LEAF_MIN_SIZE) expect(members).toBeLessThanOrEqual(16);
    }
    expect(Math.max(...dir.leaves().map((l) => l.members))).toBeGreaterThan(16);
  });

  it('merges four siblings once they hold 5 together', () => {
    const dir = new Directory(WORLD);
    for (let n = 0; n < 17; n++) dir.report(member(n, 1000 + n * 9000, 1000 + n * 7000));
    expect(dir.leaves()).toHaveLength(4);
    for (let n = 0; n < 11; n++) dir.remove(id(n));
    expect(dir.leaves()).toHaveLength(4);
    const moved = dir.remove(id(11));
    expect(dir.leaves()).toEqual([{ leaf: { x: 0, y: 0, size: WORLD }, members: 5 }]);
    expect(moved.map((m) => m.id).sort()).toEqual([12, 13, 14, 15, 16].map(id));
  });

  it('names every other member whose leaf a split changed, and not the reporter', () => {
    const dir = new Directory(WORLD);
    for (let n = 0; n < 16; n++) dir.report(member(n, 1000 + n * 9000, 5000));
    const { leaf, moved } = dir.report(member(16, 200_000, 200_000));
    expect(leaf).toEqual({ x: WORLD / 2, y: WORLD / 2, size: WORLD / 2 });
    expect(moved.map((m) => m.id).sort()).toEqual([...Array(16).keys()].map(id));
    for (const m of moved) expect(dir.leafOf(m.id)).toEqual(m.leaf);
    // A move within a leaf changes nobody's.
    expect(dir.report(member(16, 200_100, 200_000)).moved).toEqual([]);
  });

  it('keeps every member in exactly one leaf, which holds its centre, over 10,000 random sequences', () => {
    const rand = seeded(3);
    for (let run = 0; run < 10_000; run++) {
      const size = rand() < 0.5 ? 8192 : WORLD;
      const dir = new Directory(size, { leafMax: 1 + Math.floor(rand() * 16) });
      const ids = new Set<string>();
      // Crowds near one point, so splits and merges happen at every depth.
      const cx = rand() * size;
      const cy = rand() * size;
      const spread = rand() < 0.5 ? size : 4000;
      const at = (c: number) => Math.min(size - 1e-6, Math.max(0, c + (rand() - 0.5) * spread));
      const steps = 4 + Math.floor(rand() * 40);
      for (let s = 0; s < steps; s++) {
        const n = Math.floor(rand() * 24);
        if (rand() < 0.3) {
          dir.remove(id(n));
          ids.delete(id(n));
        } else {
          dir.report(member(n, at(cx), at(cy)));
          ids.add(id(n));
        }
      }
      const broken = consistent(dir, ids);
      if (broken) expect.fail(`run ${run}: ${broken}`);
    }
  });

  it('refuses a centre outside the world square', () => {
    expect(() => new Directory(8192).report(member(0, 8192, 10))).toThrow(RangeError);
  });
});

describe('near', () => {
  it('lists the 48 nearest linkable members within Q, nearest first, with their ages, never the reporter', () => {
    const dir = new Directory(WORLD);
    const rand = seeded(4);
    const c = 100_000;
    dir.report(member(0, c, c, { t: 0 }));
    const placed: { n: number; d: number }[] = [];
    for (let n = 1; n <= 90; n++) {
      const d = rand() * 10_000;
      const a = rand() * Math.PI * 2;
      // Every fourth is radius 200: two tiers above a starter, so never a peer.
      const r = n % 4 === 0 ? 200 : 8 + rand() * 20;
      dir.report(member(n, c + d * Math.cos(a), c + d * Math.sin(a), { r, t: n * 10 }));
      if (r < 200 && d <= queryOf(STARTER_AOI)) placed.push({ n, d });
    }
    const out = dir.near(id(0), 5000);
    if (!out) throw new Error('no answer');
    placed.sort((a, b) => a.d - b.d);
    expect(queryOf(STARTER_AOI)).toBe(8192);
    expect(placed.length).toBeGreaterThan(48);
    expect(out.peers.map((p) => p.id)).toEqual(placed.slice(0, 48).map((p) => id(p.n)));
    for (const p of out.peers) {
      const n = Number(p.id.slice(1));
      expect(p.age).toBe(5000 - n * 10);
      expect(p.name).toBe(`Pl${n}`);
    }
    expect(out.leaf).toEqual(dir.leafOf(id(0)));
  });

  it('reaches 4 × the AoI for a larger creature', () => {
    const dir = new Directory(WORLD);
    dir.report(member(0, 100_000, 100_000, { r: 200, aoi: 3000 }));
    dir.report(member(1, 111_000, 100_000, { r: 150 }));
    dir.report(member(2, 113_000, 100_000, { r: 150 }));
    expect(dir.near(id(0), 0)?.peers.map((p) => p.id)).toEqual([id(1)]);
  });

  it('puts a creature two tiers smaller within the AoI in the swarm, never in peers, at most 64', () => {
    const dir = new Directory(WORLD);
    const rand = seeded(5);
    const c = 100_000;
    dir.report(member(0, c, c, { r: 200, aoi: 3000 }));
    for (let n = 1; n <= 80; n++) {
      const d = 100 + rand() * 2800;
      dir.report(member(n, c + d, c, { r: 10 }));
    }
    // Small but outside the AoI: neither.
    dir.report(member(81, c + 3500, c, { r: 10 }));
    // A comparable one: a peer.
    dir.report(member(82, c, c + 500, { r: 180 }));
    const out = dir.near(id(0), 0);
    expect(out?.peers.map((p) => p.id)).toEqual([id(82)]);
    expect(out?.swarm).toHaveLength(64);
    const xs = (out?.swarm ?? []).map(([x]) => x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(Math.max(...xs)).toBeLessThan(c + 3000);
    // And the small ones see the giant in neither list.
    expect(dir.near(id(1), 0)?.peers.map((p) => p.id)).not.toContain(id(0));
    expect(dir.near(id(1), 0)?.swarm).toEqual([]);
  });

  it('passes only the members `keep` takes', () => {
    const dir = new Directory(WORLD);
    dir.report(member(0, 5000, 5000));
    dir.report(member(1, 5100, 5000));
    dir.report(member(2, 5200, 5000));
    expect(dir.near(id(0), 0, (o) => o !== id(1))?.peers.map((p) => p.id)).toEqual([id(2)]);
  });

  it('fits 8 KB: positions in 1/8 wu, and the farthest dropped first', () => {
    const dir = new Directory(WORLD);
    const rand = seeded(6);
    const c = 131_072;
    // Positions of the longest kind (x.375 once in 1/8 wu steps) and names of 16 letters.
    const at = (v: number) => Math.floor(v) + 0.37;
    dir.report(member(0, c, c, { r: 200, aoi: 2000, name: 'Reporter' }));
    for (let n = 1; n <= 60; n++) {
      const d = 2000 + rand() * 6000;
      const a = rand() * Math.PI * 2;
      const name = `N${'x'.repeat(15)}`;
      const r = 150.37;
      dir.report(member(n, at(c + d * Math.cos(a)), at(c + d * Math.sin(a)), { r, name, t: -1e9 }));
    }
    for (let n = 61; n <= 140; n++) dir.report(member(n, at(c + rand() * 1900), at(c), { r: 10 }));
    const out = dir.near(id(0), 1e9);
    if (!out) throw new Error('no answer');
    const raw = JSON.stringify({ t: 'near', ...out });
    expect(raw.length).toBeLessThanOrEqual(NEAR_MAX_BYTES);
    expect(raw.length).toBeGreaterThan(NEAR_MAX_BYTES - 150);
    expect(parseHubMsg(raw)).toEqual({ t: 'near', ...out });
    for (const p of out.peers)
      expect([p.x * 8, p.y * 8, p.r * 8].every(Number.isInteger)).toBe(true);
    // The swarm is all nearer than the peers, so the farthest peers went.
    expect(out.swarm).toHaveLength(64);
    expect(out.peers.length).toBeLessThan(48);
    expect(out.peers.length).toBeGreaterThan(40);
    const kept = new Set(out.peers.map((p) => p.id));
    const dist = (who: string) => dir.distance(id(0), who) ?? 0;
    const farthestKept = Math.max(...[...kept].map(dist));
    for (let n = 1; n <= 60; n++)
      if (!kept.has(id(n))) expect(dist(id(n))).toBeGreaterThan(farthestKept);
  });

  it('answers distance and around', () => {
    const dir = new Directory(WORLD);
    dir.report(member(0, 1000, 1000));
    dir.report(member(1, 4000, 5000));
    expect(dir.distance(id(0), id(1))).toBe(5000);
    expect(dir.distance(id(0), id(9))).toBeNull();
    expect(dir.around(1000, 1000, 4999).sort()).toEqual([id(0)]);
    expect(dir.around(1000, 1000, 5000).sort()).toEqual([id(0), id(1)]);
    expect(dir.near(id(9), 0)).toBeNull();
  });
});
