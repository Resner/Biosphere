// When a page tells the directory where its creature is (M11 T8, ADR 0062): a `where` on entering
// the water, on leaving its leaf by more than 64 wu, on a tier change or an AoI change of more
// than a quarter, and otherwise every 30 s; a `gone` once on leaving the water. Never two messages
// within 2 s: a trigger inside that gap waits for it. Pure; the page (T13) sends what it returns.

import { sizeTier } from '../sim/size';
import { type ClientMsg, type Leaf, WIRE_AOI_MAX, WIRE_POS_MAX, WIRE_RADIUS_MAX } from './protocol';

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

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

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

export class WhereReporter {
  /** The last `where`, while the directory holds this creature. */
  private sent: Sent | null = null;
  /** When the last message of either kind went. */
  private lastAt = Number.NEGATIVE_INFINITY;
  /** A trigger that fell inside the gap and waits for it. */
  private pending = false;

  /** The message to send now, if any, for this state and the leaf the hub last named. */
  update(s: WhereState, leaf: Leaf | null): ClientMsg | null {
    if (!s.inWater) {
      // Out of the water: the directory should forget it, once (and if it ever heard of it).
      this.pending = this.sent !== null;
      if (!this.pending || s.now - this.lastAt < WHERE_MIN_GAP_MS) return null;
      this.sent = null;
      this.pending = false;
      this.lastAt = s.now;
      return { t: 'gone' };
    }
    if (!this.pending && this.due(s, leaf)) this.pending = true;
    if (!this.pending || s.now - this.lastAt < WHERE_MIN_GAP_MS) return null;
    this.pending = false;
    this.lastAt = s.now;
    this.sent = { x: s.x, y: s.y, tier: sizeTier(s.r * s.r), aoi: s.aoi, t: s.now };
    return {
      t: 'where',
      x: clamp(s.x, 0, WIRE_POS_MAX - 1),
      y: clamp(s.y, 0, WIRE_POS_MAX - 1),
      r: clamp(s.r, 1, WIRE_RADIUS_MAX),
      aoi: clamp(s.aoi, 1, WIRE_AOI_MAX),
    };
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
