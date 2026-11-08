// The known set (M11 T13, ADR 0062): every creature this page knows of and where, from the
// directory's `near`, linked peers' snapshots, gossip, and the positions signals carry (the hub's
// `at`, a relay's `pos`). `online-links.ts` classifies it; names come from tickets and `near`.
// Each sighting carries the creature's instance (M12 T6): its source's, or the freshest word of it
// (`water`, the page's `CrowdView`) when that is newer; a linked peer's snapshot takes the word.

import type { Known } from '../net/aoi';
import { type Fix, Gossip } from '../net/gossip';
import { OPEN_WATER } from '../net/instance';
import type { Leaf, NearPeer, Pos } from '../net/protocol';
import type { SwarmPoint } from '../render/swarms';
import type { WaterSighting } from './crowd-view';

/** No swarm: before the directory's first answer, and after it forgot this page. */
export const NO_SWARM: readonly SwarmPoint[] = [];

/** A linked peer's newest snapshot places it for this long (a hidden tab stops sending). */
export const SNAPSHOT_TTL_MS = 10_000;
/** A signal's position places its sender for this long. */
export const SIGNAL_TTL_MS = 10_000;

export type KnownSource = Known['source'];
export type KnownCounts = Record<KnownSource, number>;

export class Neighbours {
  readonly gossip: Gossip;
  /** The leaf the directory last named for this page, or null before its first answer. */
  leaf: Leaf | null = null;
  /** The directory's last swarm (M11 T17): players two or more tiers smaller in the AoI, as points. */
  swarm: readonly SwarmPoint[] = NO_SWARM;
  /** The newest snapshot of each linked peer. */
  private readonly fixes = new Map<string, Fix>();
  private directory: Known[] = [];
  private readonly names = new Map<string, string>();
  private readonly signals = new Map<string, Known>();

  constructor(
    private readonly selfId: string,
    /** The freshest word of a creature's instance (M12 T6). */
    private readonly water: (id: string) => WaterSighting | undefined = () => undefined,
  ) {
    this.gossip = new Gossip(selfId);
  }

  /** The directory's answer to a `where`: its peers and its swarm replace the last answer's. */
  near(leaf: Leaf, peers: readonly NearPeer[], swarm: readonly SwarmPoint[], now: number): void {
    this.leaf = leaf;
    this.swarm = swarm;
    this.directory = [];
    for (const p of peers) {
      if (p.id === this.selfId) continue;
      this.names.set(p.id, p.name);
      this.directory.push({
        id: p.id,
        x: p.x,
        y: p.y,
        r: p.r,
        at: now - p.age,
        n: p.n,
        source: 'directory',
      });
    }
  }

  /** A linked peer's snapshot. */
  snapshot(id: string, x: number, y: number, r: number, now: number): void {
    this.fixes.set(id, { x, y, r, at: now });
  }

  /** Where a signal's sender said it was. */
  signal(id: string, pos: Pos, now: number): void {
    if (id === this.selfId) return;
    this.signals.set(id, { id, x: pos[0], y: pos[1], r: pos[2], at: now, source: 'signal' });
  }

  /** A link closed: its snapshots and its gossip no longer count. */
  forget(id: string): void {
    this.fixes.delete(id);
    this.gossip.drop(id);
  }

  /** The directory forgot this page (a new hub session): its answer and leaf are stale. */
  resetDirectory(): void {
    this.directory = [];
    this.leaf = null;
    this.swarm = NO_SWARM;
  }

  /** A linked peer's position by its newest snapshot, or null. */
  fixOf(id: string): Fix | null {
    return this.fixes.get(id) ?? null;
  }

  /** The linked peers' newest snapshots, each with its instance (what gossip and the crowd list pass on). */
  linkedFixes(): ReadonlyMap<string, Fix> {
    const out = new Map<string, Fix>();
    for (const [id, f] of this.fixes) out.set(id, { ...f, n: this.waterOf(id) });
    return out;
  }

  /** Every sighting still fresh: each source's newest of each creature (`classify` takes the newest). */
  known(now: number): Known[] {
    const out: Known[] = [];
    for (const [id, f] of this.fixes) {
      if (now - f.at <= SNAPSHOT_TTL_MS)
        out.push({ id, ...f, n: this.waterOf(id), source: 'snapshot' });
    }
    for (const k of this.gossip.known(now)) out.push(this.withWater(k));
    for (const k of this.directory) out.push(this.withWater(k));
    for (const [id, k] of this.signals) {
      if (now - k.at > SIGNAL_TTL_MS) this.signals.delete(id);
      else out.push(this.withWater(k));
    }
    return out;
  }

  /** A creature's instance by the freshest word of it; the open water with none. */
  private waterOf(id: string): number {
    return this.water(id)?.n ?? OPEN_WATER;
  }

  /** A sighting with the freshest word of its instance, when that is newer than the sighting. */
  private withWater(k: Known): Known {
    const w = this.water(k.id);
    return w && (k.n === undefined || w.at >= k.at) ? { ...k, n: w.n } : k;
  }

  /** How many creatures each source places now. */
  counts(now: number): KnownCounts {
    const counts: KnownCounts = { snapshot: 0, gossip: 0, directory: 0, signal: 0 };
    for (const k of this.known(now)) counts[k.source] += 1;
    return counts;
  }

  /** How old the newest sighting of `id` is, from any source (ms); infinite when none. */
  fixAge(id: string, now: number): number {
    let at = Number.NEGATIVE_INFINITY;
    for (const k of this.known(now)) if (k.id === id && k.at > at) at = k.at;
    return now - at;
  }

  /** Whether anyone is known within `radius` of a point. */
  anyWithin(x: number, y: number, radius: number, now: number): boolean {
    return this.known(now).some((k) => Math.hypot(k.x - x, k.y - y) <= radius);
  }

  /** A name the directory gave. */
  nameOf(id: string): string | undefined {
    return this.names.get(id);
  }
}
