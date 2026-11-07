import { describe, expect, it } from 'vitest';
import { aoiRadius, INTERACT_LEAD_WU, INTERACT_RADII } from '../src/net/aoi';
import { depthAt } from '../src/sim/bathymetry';
import { createRng, seedFromString } from '../src/sim/prng';
import { RULES } from '../src/sim/rules';
import { sizeTier } from '../src/sim/size';
import { clearOfPlumes, plumeFutures } from '../src/sim/spawn';
import type { Vec2 } from '../src/sim/types';
import { createWorld } from '../src/sim/world';
import { speedTest } from '../tests/heavy';
import {
  clearance,
  groupsFor,
  type Placed,
  place,
  SPAWN_EDGE_WU,
  SPAWN_RECENT_MS,
  type Spawner,
} from './placement';

const SIZE = RULES.world.size;
const CENTRE = { x: SIZE / 2, y: SIZE / 2 };
const STARTER_R = 20;
const STARTER_AOI = aoiRadius(STARTER_R, STARTER_R);
const STARTER: Spawner = { r: STARTER_R, adultR: STARTER_R, aoi: STARTER_AOI };
const SEED = 'placement-test';
const WORLD = { seed: SEED, size: SIZE, tick: 0 };
const SIM = createWorld({ seed: SEED, size: SIZE });
const FUTURE = plumeFutures(SIM);

const member = (id: string, x: number, y: number, r = STARTER_R, n = 0): Placed => ({
  id,
  x,
  y,
  r,
  aoi: aoiRadius(r, r),
  n,
});

const rngFor = (label: string) => createRng(seedFromString(label), 'placement');

describe('clearance', () => {
  it('is the larger AoI, never less than twelve of the larger radius', () => {
    expect(Math.round(clearance({ r: 20, aoi: 354 }, { r: 20, aoi: 354 }))).toBe(354);
    expect(clearance({ r: 10, aoi: 233 }, { r: 63, aoi: 992 })).toBe(992);
    expect(clearance({ r: 400, aoi: 1000 }, { r: 20, aoi: 354 })).toBe(4800);
  });

  it('matches the starter AoI the spec names', () => {
    expect(Math.round(STARTER_AOI)).toBe(354);
  });
});

describe('groupsFor', () => {
  it('chains members into groups within half the query radius', () => {
    const members = [
      member('a', 0, 0),
      member('b', 3000, 0),
      member('c', 6000, 0),
      member('d', 12_000, 0),
    ];
    const groups = groupsFor(members, STARTER, { x: 0, y: 0 });
    const sets = groups.map((g) => [...g.ids].sort().join(''));
    expect(sets).toContain('abc');
    expect(sets).toContain('d');
    expect(groups).toHaveLength(2);
    const big = groups.find((g) => g.ids.length === 3);
    expect(big?.x).toBeCloseTo(3000);
    expect(big?.linkable).toBe(3);
  });

  it('leaves out members whose tier cannot link', () => {
    const groups = groupsFor([member('t2', 100, 0, 400), member('s', 200, 0)], STARTER, CENTRE);
    expect(groups.map((g) => g.ids)).toEqual([['s']]);
  });

  it('puts the spawner’s own tier first, then the more linkable, then the nearer, then the lower id', () => {
    const starters = Array.from({ length: 5 }, (_, i) => member(`s${i}`, 1000 + i * 100, 1000));
    const t1s = Array.from({ length: 8 }, (_, i) =>
      member(`t${i}`, 100_000 + i * 100, 100_000, 63),
    );
    const groups = groupsFor([...t1s, ...starters], STARTER, CENTRE);
    expect(groups[0]?.sameTier).toBe(5);
    expect(groups[0]?.ids.every((id) => id.startsWith('s'))).toBe(true);
    expect(groups[1]?.sameTier).toBe(0);

    const near = [member('far1', 10_000, 10_000), member('near1', 130_000, 130_000)];
    expect(groupsFor(near, STARTER, CENTRE)[0]?.ids).toEqual(['near1']);
    const ties = [member('b', 130_000, 130_000), member('a', 130_000, 130_000 + 20_000)];
    // equal in tier and size; `b` is nearer to the centre
    expect(groupsFor(ties, STARTER, CENTRE)[0]?.ids).toEqual(['b']);
    const same = [member('z', 20_000, 20_000), member('y', 20_000, 20_000)];
    // chained into one group, so the lowest id only matters across equal groups
    expect(groupsFor(same, STARTER, CENTRE)).toHaveLength(1);
  });
});

/** Everything `place` promises, checked independently of its search. */
function checkValid(
  point: { x: number; y: number },
  members: readonly Placed[],
  recent: readonly { x: number; y: number; r: number; aoi: number; t: number }[],
  now: number,
  spawner: Spawner,
): string | null {
  const sim = SIM;
  const { x, y } = point;
  if (
    x < SPAWN_EDGE_WU ||
    y < SPAWN_EDGE_WU ||
    x > SIZE - SPAWN_EDGE_WU ||
    y > SIZE - SPAWN_EDGE_WU
  ) {
    return 'edge';
  }
  const depth = depthAt(sim.seed32, x, y, SIZE);
  const atCentre = x === CENTRE.x && y === CENTRE.y; // the pin keeps the centre in 0.26 to 0.54
  if (!atCentre && depth < RULES.bathymetry.zones.shallows + RULES.hazards.uvBand)
    return `depth ${depth} low`;
  if (!atCentre && depth > RULES.hazards.pressureStart) return `depth ${depth} high`;
  if (!clearOfPlumes(sim, x, y, 2.5 * spawner.r, FUTURE)) return 'plume';
  const tier = sizeTier(spawner.r * spawner.r);
  for (const m of members) {
    const d = Math.hypot(m.x - x, m.y - y);
    const gap = Math.abs(sizeTier(m.r * m.r) - tier);
    if (gap <= RULES.encounter.maxTierGap && d < clearance(spawner, m)) return `clearance ${m.id}`;
    if (m.n !== 0 && d < INTERACT_RADII * Math.max(spawner.r, m.r) + INTERACT_LEAD_WU) {
      return `instance ${m.id}`;
    }
  }
  for (const s of recent) {
    if (now - s.t >= SPAWN_RECENT_MS) continue;
    if (Math.hypot(s.x - x, s.y - y) < clearance(spawner, s)) return 'recent';
  }
  return null;
}

const p1Reach = (spawner: Spawner, m: Placed) =>
  INTERACT_RADII * Math.max(spawner.r, m.r) + INTERACT_LEAD_WU;

/** A seeded world of 0 to 300 members, mostly starters, some T1 and T2, some in instances. */
function randomWorld(i: number) {
  const rng = rngFor(`world-${i}`);
  const count = rng.int(0, 300);
  const spread = rng.range(500, 40_000);
  const members: Placed[] = [];
  for (let k = 0; k < count; k++) {
    const roll = rng.next();
    const r = roll < 0.8 ? STARTER_R : roll < 0.93 ? 63 : 260;
    const n = rng.next() < 0.15 ? rng.int(1, 40) : 0;
    members.push(
      member(
        `m${k}`,
        CENTRE.x + rng.range(-spread, spread),
        CENTRE.y + rng.range(-spread, spread),
        r,
        n,
      ),
    );
  }
  const now = 1_000_000;
  const recent = Array.from({ length: rng.int(0, 12) }, () => ({
    x: CENTRE.x + rng.range(-spread, spread),
    y: CENTRE.y + rng.range(-spread, spread),
    r: STARTER_R,
    aoi: STARTER_AOI,
    t: now - rng.int(0, 2 * SPAWN_RECENT_MS),
  }));
  return { members, recent, now };
}

describe('place', () => {
  it('is the spawn centre in an empty world', () => {
    const out = place({
      members: [],
      recent: [],
      spawner: STARTER,
      centre: CENTRE,
      world: WORLD,
      now: 0,
      rng: rngFor('empty'),
    });
    expect(out).toEqual({ x: CENTRE.x, y: CENTRE.y, group: null, fallback: 'none' });
  });

  it('puts every point inside every rule, over 2,000 seeded worlds', () => {
    let centreFallbacks = 0;
    for (let i = 0; i < 2000; i++) {
      const { members, recent, now } = randomWorld(i);
      const out = place({
        members,
        recent,
        spawner: STARTER,
        centre: CENTRE,
        world: WORLD,
        now,
        rng: rngFor(`draw-${i}`),
      });
      if (out.fallback === 'centre') {
        centreFallbacks++;
        expect(out.x).toBe(CENTRE.x);
        expect(out.y).toBe(CENTRE.y);
        continue;
      }
      expect(checkValid(out, members, recent, now, STARTER), `world ${i}`).toBeNull();
    }
    expect(centreFallbacks).toBeLessThan(40);
  });

  it('keeps within P1 reach of a group member when its winning ring allows it', () => {
    let near = 0;
    let withGroup = 0;
    for (let i = 0; i < 300; i++) {
      const rng = rngFor(`near-${i}`);
      const members = Array.from({ length: rng.int(3, 40) }, (_, k) =>
        member(`g${k}`, CENTRE.x + rng.range(-1500, 1500), CENTRE.y + rng.range(-1500, 1500)),
      );
      const out = place({
        members,
        recent: [],
        spawner: STARTER,
        centre: CENTRE,
        world: WORLD,
        now: 0,
        rng: rngFor(`near-draw-${i}`),
      });
      if (out.group === null || out.fallback !== 'none') continue;
      withGroup++;
      const ids = new Set(out.group.ids);
      const close = members.some(
        (m) => ids.has(m.id) && Math.hypot(m.x - out.x, m.y - out.y) <= p1Reach(STARTER, m),
      );
      if (close) near++;
    }
    expect(withGroup).toBeGreaterThan(250);
    // The winning ring is the first with any valid point; on it a point within reach of the group
    // comes first when there is one, which a group this dense almost always offers.
    expect(near).toBeGreaterThanOrEqual(withGroup * 0.9);
  });

  it('gives the same point for the same input and seed', () => {
    const { members, recent, now } = randomWorld(7);
    const run = () =>
      place({
        members,
        recent,
        spawner: STARTER,
        centre: CENTRE,
        world: WORLD,
        now,
        rng: rngFor('same'),
      });
    expect(run()).toEqual(run());
  });

  it('draws at least 10 distinct points over 100 seeds in one world', () => {
    const members = Array.from({ length: 30 }, (_, k) =>
      member(`d${k}`, CENTRE.x + (k % 6) * 120, CENTRE.y + Math.floor(k / 6) * 120),
    );
    const points = new Set<string>();
    for (let s = 0; s < 100; s++) {
      const out = place({
        members,
        recent: [],
        spawner: STARTER,
        centre: CENTRE,
        world: WORLD,
        now: 0,
        rng: rngFor(`seed-${s}`),
      });
      points.add(`${Math.round(out.x)},${Math.round(out.y)}`);
    }
    expect(points.size).toBeGreaterThanOrEqual(10);
  });

  it('grows the area outward as 300 starters are placed one after another', () => {
    const members: Placed[] = [];
    const distances: number[] = [];
    for (let k = 0; k < 300; k++) {
      const out = place({
        members,
        recent: [],
        spawner: STARTER,
        centre: CENTRE,
        world: WORLD,
        now: 0,
        rng: rngFor(`grow-${k}`),
      });
      expect(out.fallback).not.toBe('centre');
      for (const m of members) {
        expect(Math.hypot(m.x - out.x, m.y - out.y)).toBeGreaterThanOrEqual(clearance(STARTER, m));
      }
      members.push(member(`s${k}`, out.x, out.y));
      distances.push(Math.hypot(out.x - CENTRE.x, out.y - CENTRE.y));
    }
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
    const early = median(distances.slice(1, 20));
    const late = median(distances.slice(280, 300));
    expect(late).toBeGreaterThanOrEqual(3 * early);
  });

  it('keeps a group in the abyss out of the abyss', () => {
    const sim = SIM;
    // Find a point deeper than the pressure line and put a group there.
    let abyss: { x: number; y: number } | null = null;
    for (let x = SPAWN_EDGE_WU; x < SIZE - SPAWN_EDGE_WU && abyss === null; x += 1024) {
      for (let y = SPAWN_EDGE_WU; y < SIZE - SPAWN_EDGE_WU; y += 1024) {
        if (depthAt(sim.seed32, x, y, SIZE) > RULES.hazards.pressureStart + 0.1) {
          abyss = { x, y };
          break;
        }
      }
    }
    if (abyss === null) throw new Error('no abyss in the test world');
    const at: Vec2 = abyss;
    const members = Array.from({ length: 6 }, (_, k) => member(`ab${k}`, at.x + k * 50, at.y));
    const out = place({
      members,
      recent: [],
      spawner: STARTER,
      centre: CENTRE,
      world: WORLD,
      now: 0,
      rng: rngFor('abyss'),
    });
    expect(out.group).not.toBeNull();
    expect(checkValid(out, members, [], 0, STARTER)).toBeNull();
  });

  speedTest('one placement among 300 members takes under 20 ms', () => {
    const members: Placed[] = [];
    for (let k = 0; k < 300; k++) {
      const rng = rngFor(`speed-${k}`);
      members.push(
        member(`s${k}`, CENTRE.x + rng.range(-2500, 2500), CENTRE.y + rng.range(-2500, 2500)),
      );
    }
    const args = {
      members,
      recent: [],
      spawner: STARTER,
      centre: CENTRE,
      world: WORLD,
      now: 0,
    };
    place({ ...args, rng: rngFor('warm') }); // builds the world's depth field once
    const started = performance.now();
    place({ ...args, rng: rngFor('timed') });
    expect(performance.now() - started).toBeLessThan(20);
  });
});
