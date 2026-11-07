// The area-of-interest manager (M11 T8, ADR 0062): which known creatures a page wants linked, in
// five classes, and the links to open and close under the cap. Pure: positions come in from
// snapshots, gossip, the directory and signals; the page (T13) and the harness (T10) act on it.

import { linkTiers, viewHalfHeight } from '../sim/size';
import {
  type ConnectionPlan,
  checkCap,
  DEFAULT_CAP,
  type LinkCandidate,
  type LinkClass,
  NO_CLASS,
  selectLinks,
} from './connection-policy';

export type { LinkClass } from './connection-policy';

/** The AoI radius per view half-height: 1.3 × the half-diagonal of a 16:9 view. */
export const AOI_PER_HALF_HEIGHT = 2.65;
/** P1 reaches this many times the larger radius: the engage candidates' `CANDIDATE_RADII`. */
export const INTERACT_RADII = 8;
/** P1's lead past the interaction distance: about 3 s of two creatures closing at 100 wu/s. */
export const INTERACT_LEAD_WU = 600;
/** A P1 stays P1 until this far past the interaction distance. */
export const INTERACT_HOLD_WU = 900;
/** A held peer with no class closes after this long. */
export const UNWANTED_GRACE_MS = 3000;
/** P4 is ordered by the distance from where the player will be this many seconds on. */
export const AHEAD_S = 3;
/** A report's query radius, and P4's reach, is at least this (about the old pond's reach). */
export const NEAR_FLOOR_WU = 8192;
/** P2 and P4 are held to this multiple of their reach, P3 to twice it (2.2 × the AoI). */
const HOLD = 1.1;

/** A creature's AoI radius in wu: `AOI_PER_HALF_HEIGHT` × its view's half-height. */
export function aoiRadius(r: number, adultR: number): number {
  return AOI_PER_HALF_HEIGHT * viewHalfHeight(r, adultR);
}

/** A report's query radius `Q` for this AoI, also P4's reach. */
export function queryRadius(aoi: number): number {
  return Math.max(NEAR_FLOOR_WU, 4 * aoi);
}

/** A creature the page knows of, as one source last placed it (`at`, ms). */
export interface Known {
  id: string;
  x: number;
  y: number;
  r: number;
  at: number;
  source: 'snapshot' | 'gossip' | 'directory' | 'signal';
}

/** The player's own creature: its centre, velocity (wu/s), radius and adult radius. */
export interface AoiSelf {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  adultR: number;
}

export type AoiPlan = ConnectionPlan;

export class AoiManager {
  private readonly selfId: string;
  private readonly cap: number;
  /** Each known creature's order within its class from the last `classify` (wu). */
  private rank = new Map<string, number>();
  /** When each held peer with no class was first seen so. */
  private readonly unwantedSince = new Map<string, number>();

  constructor(opts: { selfId: string; cap?: number }) {
    this.selfId = opts.selfId;
    this.cap = checkCap(opts.cap ?? DEFAULT_CAP);
  }

  /**
   * Each known creature's class, the first that holds: P0 the ids in `p0`; P1 within 8 × the
   * larger radius + 600 wu (held to + 900); P2 within the AoI (held to 1.1 ×); P3 within 2 × the
   * AoI (2.2 ×); P4 within `Q` (1.1 ×). A hold applies to a creature whose class in `prev` was that
   * one or better. Every class but P0 needs `linkTiers`; a creature with none is left out.
   */
  classify(
    self: AoiSelf,
    known: Iterable<Known>,
    p0: ReadonlySet<string>,
    prev: ReadonlyMap<string, LinkClass>,
  ): Map<string, LinkClass> {
    const newest = new Map<string, Known>();
    for (const k of known) {
      if (k.id === this.selfId) continue;
      const seen = newest.get(k.id);
      if (!seen || k.at > seen.at) newest.set(k.id, k);
    }
    const aoi = aoiRadius(self.r, self.adultR);
    const q = queryRadius(aoi);
    const aheadX = self.x + self.vx * AHEAD_S;
    const aheadY = self.y + self.vy * AHEAD_S;
    const out = new Map<string, LinkClass>();
    const rank = new Map<string, number>();
    for (const id of p0) if (id !== this.selfId) out.set(id, 0);
    for (const [id, k] of newest) {
      const d = Math.hypot(k.x - self.x, k.y - self.y);
      rank.set(id, d);
      if (out.has(id) || !linkTiers(self.r, k.r)) continue;
      const was = prev.get(id) ?? NO_CLASS;
      const within = (c: LinkClass, enter: number, hold: number) =>
        d <= enter || (was <= c && d <= hold);
      const reach = INTERACT_RADII * Math.max(self.r, k.r);
      if (within(1, reach + INTERACT_LEAD_WU, reach + INTERACT_HOLD_WU)) out.set(id, 1);
      else if (within(2, aoi, HOLD * aoi)) out.set(id, 2);
      else if (within(3, 2 * aoi, 2 * HOLD * aoi)) out.set(id, 3);
      else if (within(4, q, HOLD * q)) {
        out.set(id, 4);
        rank.set(id, Math.hypot(k.x - aheadX, k.y - aheadY));
      }
    }
    this.rank = rank;
    return out;
  }

  /** A known creature's order within its class from the last `classify`; unknown is far. */
  rankOf(id: string): number {
    return this.rank.get(id) ?? Number.POSITIVE_INFINITY;
  }

  /**
   * The links to open and close for these classes, given the links `held` now: P0 and P1 always
   * (up to 32, then P0 and the nearest P1, `crowded`), P2–P4 in the room under the cap nearest
   * first, and a held peer with no class only in what room is left, for 3 s.
   */
  plan(classes: ReadonlyMap<string, LinkClass>, held: ReadonlySet<string>, now: number): AoiPlan {
    const cands: LinkCandidate[] = [];
    for (const [id, linkClass] of classes) {
      if (id === this.selfId) continue;
      cands.push({ id, linkClass, distance: this.rankOf(id), held: held.has(id) });
    }
    for (const id of this.unwantedSince.keys()) {
      if (!held.has(id) || classes.has(id)) this.unwantedSince.delete(id);
    }
    for (const id of held) {
      if (classes.has(id)) continue;
      const since = this.unwantedSince.get(id) ?? now;
      this.unwantedSince.set(id, since);
      if (now - since < UNWANTED_GRACE_MS) {
        cands.push({ id, linkClass: null, distance: this.rankOf(id), held: true });
      }
    }
    const { keep, crowded } = selectLinks(cands, this.cap);
    return {
      connect: [...keep].filter((id) => !held.has(id)),
      evict: [...held].filter((id) => !keep.has(id)),
      crowded,
    };
  }
}
