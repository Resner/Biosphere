// The authority's directory (M11 T6, ADR 0062): a quadtree of who is where, over the world square.
// Pure, with no Hub, so the headless harness (T10) runs it in Node. A leaf splits in four above
// `leafMax` members unless it is `LEAF_MIN_SIZE` wide, and four sibling leaves merge back once
// they hold fewer than `mergeBelow` together. Its answer to a report (`near`) lists the linkable
// members within the query radius, nearest first, and the much smaller ones in the AoI as points.

import { queryRadius } from '../src/net/aoi';
import { OPEN_WATER, sameWater } from '../src/net/instance';
import {
  byteLength,
  type Leaf,
  NEAR_MAX,
  NEAR_MAX_BYTES,
  type NearPeer,
  SWARM_MAX,
} from '../src/net/protocol';
import { linkTiers } from '../src/sim/size';

/** A leaf splits above this many members; fixture mode: env `LEAF_MAX` (1–16). */
export const LEAF_MAX = 16;
/** Four sibling leaves merge below this many together (scaled down with a smaller `leafMax`). */
export const LEAF_MIN = 6;
/** A leaf this wide never splits. */
export const LEAF_MIN_SIZE = 1024;
/** The hub relays a signal between two members within max(Q_a, Q_b) + this. */
export const RELAY_SLACK_WU = 4096;
/** A court needs its two players within this distance. */
export const COURT_NEAR_WU = 12_288;
/** A kill's carrion is told to every member within this distance of it. */
export const CARRION_NOTICE_WU = 10_000;
/** A report further than this × the seconds since the last, plus `WHERE_JUMP_WU`, is a jump. */
export const WHERE_SPEED_WU = 300;
export const WHERE_JUMP_WU = 2000;
/** How far a creature can have moved `dtMs` after its last report, jump allowance included. */
export const reachSince = (dtMs: number): number =>
  (WHERE_SPEED_WU * Math.max(0, dtMs)) / 1000 + WHERE_JUMP_WU;
/** Positions in a `near` go out in steps of 1/8 wu, so 48 peers and 64 points fit in 8 KB. */
const WIRE_STEP = 8;

/** One member as it last reported: its centre and radius, its AoI radius (wu) and the time (ms). */
export interface DirMember {
  id: string;
  name: string;
  x: number;
  y: number;
  r: number;
  aoi: number;
  t: number;
}

/** A square of the tree: a leaf holds members, an inner node four children (SW, SE, NW, NE). */
interface Node {
  x: number;
  y: number;
  size: number;
  parent: Node | null;
  kids: [Node, Node, Node, Node] | null;
  members: Set<string>;
}

const leafOf = (n: Node): Leaf => ({ x: n.x, y: n.y, size: n.size });
const sameLeaf = (a: Leaf, b: Leaf) => a.x === b.x && a.y === b.y && a.size === b.size;
const wire = (v: number) => Math.round(v * WIRE_STEP) / WIRE_STEP;

export class Directory {
  readonly size: number;
  private readonly leafMax: number;
  private readonly mergeBelow: number;
  private readonly root: Node;
  private readonly byId = new Map<string, { m: DirMember; leaf: Node }>();
  /** Members whose leaf a split or merge may have changed during one operation, with the leaf before. */
  private touched: Map<string, Leaf> | null = null;

  constructor(size: number, opts: { leafMax?: number } = {}) {
    this.size = size;
    this.leafMax = opts.leafMax ?? LEAF_MAX;
    // A merged leaf must not split again at once: merge only below what a leaf may hold.
    this.mergeBelow = Math.max(1, Math.round((LEAF_MIN * this.leafMax) / LEAF_MAX));
    this.root = { x: 0, y: 0, size, parent: null, kids: null, members: new Set() };
  }

  /** Whether a centre lies in the world square. */
  inside(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.size && y < this.size;
  }

  /**
   * Places a member (new or moved) and returns its leaf, and every other member whose leaf a split
   * or merge changed. The centre must lie in the world square.
   */
  report(m: DirMember): { leaf: Leaf; moved: { id: string; leaf: Leaf }[] } {
    if (!this.inside(m.x, m.y)) throw new RangeError('outside the world');
    return this.tracking(m.id, () => {
      const held = this.byId.get(m.id);
      const member = { ...m };
      if (held && this.holds(held.leaf, m.x, m.y)) {
        held.m = member;
        return;
      }
      if (held) this.take(m.id, held.leaf);
      this.put(member, this.descend(m.x, m.y));
    });
  }

  /** Takes a member out; returns the others whose leaf a merge changed. */
  remove(id: string): { id: string; leaf: Leaf }[] {
    const held = this.byId.get(id);
    if (!held) return [];
    return this.tracking(id, () => this.take(id, held.leaf)).moved;
  }

  member(id: string): DirMember | null {
    const held = this.byId.get(id);
    return held ? { ...held.m } : null;
  }

  /** The member's leaf, or null. */
  leafOf(id: string): Leaf | null {
    const held = this.byId.get(id);
    return held ? leafOf(held.leaf) : null;
  }

  /** The distance between two members' centres, or null when either is unknown. */
  distance(a: string, b: string): number | null {
    const ma = this.byId.get(a)?.m;
    const mb = this.byId.get(b)?.m;
    return ma && mb ? Math.hypot(ma.x - mb.x, ma.y - mb.y) : null;
  }

  /** Every member whose centre lies within `radius` of (x, y). */
  around(x: number, y: number, radius: number): string[] {
    const out: string[] = [];
    this.visit(x, y, radius, (id, m) => {
      if (Math.hypot(m.x - x, m.y - y) <= radius) out.push(id);
    });
    return out;
  }

  /** Every leaf with its member count. */
  leaves(): { leaf: Leaf; members: number }[] {
    const out: { leaf: Leaf; members: number }[] = [];
    const walk = (n: Node) => {
      if (n.kids) for (const k of n.kids) walk(k);
      else out.push({ leaf: leafOf(n), members: n.members.size });
    };
    walk(this.root);
    return out;
  }

  /**
   * The answer to a member's report: its leaf; `peers`, the `NEAR_MAX` nearest others within its
   * query radius that pass `linkTiers` with it, nearest first, with the ms since each reported;
   * `swarm`, the `SWARM_MAX` nearest others too small to link within its AoI, as points, across
   * the whole world. Both keep to the members that share water with it by `instanceOf` (M12 T5:
   * everyone is in the open water without one), and each peer carries its instance. Positions go
   * out in 1/8 wu steps, and the farthest entries are dropped until the message fits
   * `NEAR_MAX_BYTES`. Null for an unknown id.
   */
  near(
    id: string,
    now: number,
    instanceOf: (id: string) => number = () => OPEN_WATER,
  ): { leaf: Leaf; peers: NearPeer[]; swarm: [number, number][] } | null {
    const held = this.byId.get(id);
    if (!held) return null;
    const self = held.m;
    const own = instanceOf(id);
    const q = queryRadius(self.aoi);
    const peers: { d: number; m: DirMember }[] = [];
    const swarm: { d: number; m: DirMember }[] = [];
    this.visit(self.x, self.y, q, (other, m) => {
      if (other === id) return;
      const d = Math.hypot(m.x - self.x, m.y - self.y);
      if (d > q || !sameWater(own, instanceOf(other))) return;
      if (linkTiers(self.r, m.r)) peers.push({ d, m });
      else if (m.r < self.r && d <= self.aoi) swarm.push({ d, m });
    });
    const order = (a: { d: number; m: DirMember }, b: { d: number; m: DirMember }) =>
      a.d - b.d || (a.m.id < b.m.id ? -1 : a.m.id > b.m.id ? 1 : 0);
    peers.sort(order);
    swarm.sort(order);
    const near = peers.slice(0, NEAR_MAX).map(({ d, m }) => ({
      d,
      out: {
        id: m.id,
        name: m.name,
        x: wire(m.x),
        y: wire(m.y),
        r: Math.max(1, wire(m.r)),
        age: Math.max(0, Math.round(now - m.t)),
        n: instanceOf(m.id),
      } satisfies NearPeer,
    }));
    const points = swarm
      .slice(0, SWARM_MAX)
      .map(({ d, m }) => ({ d, out: [wire(m.x), wire(m.y)] as [number, number] }));
    const leaf = leafOf(held.leaf);
    trim(leaf, near, points);
    return { leaf, peers: near.map((p) => p.out), swarm: points.map((p) => p.out) };
  }

  // ---- the tree ----

  private holds(n: Node, x: number, y: number): boolean {
    return x >= n.x && y >= n.y && x < n.x + n.size && y < n.y + n.size;
  }

  /** The leaf whose square holds (x, y). */
  private descend(x: number, y: number): Node {
    let n = this.root;
    while (n.kids) n = quadrant(n, n.kids, x, y);
    return n;
  }

  private put(m: DirMember, leaf: Node): void {
    leaf.members.add(m.id);
    this.byId.set(m.id, { m, leaf });
    this.split(leaf);
  }

  private take(id: string, leaf: Node): void {
    leaf.members.delete(id);
    this.byId.delete(id);
    this.merge(leaf.parent);
  }

  /** Splits an over-full leaf in four, and each child that is still over-full. */
  private split(n: Node): void {
    if (n.members.size <= this.leafMax || n.size <= LEAF_MIN_SIZE) return;
    const half = n.size / 2;
    const kid = (dx: number, dy: number): Node => ({
      x: n.x + dx,
      y: n.y + dy,
      size: half,
      parent: n,
      kids: null,
      members: new Set(),
    });
    n.kids = [kid(0, 0), kid(half, 0), kid(0, half), kid(half, half)];
    for (const id of n.members) {
      const held = this.byId.get(id);
      if (!held) continue;
      this.touch(id, n);
      const into = quadrant(n, n.kids, held.m.x, held.m.y);
      into.members.add(id);
      held.leaf = into;
    }
    n.members = new Set();
    for (const k of n.kids) this.split(k);
  }

  /** Merges four sibling leaves that hold fewer than `mergeBelow` together, and so on upwards. */
  private merge(n: Node | null): void {
    while (n?.kids) {
      if (n.kids.some((k) => k.kids)) return;
      const total = n.kids.reduce((sum, k) => sum + k.members.size, 0);
      if (total >= this.mergeBelow) return;
      for (const k of n.kids) {
        for (const id of k.members) {
          const held = this.byId.get(id);
          if (!held) continue;
          this.touch(id, k);
          n.members.add(id);
          held.leaf = n;
        }
      }
      n.kids = null;
      n = n.parent;
    }
  }

  private touch(id: string, before: Node): void {
    if (this.touched && !this.touched.has(id)) this.touched.set(id, leafOf(before));
  }

  /** Runs an operation and reports the subject's leaf and the others whose leaf changed. */
  private tracking(
    id: string,
    run: () => void,
  ): { leaf: Leaf; moved: { id: string; leaf: Leaf }[] } {
    this.touched = new Map();
    try {
      run();
      const moved: { id: string; leaf: Leaf }[] = [];
      for (const [other, before] of this.touched) {
        const now = this.byId.get(other);
        if (other !== id && now && !sameLeaf(before, leafOf(now.leaf))) {
          moved.push({ id: other, leaf: leafOf(now.leaf) });
        }
      }
      const held = this.byId.get(id);
      return { leaf: held ? leafOf(held.leaf) : leafOf(this.root), moved };
    } finally {
      this.touched = null;
    }
  }

  /** Calls `each` for every member of every leaf whose square comes within `radius` of (x, y). */
  private visit(x: number, y: number, radius: number, each: (id: string, m: DirMember) => void) {
    const stack: Node[] = [this.root];
    for (let n = stack.pop(); n; n = stack.pop()) {
      const dx = Math.max(n.x - x, 0, x - (n.x + n.size));
      const dy = Math.max(n.y - y, 0, y - (n.y + n.size));
      if (dx * dx + dy * dy > radius * radius) continue;
      if (n.kids) {
        stack.push(...n.kids);
        continue;
      }
      for (const id of n.members) {
        const held = this.byId.get(id);
        if (held) each(id, held.m);
      }
    }
  }
}

/** The child of `n` whose square holds (x, y). */
function quadrant(n: Node, kids: [Node, Node, Node, Node], x: number, y: number): Node {
  const half = n.size / 2;
  return kids[(x >= n.x + half ? 1 : 0) + (y >= n.y + half ? 2 : 0)] as Node;
}

/** Drops the farthest peers and points until `{ t: 'near', leaf, peers, swarm }` fits `NEAR_MAX_BYTES`. */
function trim(
  leaf: Leaf,
  peers: { d: number; out: NearPeer }[],
  swarm: { d: number; out: [number, number] }[],
): void {
  const json = (v: unknown) => byteLength(JSON.stringify(v));
  const peerBytes = peers.map((p) => json(p.out));
  const swarmBytes = swarm.map((p) => json(p.out));
  // Each entry after a list's first adds a comma.
  const listBytes = (lens: number[]) =>
    lens.reduce((a, b) => a + b, 0) + Math.max(0, lens.length - 1);
  let bytes =
    json({ t: 'near', leaf, peers: [], swarm: [] }) + listBytes(peerBytes) + listBytes(swarmBytes);
  while (bytes > NEAR_MAX_BYTES) {
    const lastPeer = peers.at(-1);
    const lastPoint = swarm.at(-1);
    if (lastPeer && (!lastPoint || lastPeer.d >= lastPoint.d)) {
      peers.pop();
      bytes -= (peerBytes.pop() ?? 0) + (peers.length > 0 ? 1 : 0);
    } else if (lastPoint) {
      swarm.pop();
      bytes -= (swarmBytes.pop() ?? 0) + (swarm.length > 0 ? 1 : 0);
    } else return;
  }
}
