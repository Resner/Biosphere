// Where a creature enters the water (M12 T2, ADR 0064): groups of the players it could link to, and
// the placement around the best one. Pure: no Hub and no wire, so the harness and the wave run it
// in Node too.

import { p1Reach, queryRadius } from '../src/net/aoi';
import { depthAt } from '../src/sim/bathymetry';
import type { Rng } from '../src/sim/prng';
import { RULES } from '../src/sim/rules';
import { linkTiers, sizeTier } from '../src/sim/size';
import { clearOfPlumes, plumeFutures } from '../src/sim/spawn';
import type { Vec2, World } from '../src/sim/types';
import { createWorld } from '../src/sim/world';

/** The clearance is never less than this many of the larger radius. */
export const CLEAR_RADII = 12;
/** A spawn keeps its clearance for this long. */
export const SPAWN_RECENT_MS = 60_000;
/** A spawn lies at least this far inside the world's edges. */
export const SPAWN_EDGE_WU = 1024;
export const SPAWN_RINGS = 128;
export const SPAWN_CANDIDATES = 8192;

/** A member of the directory, by its last report. `n` is its instance (0: the open water). */
export interface Placed {
  id: string;
  x: number;
  y: number;
  r: number;
  aoi: number;
  n: number;
}

/** The creature entering the water: its radius, its adult radius and its AoI. */
export interface Spawner {
  r: number;
  adultR: number;
  aoi: number;
}

export interface Group {
  ids: string[];
  x: number;
  y: number;
  /** The farthest member from the centroid (wu). */
  radius: number;
  /** Members of the spawner's own size tier. */
  sameTier: number;
  /** Members the spawner could link to: all of them, as a group is made of linkable members. */
  linkable: number;
}

/** How far apart two creatures must be so that neither is in the other's attack range at once. */
export function clearance(a: { r: number; aoi: number }, b: { r: number; aoi: number }): number {
  return Math.max(a.aoi, b.aoi, CLEAR_RADII * Math.max(a.r, b.r));
}

const tierOf = (r: number): number => sizeTier(r * r);

const WORLD_CENTRE: Vec2 = { x: RULES.world.size / 2, y: RULES.world.size / 2 };

/**
 * The groups of the members a spawner could link to, best first (ADR 0064): single-linkage clusters
 * chained within half its query radius. The best has the most members of the spawner's own tier,
 * then the most linkable, then is nearest to `centre`, then has the lowest member id.
 */
export function groupsFor(
  members: readonly Placed[],
  s: Spawner,
  centre: Vec2 = WORLD_CENTRE,
): Group[] {
  const linkable = members.filter((m) => linkTiers(s.r, m.r));
  const chain = queryRadius(s.aoi) / 2;
  const chain2 = chain * chain;
  const cell = (v: number): number => Math.floor(v / chain);
  const grid = new Map<string, number[]>();
  const key = (cx: number, cy: number): string => `${cx},${cy}`;
  linkable.forEach((m, i) => {
    const k = key(cell(m.x), cell(m.y));
    const bucket = grid.get(k);
    if (bucket === undefined) grid.set(k, [i]);
    else bucket.push(i);
  });
  const parent = linkable.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root] as number;
    let walk = i;
    while (parent[walk] !== root) {
      const next = parent[walk] as number;
      parent[walk] = root;
      walk = next;
    }
    return root;
  };
  linkable.forEach((m, i) => {
    const cx = cell(m.x);
    const cy = cell(m.y);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const j of grid.get(key(cx + dx, cy + dy)) ?? []) {
          if (j <= i) continue;
          const o = linkable[j] as Placed;
          if ((o.x - m.x) ** 2 + (o.y - m.y) ** 2 <= chain2) parent[find(j)] = find(i);
        }
      }
    }
  });
  const sets = new Map<number, Placed[]>();
  linkable.forEach((m, i) => {
    const root = find(i);
    const set = sets.get(root);
    if (set === undefined) sets.set(root, [m]);
    else set.push(m);
  });
  const tier = tierOf(s.r);
  const groups = [...sets.values()].map((set) => {
    const x = set.reduce((sum, m) => sum + m.x, 0) / set.length;
    const y = set.reduce((sum, m) => sum + m.y, 0) / set.length;
    return {
      ids: set.map((m) => m.id).sort(),
      x,
      y,
      radius: Math.max(...set.map((m) => Math.hypot(m.x - x, m.y - y))),
      sameTier: set.filter((m) => tierOf(m.r) === tier).length,
      linkable: set.length,
    };
  });
  const away = (g: Group): number => Math.hypot(g.x - centre.x, g.y - centre.y);
  return groups.sort(
    (a, b) =>
      b.sameTier - a.sameTier ||
      b.linkable - a.linkable ||
      away(a) - away(b) ||
      Number((a.ids[0] as string) > (b.ids[0] as string)) -
        Number((a.ids[0] as string) < (b.ids[0] as string)),
  );
}

export interface PlaceInput {
  /** Everyone else in the water, by their last reports. */
  members: readonly Placed[];
  recent: readonly { x: number; y: number; r: number; aoi: number; t: number }[];
  spawner: Spawner;
  /** The spawn centre. */
  centre: Vec2;
  world: { seed: string; size: number; tick: number };
  now: number;
  rng: Rng;
}

export interface Placement {
  x: number;
  y: number;
  group: Group | null;
  fallback: 'none' | 'centre-rings' | 'centre';
}

/** A few worlds stay built (their depth field is calibrated once), since a hub places many spawns. */
const worlds = new Map<string, World>();
function simWorld(w: PlaceInput['world']): World {
  const key = `${w.seed}:${w.size}`;
  let world = worlds.get(key);
  if (world === undefined) {
    if (worlds.size >= 4) worlds.clear();
    world = createWorld({ seed: w.seed, size: w.size });
    worlds.set(key, world);
  }
  return { ...world, tick: w.tick };
}

/** A disc a spawn must stay out of: nearer than `d` is invalid. */
interface Avoid {
  x: number;
  y: number;
  d2: number;
}

/**
 * The point where `spawner` enters the water (ADR 0064): rings around the best group's centroid, or
 * around the spawn centre when there is none, from the middle outward. The first ring with a valid
 * candidate wins, and a candidate within P1 reach of a member of the group comes first.
 */
export function place(p: PlaceInput): Placement {
  const { members, recent, spawner, centre, world, now, rng } = p;
  const groups = groupsFor(members, spawner, centre);
  const best = groups[0] ?? null;
  const sim = simWorld(world);
  const future = plumeFutures(sim);
  const tier = tierOf(spawner.r);
  const lo = RULES.bathymetry.zones.shallows + RULES.hazards.uvBand;
  const hi = RULES.hazards.pressureStart;
  const reach = 2.5 * spawner.r;

  const avoid: Avoid[] = [];
  for (const m of members) {
    let d = 0;
    if (Math.abs(tierOf(m.r) - tier) <= RULES.encounter.maxTierGap) d = clearance(spawner, m);
    if (m.n !== 0) d = Math.max(d, p1Reach(spawner.r, m.r));
    if (d > 0) avoid.push({ x: m.x, y: m.y, d2: d * d });
  }
  for (const s of recent) {
    if (now - s.t >= SPAWN_RECENT_MS) continue;
    const d = clearance(spawner, s);
    avoid.push({ x: s.x, y: s.y, d2: d * d });
  }

  const valid = (x: number, y: number): boolean => {
    if (x < SPAWN_EDGE_WU || y < SPAWN_EDGE_WU) return false;
    if (x > world.size - SPAWN_EDGE_WU || y > world.size - SPAWN_EDGE_WU) return false;
    for (const a of avoid) {
      if ((a.x - x) ** 2 + (a.y - y) ** 2 < a.d2) return false;
    }
    // The depth pin leaves the spawn centre in 0.26 to 0.54: a seed at its shallow end would refuse
    // the centre itself, which an empty world must give (and only an empty world).
    if (members.length > 0 || x !== centre.x || y !== centre.y) {
      const depth = depthAt(sim.seed32, x, y, world.size);
      if (depth < lo || depth > hi) return false;
    }
    return clearOfPlumes(sim, x, y, reach, future);
  };

  const base = clearance(spawner, spawner);
  const phase = rng.next() * 2 * Math.PI;
  const search = (around: Vec2, group: Group | null): Vec2 | null => {
    const near: Placed[] = group === null ? [] : members.filter((m) => group.ids.includes(m.id));
    let tried = 0;
    for (let ring = 0; ring < SPAWN_RINGS; ring++) {
      const rho = (ring * base) / 4;
      const count = ring === 0 ? 1 : Math.max(8, Math.ceil((2 * Math.PI * rho) / (base / 2)));
      tried += count;
      if (tried > SPAWN_CANDIDATES) return null;
      const found: Vec2[] = [];
      for (let i = 0; i < count; i++) {
        const angle = phase + (2 * Math.PI * i) / count;
        const x = around.x + rho * Math.cos(angle);
        const y = around.y + rho * Math.sin(angle);
        if (valid(x, y)) found.push({ x, y });
      }
      if (found.length === 0) continue;
      const close = found.filter((c) =>
        near.some((m) => Math.hypot(m.x - c.x, m.y - c.y) <= p1Reach(spawner.r, m.r)),
      );
      const pool = close.length > 0 ? close : found;
      return pool[rng.int(0, pool.length - 1)] as Vec2;
    }
    return null;
  };

  const first = search(best === null ? centre : { x: best.x, y: best.y }, best);
  if (first !== null) return { ...first, group: best, fallback: 'none' };
  if (best !== null) {
    const again = search(centre, null);
    if (again !== null) return { ...again, group: best, fallback: 'centre-rings' };
  }
  return { x: centre.x, y: centre.y, group: best, fallback: 'centre' };
}
