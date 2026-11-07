// Gossip (M11 T9, ADR 0062): linked peers tell each other about their neighbours, so a page learns
// of creatures near it between the directory's answers. Every 4 s each link carries the sender's up
// to 16 linked peers nearest the receiver that the receiver could link with, placed by snapshots
// under 2 s old; the receiver keeps each as a `gossip` sighting for 10 s unless it is told again.
// Each entry carries its creature's instance (M12 T3, ADR 0064): the sender leaves out what the
// receiver can't share water with, and the receiver drops what still comes from other water.
// Pure: the page (T13) and the harness (T10) send what `due` returns and feed `receive`.

import { linkTiers } from '../sim/size';
import type { Known } from './aoi';
import { OPEN_WATER, sameWater } from './instance';
import { GOSSIP_MAX, type PeerEvent, wireCoord, wireRadius } from './protocol-defs';

export const GOSSIP_EVERY_MS = 4000;
export const GOSSIP_TTL_MS = 10_000;
/** Only peers placed by a snapshot this fresh are passed on. */
export const GOSSIP_FRESH_MS = 2000;
/** Sightings kept from one sender, the oldest dropped first: a few rounds' worth. */
const HEARD_PER_SENDER = 3 * GOSSIP_MAX;

export type PeersEvent = Extract<PeerEvent, { t: 'peers' }>;

/** Where a peer was placed (its centre and radius, wu) and when (ms). */
export type Fix = Omit<Known, 'id' | 'source'>;

/**
 * The gossip for `to`: up to 16 of `fixes` (this page's linked peers, by their newest snapshots)
 * nearest `to`'s own newest snapshot, placed under 2 s ago, passing `linkTiers` with it and sharing
 * its water, `to` itself left out; positions rounded to whole wu, each with its instance (none is
 * the open water). Null when `to` has no snapshot or none qualify.
 */
export function gossipFor(
  to: string,
  fixes: ReadonlyMap<string, Fix>,
  now: number,
): PeersEvent | null {
  const at = fixes.get(to);
  if (!at) return null;
  const near: [d: number, entry: PeersEvent['list'][number]][] = [];
  const water = at.n ?? OPEN_WATER;
  for (const [id, f] of fixes) {
    if (id === to || now - f.at > GOSSIP_FRESH_MS || !linkTiers(at.r, f.r)) continue;
    const n = f.n ?? OPEN_WATER;
    if (!sameWater(water, n)) continue;
    near.push([Math.hypot(f.x - at.x, f.y - at.y), [id, coord(f.x), coord(f.y), radius(f.r), n]]);
  }
  if (near.length === 0) return null;
  near.sort((a, b) => a[0] - b[0]);
  return { t: 'peers', list: near.slice(0, GOSSIP_MAX).map(([, e]) => e) };
}

const coord = (v: number) => wireCoord(Math.round(v));
const radius = (v: number) => wireRadius(Math.round(v));

/** A sighting passed on by a linked peer. */
export interface Heard {
  via: string;
  fix: Fix;
}

export class Gossip {
  /** When each link was last told. */
  private readonly told = new Map<string, number>();
  /** Each sender's sightings by id, oldest first. */
  private readonly bySender = new Map<string, Map<string, Fix>>();

  constructor(private readonly selfId: string) {}

  /**
   * The gossip due now: one `peers` event for each of `linked` not told in the last 4 s (a new link
   * at once), built by `gossipFor` from the fixes of the linked peers. A link with nothing to tell
   * is asked again on the next call.
   */
  due(
    linked: Iterable<string>,
    fixes: ReadonlyMap<string, Fix>,
    now: number,
  ): [to: string, event: PeersEvent][] {
    const held = new Set(linked);
    for (const id of this.told.keys()) if (!held.has(id)) this.told.delete(id);
    if (![...held].some((to) => this.isDue(to, now))) return [];
    const mine = new Map<string, Fix>();
    for (const [id, f] of fixes) if (held.has(id)) mine.set(id, f);
    const out: [string, PeersEvent][] = [];
    for (const to of held) {
      if (!this.isDue(to, now)) continue;
      const event = gossipFor(to, mine, now);
      if (!event) continue;
      this.told.set(to, now);
      out.push([to, event]);
    }
    return out;
  }

  private isDue(to: string, now: number): boolean {
    const last = this.told.get(to);
    return last === undefined || now - last >= GOSSIP_EVERY_MS;
  }

  /**
   * Merges a linked peer's gossip: each entry is a sighting from `via` at `now`, but for one from
   * water this page, in instance `own`, does not share.
   */
  receive(via: string, event: PeersEvent, now: number, own = OPEN_WATER): void {
    let heard = this.bySender.get(via);
    if (!heard) {
      heard = new Map();
      this.bySender.set(via, heard);
    }
    for (const [id, x, y, r, n] of event.list) {
      if (id === this.selfId || id === via || !sameWater(own, n)) continue;
      heard.delete(id);
      heard.set(id, { x, y, r, at: now, n });
    }
    for (const id of heard.keys()) {
      if (heard.size <= HEARD_PER_SENDER) break;
      heard.delete(id);
    }
  }

  /** Forgets a sender's sightings (its link closed). */
  drop(via: string): void {
    this.bySender.delete(via);
    this.told.delete(via);
  }

  /** The linked peers that placed `id` in the last 10 s, with where each placed it. */
  heard(id: string, now: number): Heard[] {
    this.expire(now);
    const out: Heard[] = [];
    for (const [via, heard] of this.bySender) {
      const fix = heard.get(id);
      if (fix) out.push({ via, fix });
    }
    return out;
  }

  /** Every creature gossip placed in the last 10 s, the newest sighting of each. */
  known(now: number): Known[] {
    this.expire(now);
    const newest = new Map<string, Known>();
    for (const heard of this.bySender.values()) {
      for (const [id, f] of heard) {
        const seen = newest.get(id);
        if (!seen || f.at > seen.at) newest.set(id, { id, ...f, source: 'gossip' });
      }
    }
    return [...newest.values()];
  }

  private expire(now: number): void {
    for (const [via, heard] of this.bySender) {
      // Oldest first: `receive` re-inserts a refreshed id at the end, with a later `at`.
      for (const [id, f] of heard) {
        if (now - f.at <= GOSSIP_TTL_MS) break;
        heard.delete(id);
      }
      if (heard.size === 0) this.bySender.delete(via);
    }
  }
}
