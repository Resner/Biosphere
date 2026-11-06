import { describe, expect, it } from 'vitest';
import { layoutPedigree } from './pedigree-layout';

type Family = Record<string, readonly string[]>;
const of =
  (family: Family) =>
  (id: string): readonly string[] =>
    family[id] ?? [];

/** Every parent sits in an earlier row than its child, and no two nodes share a place. */
function expectSound(family: Family, ids: readonly string[], acyclic = true): void {
  const { places, depth, breadth } = layoutPedigree(ids, of(family));
  expect([...places.keys()].sort()).toEqual([...ids].sort());
  const seen = new Set<string>();
  for (const [id, p] of places) {
    const key = `${p.depth}|${p.across}`;
    expect(seen.has(key), `${id} shares ${key}`).toBe(false);
    seen.add(key);
    expect(p.depth).toBeGreaterThanOrEqual(0);
    expect(p.depth).toBeLessThan(depth);
    expect(p.across).toBeGreaterThanOrEqual(0);
    expect(p.across).toBeLessThanOrEqual(breadth - 1);
    for (const parent of of(family)(id)) {
      const pp = places.get(parent);
      if (pp && acyclic) expect(pp.depth).toBeLessThan(p.depth);
    }
  }
}

describe('layoutPedigree', () => {
  it('lays out nothing as nothing', () => {
    expect(layoutPedigree([], of({}))).toMatchObject({ depth: 0, breadth: 0 });
  });

  it('puts the oldest first and the newest last, each parent a row above its child', () => {
    // s is the child of a1 and x; a1 the child of a0 and b0.
    const family = { s: ['a1', 'x'], a1: ['a0', 'b0'] };
    const ids = ['s', 'a1', 'x', 'a0', 'b0'];
    const { places, depth } = layoutPedigree(ids, of(family));
    expect(depth).toBe(3);
    expect(places.get('s')?.depth).toBe(2);
    expect(places.get('a1')?.depth).toBe(1);
    // x has no parents, yet sits beside a1, just above its own child, not with the oldest.
    expect(places.get('x')?.depth).toBe(1);
    expect(places.get('a0')?.depth).toBe(0);
    expect(places.get('b0')?.depth).toBe(0);
    expectSound(family, ids);
  });

  it('centres each row and keeps parents over their children', () => {
    const family = { s: ['p', 'q'], p: ['p1', 'p2'], q: ['q1', 'q2'] };
    const ids = ['s', 'p', 'q', 'p1', 'p2', 'q1', 'q2'];
    const { places, breadth } = layoutPedigree(ids, of(family));
    expect(breadth).toBe(4);
    expect(places.get('s')?.across).toBe(1.5);
    // p's parents sit on p's side, q's on q's: no crossing edges.
    const across = (id: string): number => places.get(id)?.across ?? Number.NaN;
    expect(Math.max(across('p1'), across('p2'))).toBeLessThan(Math.min(across('q1'), across('q2')));
    expect(across('p')).toBeLessThan(across('q'));
    expectSound(family, ids);
  });

  it('places a creature that is both a parent and a grandparent above both', () => {
    // g mated with its own child c: s's parents are g and c.
    const family = { s: ['g', 'c'], c: ['g', 'h'] };
    const ids = ['s', 'g', 'c', 'h'];
    expectSound(family, ids);
    const { places } = layoutPedigree(ids, of(family));
    expect(places.get('g')?.depth).toBe(0);
  });

  it('ignores parents outside the ids and survives a cycle', () => {
    const family = { s: ['a', 'gone'], a: ['b'], b: ['a'] };
    expectSound(family, ['s', 'a', 'b'], false);
    const { places } = layoutPedigree(['s', 'a', 'b'], of(family));
    expect(places.get('s')?.depth).toBeGreaterThan(places.get('a')?.depth ?? Infinity);
  });

  it('keeps a childless creature beside its parent (an eaten egg)', () => {
    const family = { new: ['old', 'mate'], egg: ['old', 'mate'], newer: ['new', 'other'] };
    const ids = ['newer', 'egg', 'new', 'other', 'old', 'mate'];
    const { places } = layoutPedigree(ids, of(family));
    expect(places.get('egg')?.depth).toBe(places.get('new')?.depth);
    expectSound(family, ids);
  });

  it('lays out a 64-creature pedigree without overlap', () => {
    // A full binary pedigree five generations back (63 creatures) and one more.
    const family: Record<string, string[]> = {};
    const ids: string[] = [];
    const walk = (id: string, level: number): void => {
      ids.push(id);
      if (level === 0) return;
      family[id] = [`${id}0`, `${id}1`];
      walk(`${id}0`, level - 1);
      walk(`${id}1`, level - 1);
    };
    walk('n', 5);
    family.n00000 = ['n000000', 'n000001'];
    ids.push('n000000');
    expect(ids).toHaveLength(64);
    expectSound(family, ids);
  });
});
