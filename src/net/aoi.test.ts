import { describe, expect, it } from 'vitest';
import { CANDIDATE_RADII } from '../game/engage';
import { createRng, seedFromString } from '../sim/prng';
import { linkTiers, viewHalfHeight } from '../sim/size';
import {
  AOI_PER_HALF_HEIGHT,
  AoiManager,
  type AoiSelf,
  aoiRadius,
  INTERACT_LEAD_WU,
  INTERACT_RADII,
  type Known,
  type LinkClass,
  queryRadius,
  UNWANTED_GRACE_MS,
} from './aoi';
import { DEFAULT_CAP, MAX_CAP } from './connection-policy';

/** A starter at the origin: radius 10, adult radius 20, at rest. */
const STARTER: AoiSelf = { x: 0, y: 0, vx: 0, vy: 0, r: 10, adultR: 20 };
const known = (id: string, x: number, r = 10, y = 0): Known => ({
  id,
  x,
  y,
  r,
  at: 0,
  source: 'snapshot',
});
const NONE: ReadonlySet<string> = new Set();
const FRESH: ReadonlyMap<string, LinkClass> = new Map();

describe('aoiRadius and queryRadius', () => {
  it('are 2.65 view half-heights, and max(8,192, 4 × the AoI)', () => {
    expect(aoiRadius(10, 20)).toBeCloseTo(AOI_PER_HALF_HEIGHT * viewHalfHeight(10, 20), 9);
    // ADR 0062: a starter's AoI is 233 wu as a hatchling and 354 wu as an adult.
    expect(aoiRadius(10, 20)).toBeCloseTo(233, -1);
    expect(aoiRadius(20, 20)).toBeCloseTo(354, -1);
    expect(queryRadius(aoiRadius(10, 20))).toBe(8192);
    expect(queryRadius(5000)).toBe(20_000);
  });

  it('reads interaction as the engage candidates do', () => {
    expect(INTERACT_RADII).toBe(CANDIDATE_RADII);
  });
});

describe('AoiManager.classify', () => {
  it('puts a comparable creature at 650 wu in P1 and one at 700 wu in P4, and holds P1 to 980 wu', () => {
    const m = new AoiManager({ selfId: 'me' });
    const c = m.classify(STARTER, [known('a', 650), known('b', 700)], NONE, FRESH);
    expect(c.get('a')).toBe(1);
    expect(c.get('b')).toBe(4);
    for (const d of [700, 900, 980]) {
      expect(m.classify(STARTER, [known('a', d)], NONE, new Map([['a', 1]])).get('a')).toBe(1);
    }
    expect(m.classify(STARTER, [known('a', 981)], NONE, new Map([['a', 1]])).get('a')).toBe(4);
  });

  it('gives a creature two tiers bigger no class, however near', () => {
    const m = new AoiManager({ selfId: 'me' });
    expect(m.classify(STARTER, [known('giant', 100, 200)], NONE, FRESH).has('giant')).toBe(false);
  });

  it('makes its fight’s opponent P0 at 9,000 wu, known or not, and never itself', () => {
    const m = new AoiManager({ selfId: 'me' });
    const c = m.classify(
      STARTER,
      [known('foe', 9000), known('me', 0)],
      new Set(['foe', 'witness']),
      FRESH,
    );
    expect(c.get('foe')).toBe(0);
    expect(c.get('witness')).toBe(0);
    expect(c.has('me')).toBe(false);
  });

  it('drops a creature past 1.1 × Q, and uses the newest of several reports of one creature', () => {
    const m = new AoiManager({ selfId: 'me' });
    const q = queryRadius(aoiRadius(10, 20));
    expect(m.classify(STARTER, [known('far', q + 1)], NONE, FRESH).has('far')).toBe(false);
    expect(
      m.classify(STARTER, [known('far', q * 1.1)], NONE, new Map([['far', 4]])).get('far'),
    ).toBe(4);
    const stale = { ...known('a', 5000), at: 1, source: 'directory' as const };
    const fresh = { ...known('a', 300), at: 2, source: 'gossip' as const };
    expect(m.classify(STARTER, [fresh, stale], NONE, FRESH).get('a')).toBe(1);
    expect(m.classify(STARTER, [stale, fresh], NONE, FRESH).get('a')).toBe(1);
  });

  it('classes P2 and P3 by the AoI for a creature whose view is wider than its reach', () => {
    // A T1 adult of radius 100 sees 568 wu, so its AoI is about 1,500 wu and P1 ends at 1,400 wu.
    const self: AoiSelf = { x: 0, y: 0, vx: 0, vy: 0, r: 100, adultR: 100 };
    const aoi = aoiRadius(100, 100);
    expect(aoi).toBeGreaterThan(8 * 100 + INTERACT_LEAD_WU);
    const m = new AoiManager({ selfId: 'me' });
    const c = m.classify(
      self,
      [known('p2', aoi - 1, 100), known('p3', 2 * aoi - 1, 100), known('p4', 2 * aoi + 1, 100)],
      NONE,
      FRESH,
    );
    expect([c.get('p2'), c.get('p3'), c.get('p4')]).toEqual([2, 3, 4]);
  });

  it('keeps the class of a creature moving back and forth across 1.05 × the AoI', () => {
    const self: AoiSelf = { x: 0, y: 0, vx: 0, vy: 0, r: 100, adultR: 100 };
    const aoi = aoiRadius(100, 100);
    for (const start of [0.98, 1.12]) {
      const m = new AoiManager({ selfId: 'me' });
      let prev = m.classify(self, [known('o', start * aoi, 100)], NONE, FRESH);
      const first = prev.get('o');
      expect(first).toBe(start < 1 ? 2 : 3);
      for (let i = 0; i < 40; i++) {
        const d = (i % 2 === 0 ? 1.02 : 1.08) * aoi;
        prev = m.classify(self, [known('o', d, 100)], NONE, prev);
        expect(prev.get('o')).toBe(first);
      }
    }
  });

  it('orders P4 by the distance from where the player will be in 3 s', () => {
    const m = new AoiManager({ selfId: 'me', cap: 1 });
    // Swimming east at 100 wu/s: in 3 s it is at x = 300, nearer the creature ahead.
    const self: AoiSelf = { ...STARTER, vx: 100 };
    const c = m.classify(self, [known('behind', -2000), known('ahead', 2100)], NONE, FRESH);
    expect([c.get('behind'), c.get('ahead')]).toEqual([4, 4]);
    expect(m.plan(c, new Set(), 0).connect).toEqual(['ahead']);
  });

  it('is symmetric in P1 over 10,000 random pairs', () => {
    const rng = createRng(seedFromString('aoi-symmetry'), 'pairs');
    let p1 = 0;
    for (let i = 0; i < 10_000; i++) {
      const ra = 2 + rng.next() ** 2 * 1500;
      const rb = rng.next() < 0.5 ? ra * rng.range(0.5, 2) : 2 + rng.next() ** 2 * 1500;
      const a: AoiSelf = {
        x: rng.range(0, 50_000),
        y: rng.range(0, 50_000),
        vx: rng.range(-105, 105),
        vy: rng.range(-105, 105),
        r: ra,
        adultR: ra * rng.range(1, 3),
      };
      const reach = 8 * Math.max(ra, rb) + INTERACT_LEAD_WU;
      const d = reach * rng.range(0.9, 1.1);
      const th = rng.range(0, 2 * Math.PI);
      const b: AoiSelf = {
        x: a.x + d * Math.cos(th),
        y: a.y + d * Math.sin(th),
        vx: rng.range(-105, 105),
        vy: rng.range(-105, 105),
        r: rb,
        adultR: rb * rng.range(1, 3),
      };
      const ab = new AoiManager({ selfId: 'a' }).classify(
        a,
        [{ id: 'b', x: b.x, y: b.y, r: b.r, at: 0, source: 'snapshot' }],
        NONE,
        FRESH,
      );
      const ba = new AoiManager({ selfId: 'b' }).classify(
        b,
        [{ id: 'a', x: a.x, y: a.y, r: a.r, at: 0, source: 'gossip' }],
        NONE,
        FRESH,
      );
      expect(ab.get('b') === 1).toBe(ba.get('a') === 1);
      if (ab.get('b') === 1) p1++;
      if (!linkTiers(ra, rb)) expect(ab.has('b')).toBe(false);
    }
    // The pairs straddle the P1 edge, so both outcomes are well represented.
    expect(p1).toBeGreaterThan(2000);
    expect(p1).toBeLessThan(8000);
  });
});

describe('AoiManager.plan', () => {
  const rank = (m: AoiManager, ids: Iterable<string>) => [...ids].map((id) => m.rankOf(id));

  it('holds the cap over 10,000 random worlds of 1 to 80 known creatures', () => {
    const rng = createRng(seedFromString('aoi-plan'), 'worlds');
    let crowdedWorlds = 0;
    let fullWorlds = 0;
    const failures: string[] = [];
    for (let w = 0; w < 10_000; w++) {
      const m = new AoiManager({ selfId: 'me' });
      const n = rng.int(1, 80);
      const self: AoiSelf = {
        x: 20_000,
        y: 20_000,
        vx: rng.range(-105, 105),
        vy: rng.range(-105, 105),
        r: 10,
        adultR: 20,
      };
      // Some worlds pack creatures inside the interaction distance so P1 can pass 32.
      const spread = [300, 1500, 6000, 9000][rng.int(0, 3)] ?? 9000;
      const ks: Known[] = [];
      const p0 = new Set<string>();
      for (let i = 0; i < n; i++) {
        const id = `k${i}`;
        const th = rng.range(0, 2 * Math.PI);
        const d = rng.range(0, spread);
        const r = rng.next() < 0.1 ? 200 : rng.range(5, 25);
        ks.push({
          id,
          x: self.x + d * Math.cos(th),
          y: self.y + d * Math.sin(th),
          r,
          at: 0,
          source: 'gossip',
        });
        if (rng.next() < 0.03) p0.add(id);
      }
      const classes = m.classify(self, ks, p0, FRESH);
      // Hold a random part of what is known, as a page mid-way through would.
      const held = new Set(ks.filter(() => rng.next() < 0.3).map((k) => k.id));
      const { connect, evict, crowded } = m.plan(classes, held, 0);
      const after = new Set([...held, ...connect]);
      for (const id of evict) after.delete(id);
      // Checked without `expect` in the loop, which would cost most of the test's time.
      const fail = (why: string) => failures.push(`world ${w}: ${why}`);
      if (connect.some((id) => held.has(id))) fail('connects a held peer');
      if (evict.some((id) => !held.has(id))) fail('evicts a peer not held');

      const cls = (id: string) => classes.get(id);
      const p01 = [...classes].filter(([, c]) => c <= 1).map(([id]) => id);
      if (after.size > MAX_CAP) fail(`holds ${after.size}`);
      const low = [...after].filter((id) => (cls(id) ?? 5) >= 2);
      if (low.length > 0 && after.size > DEFAULT_CAP) fail(`holds P2–P4 with ${after.size}`);
      if (crowded !== p01.length > MAX_CAP) fail(`crowded ${crowded} with ${p01.length}`);
      if (crowded) {
        crowdedWorlds++;
        if (after.size !== MAX_CAP) fail(`crowded at ${after.size}`);
        if (p01.some((id) => cls(id) === 0 && !after.has(id))) fail('crowds out a P0');
      } else {
        if (p01.some((id) => !after.has(id))) fail('leaves out a P0 or P1');
        if (evict.some((id) => (cls(id) ?? 5) <= 1)) fail('evicts a P0 or P1');
      }
      // Each class fills nearest first: nobody left out is nearer than someone of its class held.
      for (const c of [1, 2, 3, 4] as const) {
        const ids = [...classes].filter(([, k]) => k === c).map(([id]) => id);
        const inRanks = rank(
          m,
          ids.filter((id) => after.has(id)),
        );
        const outRanks = rank(
          m,
          ids.filter((id) => !after.has(id)),
        );
        if (inRanks.length && outRanks.length && Math.min(...outRanks) < Math.max(...inRanks)) {
          fail(`P${c} not nearest first`);
        }
      }
      // And the room under 24 is used: classed creatures wait only when it is full.
      const waiting = [...classes.keys()].filter((id) => !after.has(id));
      if (waiting.length > 0 && after.size < DEFAULT_CAP)
        fail(`${waiting.length} wait at ${after.size}`);
      if (after.size >= DEFAULT_CAP) fullWorlds++;
    }
    expect(failures).toEqual([]);
    expect(crowdedWorlds).toBeGreaterThan(100);
    expect(fullWorlds).toBeGreaterThan(1000);
  });

  it('evicts an unwanted peer after 3 s unwanted, not before, and forgets a peer wanted again', () => {
    const m = new AoiManager({ selfId: 'me' });
    const held = new Set(['b']);
    const none = new Map<string, LinkClass>();
    expect(m.plan(none, held, 1000).evict).toEqual([]);
    expect(m.plan(none, held, 1000 + UNWANTED_GRACE_MS - 1).evict).toEqual([]);
    expect(m.plan(none, held, 1000 + UNWANTED_GRACE_MS).evict).toEqual(['b']);
    // Wanted again in between, its 3 s start over.
    const m2 = new AoiManager({ selfId: 'me' });
    m2.plan(none, held, 0);
    m2.plan(new Map([['b', 4]]), held, 2000);
    expect(m2.plan(none, held, 3500).evict).toEqual([]);
    expect(m2.plan(none, held, 3500 + UNWANTED_GRACE_MS).evict).toEqual(['b']);
  });

  it('gives the worst P2–P4 place to a new P1, and an unwanted peer’s before any', () => {
    const m = new AoiManager({ selfId: 'me' });
    const ks = Array.from({ length: 24 }, (_, i) => known(`n${i}`, 1000 + i * 100));
    const classes = m.classify(STARTER, ks, NONE, FRESH);
    const held = new Set(ks.map((k) => k.id));
    expect(m.plan(classes, held, 0)).toEqual({ connect: [], evict: [], crowded: false });
    const near = m.classify(STARTER, [...ks, known('p1', 300)], NONE, classes);
    expect(m.plan(near, held, 0)).toEqual({ connect: ['p1'], evict: ['n23'], crowded: false });
    // With an unwanted peer still in its grace, that one goes first.
    held.add('gone');
    expect(m.plan(near, held, 0)).toEqual({
      connect: ['p1'],
      evict: ['n23', 'gone'],
      crowded: false,
    });
    held.delete('n23');
    expect(m.plan(near, held, 0)).toEqual({ connect: ['p1'], evict: ['gone'], crowded: false });
  });

  it('keeps P0 and the nearest P1 when they pass 32, and says crowded', () => {
    const m = new AoiManager({ selfId: 'me' });
    const ks = Array.from({ length: 40 }, (_, i) =>
      known(`c${String(i).padStart(2, '0')}`, 10 + i * 10),
    );
    const classes = m.classify(STARTER, [...ks, known('foe', 9000)], new Set(['foe']), FRESH);
    const { connect, evict, crowded } = m.plan(classes, new Set(), 0);
    expect(crowded).toBe(true);
    expect(evict).toEqual([]);
    expect(connect).toHaveLength(MAX_CAP);
    expect(connect).toContain('foe');
    expect(connect).toContain('c30');
    expect(connect).not.toContain('c31');
  });

  it('honours a lower cap for P2–P4 and refuses a cap past 32', () => {
    const m = new AoiManager({ selfId: 'me', cap: 2 });
    const classes = m.classify(
      STARTER,
      [known('a', 2000), known('b', 3000), known('c', 4000)],
      NONE,
      FRESH,
    );
    expect(m.plan(classes, new Set(), 0).connect).toEqual(['a', 'b']);
    expect(() => new AoiManager({ selfId: 'me', cap: 33 })).toThrow(RangeError);
  });
});
