// When a page tells the directory where its creature is (M11 T8, ADR 0062): a `where` on entering
// the water, on leaving its leaf by more than 64 wu, on a tier change or an AoI change of more
// than a quarter, and otherwise every 30 s; a `gone` once on leaving the water. Never two messages
// within 2 s: a trigger inside that gap waits for it. A crowded page's `where` carries its crowd
// (M12 T3, ADR 0064): at once when it turns crowded, then every 10 s while it stays so. Pure; the
// page (T13) sends what it returns.

import { clamp } from '../sim/math';
import { linkTiers, sizeTier } from '../sim/size';
import { INTERACT_RADII } from './aoi';
import type { Fix } from './gossip';
import { CROWD_EVERY_MS, OPEN_WATER, sameWater } from './instance';
import {
  type ClientMsg,
  CROWD_LIST_MAX,
  type Leaf,
  WIRE_AOI_MAX,
  wireCoord,
  wireRadius,
} from './protocol';

export const WHERE_EVERY_MS = 30_000;
export const WHERE_MIN_GAP_MS = 2000;
/** The centre may stray this far past its leaf before it reports. */
export const LEAF_SLACK_WU = 64;
/** An AoI that changes by more than this share of the last one reported is reported. */
const AOI_CHANGE = 0.25;

/** How far a point lies outside a leaf's square (0 inside). */
function outside(leaf: Leaf, x: number, y: number): number {
  const dx = Math.max(leaf.x - x, 0, x - (leaf.x + leaf.size));
  const dy = Math.max(leaf.y - y, 0, y - (leaf.y + leaf.size));
  return Math.hypot(dx, dy);
}

interface Sent {
  x: number;
  y: number;
  tier: number;
  aoi: number;
  t: number;
}

export interface WhereState {
  inWater: boolean;
  x: number;
  y: number;
  r: number;
  aoi: number;
  now: number;
}

/**
 * A crowded page's crowd list: its linked peers within 8 × the larger radius by their snapshots
 * (`fixes`) that pass `linkTiers` and share its water, nearest first, at most 32. A page with none
 * that close sends its own id alone, which says it is crowded and pairs it with no one.
 */
export function crowdList(
  selfId: string,
  self: { x: number; y: number; r: number; n?: number },
  fixes: ReadonlyMap<string, Fix>,
): string[] {
  const water = self.n ?? OPEN_WATER;
  const near: [d: number, id: string][] = [];
  for (const [id, f] of fixes) {
    if (id === selfId || !linkTiers(self.r, f.r) || !sameWater(water, f.n ?? OPEN_WATER)) continue;
    const d = Math.hypot(f.x - self.x, f.y - self.y);
    if (d <= INTERACT_RADII * Math.max(self.r, f.r)) near.push([d, id]);
  }
  if (near.length === 0) return [selfId];
  near.sort((a, b) => a[0] - b[0]);
  return near.slice(0, CROWD_LIST_MAX).map(([, id]) => id);
}

export class WhereReporter {
  /** The last `where`, while the directory holds this creature. */
  private sent: Sent | null = null;
  /** When the last `where` carrying a crowd went. */
  private crowdAt = Number.NEGATIVE_INFINITY;
  /** When the last message of either kind went. */
  private lastAt = Number.NEGATIVE_INFINITY;
  /** A trigger that fell inside the gap and waits for it. */
  private pending = false;

  /**
   * The message to send now, if any, for this state, the leaf the hub last named and the page's
   * crowd list (null while it isn't crowded). Turning crowded reports at once unless a crowd went
   * in the last 10 s; while crowded, every report carries the list.
   */
  update(
    s: WhereState,
    leaf: Leaf | null,
    crowd: readonly string[] | (() => readonly string[]) | null = null,
  ): ClientMsg | null {
    if (!s.inWater) {
      // Out of the water: the directory should forget it, once (and if it ever heard of it).
      this.pending = this.sent !== null;
      if (!this.pending || s.now - this.lastAt < WHERE_MIN_GAP_MS) return null;
      this.sent = null;
      this.pending = false;
      this.lastAt = s.now;
      return { t: 'gone' };
    }
    const crowdDue = crowd !== null && s.now - this.crowdAt >= CROWD_EVERY_MS;
    if (!this.pending && (crowdDue || this.due(s, leaf))) this.pending = true;
    if (!this.pending || s.now - this.lastAt < WHERE_MIN_GAP_MS) return null;
    this.pending = false;
    this.lastAt = s.now;
    this.sent = { x: s.x, y: s.y, tier: sizeTier(s.r * s.r), aoi: s.aoi, t: s.now };
    const msg: ClientMsg = {
      t: 'where',
      x: wireCoord(s.x),
      y: wireCoord(s.y),
      r: wireRadius(s.r),
      aoi: clamp(s.aoi, 1, WIRE_AOI_MAX),
    };
    const list = typeof crowd === 'function' ? crowd() : crowd;
    if (list !== null && list.length > 0) {
      msg.crowd = list.slice(0, CROWD_LIST_MAX);
      this.crowdAt = s.now;
    }
    return msg;
  }

  /**
   * The page's own instance changed: the directory's peers it holds still carry the water of before
   * (and would count as crowding it), so it asks again, held to the 2 s gap. Nothing while it isn't
   * in the directory.
   */
  refresh(): void {
    if (this.sent !== null) this.pending = true;
  }

  /** Whether this state calls for a `where` since the last one. */
  private due(s: WhereState, leaf: Leaf | null): boolean {
    const last = this.sent;
    // Not in the directory: entering the water, or back in it before a `gone` went.
    if (!last) return true;
    if (s.now - last.t >= WHERE_EVERY_MS) return true;
    if (sizeTier(s.r * s.r) !== last.tier) return true;
    if (Math.abs(s.aoi - last.aoi) > AOI_CHANGE * last.aoi) return true;
    // A leaf that doesn't hold the last report is older than it: wait for the answer's.
    return (
      leaf !== null &&
      outside(leaf, s.x, s.y) > LEAF_SLACK_WU &&
      outside(leaf, last.x, last.y) <= LEAF_SLACK_WU
    );
  }
}
