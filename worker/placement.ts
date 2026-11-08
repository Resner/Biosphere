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
/** A ring at a wide group's edge is first tried at about this many of its candidates. */
const EDGE_SAMPLE = 48;

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

/** The cells that can hold a chained neighbour, each pair once (forward), those one cell away first. */
const CELL_OFFSETS: readonly (readonly [number, number])[] = [1, 2].flatMap((reach) =>
  Array.from({ length: reach + 1 }, (_, dy) => dy).flatMap((dy) =>
    Array.from({ length: 2 * reach + 1 }, (_, i) => [i - reach, dy] as const).filter(
      ([dx]) => (dy > 0 || dx > 0) && Math.max(Math.abs(dx), dy) === reach,
    ),
  ),
);

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
  // Cells so small that all of a cell's members lie within the chain of each other (the diagonal is
  // a hair under it): a cell is one piece at once, and only two cells within two cells of each other
  // are looked at, stopping at the first pair that links them.
  const side = chain / 1.4143;
  const cellKey = (cx: number, cy: number): number => cx * 4_194_304 + cy;
  const cells = new Map<number, { cx: number; cy: number; at: number[] }>();
  linkable.forEach((m, i) => {
    const cx = Math.floor(m.x / side);
    const cy = Math.floor(m.y / side);
    const k = cellKey(cx, cy);
    const cell = cells.get(k);
    if (cell === undefined) cells.set(k, { cx, cy, at: [i] });
    else cell.at.push(i);
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
  for (const cell of cells.values()) {
    const head = cell.at[0] as number;
    for (const i of cell.at) parent[i] = head;
  }
  const linked = (a: readonly number[], b: readonly number[]): boolean => {
    for (const i of a) {
      const m = linkable[i] as Placed;
      for (const j of b) {
        const o = linkable[j] as Placed;
        if ((o.x - m.x) ** 2 + (o.y - m.y) ** 2 <= chain2) return true;
      }
    }
    return false;
  };
  // Neighbours at one cell first, so that a dense area is one piece before the cells two apart (only
  // a pair at the very corners can link those) are looked at, and are then skipped as already joined.
  for (const [dx, dy] of CELL_OFFSETS) {
    for (const cell of cells.values()) {
      const other = cells.get(cellKey(cell.cx + dx, cell.cy + dy));
      if (other === undefined) continue;
      const rootA = find(cell.at[0] as number);
      const rootB = find(other.at[0] as number);
      if (rootA !== rootB && linked(cell.at, other.at)) parent[rootB] = rootA;
    }
  }
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
      radius: set.reduce((far, m) => Math.max(far, Math.hypot(m.x - x, m.y - y)), 0),
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

/** Whether a point lies in the depth band a spawn must keep to (the wave's gate reads it). */
export function inSpawnBand(world: PlaceInput['world'], x: number, y: number): boolean {
  const near = Math.hypot(x - world.size / 2, y - world.size / 2) <= RULES.bathymetry.centreRadius;
  return depthInBand(
    depthAt(simWorld(world).seed32, x, y, world.size),
    near ? FLOOR_AT_CENTRE : BAND_FLOOR,
  );
}

const BAND_FLOOR = RULES.bathymetry.zones.shallows + RULES.hazards.uvBand;

/**
 * The band's floor is the shallower of 0.27 and the shallowest depth the centre cap allows around
 * the spawn centre (`base - centreCap` = 0.26): flat ground at that depth, which the depth pin can
 * leave there, must hold a spawn like any other.
 */
const FLOOR_AT_CENTRE = Math.min(BAND_FLOOR, RULES.bathymetry.base - RULES.bathymetry.centreCap);

const depthInBand = (depth: number, floor = BAND_FLOOR): boolean =>
  depth >= floor && depth <= RULES.hazards.pressureStart;

/** A disc a spawn must stay out of: nearer than `d` is invalid. */
interface Avoid {
  x: number;
  y: number;
  d2: number;
}

/** Points in a hash grid of square cells: a query visits the 3 × 3 cells around a point. */
class Grid<T extends { x: number; y: number }> {
  private readonly cells = new Map<number, T[]>();

  /** Every item that lies within `cell` of a queried point is in the cells it visits. */
  constructor(
    items: readonly T[],
    private readonly cell: number,
  ) {
    for (const item of items) {
      const k = this.key(Math.floor(item.x / cell), Math.floor(item.y / cell));
      const bucket = this.cells.get(k);
      if (bucket === undefined) this.cells.set(k, [item]);
      else bucket.push(item);
    }
  }

  private key(cx: number, cy: number): number {
    return cx * 1_048_576 + cy;
  }

  /** Whether `test` holds for any item in the cells around (x, y). */
  some(x: number, y: number, test: (item: T) => boolean): boolean {
    const cx = Math.floor(x / this.cell);
    const cy = Math.floor(y / this.cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = this.cells.get(this.key(cx + dx, cy + dy));
        if (bucket === undefined) continue;
        for (const item of bucket) if (test(item)) return true;
      }
    }
    return false;
  }
}

/** The radius the rings reach from their start before the candidate budget is spent. */
function ringsReach(base: number): number {
  let tried = 0;
  let reach = 0;
  for (let ring = 0; ring < SPAWN_RINGS; ring++) {
    const rho = (ring * base) / 4;
    tried += ring === 0 ? 1 : Math.max(8, Math.ceil((2 * Math.PI * rho) / (base / 2)));
    if (tried > SPAWN_CANDIDATES) break;
    reach = rho;
  }
  return reach;
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

  // Within the centre cap's radius the floor is `FLOOR_AT_CENTRE`, so a world whose pin leaves the
  // centre on flat 0.26 ground still holds spawns beside it.
  const nearCentre = (x: number, y: number): boolean =>
    Math.hypot(x - centre.x, y - centre.y) <= RULES.bathymetry.centreRadius;
  // The discs through a grid whose cells are the widest avoid distance: a candidate checks the nine
  // cells around it, never every member.
  const widest = Math.sqrt(avoid.reduce((w, a) => Math.max(w, a.d2), 1));
  const discs = new Grid(avoid, widest);
  const hit =
    (x: number, y: number) =>
    (a: Avoid): boolean =>
      (a.x - x) ** 2 + (a.y - y) ** 2 < a.d2;

  // The cheap rules first: the world's edges and the discs.
  const free = (x: number, y: number): boolean => {
    if (x < SPAWN_EDGE_WU || y < SPAWN_EDGE_WU) return false;
    if (x > world.size - SPAWN_EDGE_WU || y > world.size - SPAWN_EDGE_WU) return false;
    return !discs.some(x, y, hit(x, y));
  };
  // Then the field: depth and plumes, which cost far more.
  const deep = (x: number, y: number): boolean => {
    // The depth pin leaves the spawn centre in 0.26 to 0.54: a seed at its shallow end would refuse
    // the centre itself, which an empty world must give (and only an empty world).
    if (members.length > 0 || x !== centre.x || y !== centre.y) {
      const depth = depthAt(sim.seed32, x, y, world.size);
      if (!depthInBand(depth, nearCentre(x, y) ? FLOOR_AT_CENTRE : BAND_FLOOR)) return false;
    }
    return clearOfPlumes(sim, x, y, reach, future);
  };

  const base = clearance(spawner, spawner);
  const phase = rng.next() * 2 * Math.PI;
  // The rings start at the centroid. A group wider than they reach, whose rings found nothing, is
  // searched again from 2 clearances inside its radius, at its edge (ADR 0069).
  const edge = (group: Group | null): number =>
    group !== null && group.radius + 2 * base > ringsReach(base)
      ? Math.max(0, group.radius - 2 * base)
      : 0;
  const search = (around: Vec2, group: Group | null, from = 0): Vec2 | null => {
    const ids = group === null ? null : new Set(group.ids);
    const near: Placed[] = ids === null ? [] : members.filter((m) => ids.has(m.id));
    const nearReach = near.reduce((w, m) => Math.max(w, p1Reach(spawner.r, m.r)), 1);
    const nearGrid = new Grid(near, nearReach);
    const first = Math.floor(from / (base / 4));
    let tried = 0;
    for (let ring = first; ring < first + SPAWN_RINGS; ring++) {
      const rho = (ring * base) / 4;
      const count = ring === 0 ? 1 : Math.max(8, Math.ceil((2 * Math.PI * rho) / (base / 2)));
      tried += count;
      if (tried > SPAWN_CANDIDATES) return null;
      const open: Vec2[] = [];
      for (let i = 0; i < count; i++) {
        const angle = phase + (2 * Math.PI * i) / count;
        const x = around.x + rho * Math.cos(angle);
        const y = around.y + rho * Math.sin(angle);
        if (free(x, y)) open.push({ x, y });
      }
      const deepOf = (list: Vec2[]): Vec2[] => list.filter((c) => deep(c.x, c.y));
      // A long ring at a wide group's edge is tried through an even sample first; only a ring whose
      // sample holds no valid point is tried whole.
      let found: Vec2[];
      if (from > 0 && open.length > EDGE_SAMPLE) {
        const stride = Math.ceil(open.length / EDGE_SAMPLE);
        found = deepOf(open.filter((_, i) => i % stride === 0));
        if (found.length === 0) found = deepOf(open);
      } else found = deepOf(open);
      if (found.length === 0) continue;
      const close = found.filter((c) =>
        nearGrid.some(c.x, c.y, (m) => Math.hypot(m.x - c.x, m.y - c.y) <= p1Reach(spawner.r, m.r)),
      );
      const pool = close.length > 0 ? close : found;
      return pool[rng.int(0, pool.length - 1)] as Vec2;
    }
    return null;
  };

  let first = search(best === null ? centre : { x: best.x, y: best.y }, best);
  const outer = edge(best);
  if (first === null && best !== null && outer > 0) first = search(best, best, outer);
  if (first !== null) return { ...first, group: best, fallback: 'none' };
  if (best !== null) {
    const again = search(centre, null);
    if (again !== null) return { ...again, group: best, fallback: 'centre-rings' };
  }
  return { x: centre.x, y: centre.y, group: best, fallback: 'centre' };
}
