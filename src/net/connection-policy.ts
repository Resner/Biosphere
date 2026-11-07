// Which peers to hold links to (ADR 0062): five link classes under the cap. P0 (fight and duty)
// and P1 (creatures that can interact) are always held, up to `MAX_CAP`; P2–P4 fill only the
// room under the cap (24) that they leave, nearest first within each class. Either side may call.
// Pure bookkeeping: `aoi.ts` decides the classes, and the mesh carries out the plan.

export const DEFAULT_CAP = 24;
/** Browsers get unreliable beyond this many peer connections (ADR 0007). */
export const MAX_CAP = 32;

/** P0 fight and duty, P1 interactable, P2 AoI, P3 boundary, P4 handoff. */
export type LinkClass = 0 | 1 | 2 | 3 | 4;

/** One peer to choose among: `linkClass` null is a held peer no longer wanted, in its grace. */
export interface LinkCandidate {
  id: string;
  linkClass: LinkClass | null;
  /** The order within its class, nearest first; unknown counts as far. */
  distance: number;
  held: boolean;
}

/** The order of "no class": after every class (P0 to P4). */
export const NO_CLASS = 5;
/** Lower is better: class, then distance, then a held peer before a new one, then id. */
const rankOf = (c: LinkCandidate) => c.linkClass ?? NO_CLASS;
function compare(a: LinkCandidate, b: LinkCandidate): number {
  return (
    rankOf(a) - rankOf(b) ||
    a.distance - b.distance ||
    Number(b.held) - Number(a.held) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * The links to hold, best first: P0 then the nearest P1 up to `MAX_CAP` (`crowded` when they
 * are more), then P2–P4 and the peers in their grace while the total stays within `cap`.
 */
export function selectLinks(
  cands: readonly LinkCandidate[],
  cap: number,
): { keep: Set<string>; crowded: boolean } {
  const sorted = [...cands].sort(compare);
  const keep = new Set<string>();
  let protectedCount = 0;
  for (const c of sorted) {
    if (rankOf(c) > 1) break;
    protectedCount++;
    if (keep.size < MAX_CAP) keep.add(c.id);
  }
  for (const c of sorted.slice(protectedCount)) {
    if (keep.size >= cap) break;
    keep.add(c.id);
  }
  return { keep, crowded: protectedCount > MAX_CAP };
}

export function checkCap(cap: number): number {
  if (!Number.isInteger(cap) || cap < 1 || cap > MAX_CAP) {
    throw new RangeError(`connection cap must be an integer from 1 to ${MAX_CAP}, got ${cap}`);
  }
  return cap;
}

export interface PeerInfo {
  /** Last known distance in world units; unknown counts as far. */
  distance?: number;
  linkClass?: LinkClass;
}

export interface ConnectionPolicyOptions {
  selfId: string;
  /** The room for P2–P4 (24); P0 and P1 may take the links to `MAX_CAP`. */
  cap?: number;
}

export interface ConnectionPlan {
  /** Peers to call now; either side may call (perfect negotiation settles glare). */
  connect: string[];
  /** Held peers to close to make room. */
  evict: string[];
  /** P0 and P1 pass `MAX_CAP`: only P0 and the nearest P1 are held. */
  crowded: boolean;
}

export type Admission = { accepted: false } | { accepted: true; evict?: string };

interface Entry {
  distance: number;
  linkClass: LinkClass;
}

export class ConnectionPolicy {
  readonly cap: number;
  private readonly selfId: string;
  private readonly roster = new Map<string, Entry>();
  /** Peers announced for a witness duty (`duty-peer`), in the roster or not: P0. */
  private readonly dutyIds = new Set<string>();
  /** Connections attempted or open. */
  private readonly heldIds = new Set<string>();

  constructor(opts: ConnectionPolicyOptions) {
    this.cap = checkCap(opts.cap ?? DEFAULT_CAP);
    this.selfId = opts.selfId;
  }

  /** Adds a roster peer or updates its distance and class (P2 until told). */
  upsert(id: string, info: PeerInfo): void {
    if (id === this.selfId) return;
    const prev = this.roster.get(id);
    this.roster.set(id, {
      distance: info.distance ?? prev?.distance ?? Number.POSITIVE_INFINITY,
      linkClass: info.linkClass ?? prev?.linkClass ?? 2,
    });
  }

  /** The peer left the roster; a duty peer's link stays until its duty ends. */
  remove(id: string): void {
    this.roster.delete(id);
    if (!this.dutyIds.has(id)) this.heldIds.delete(id);
  }

  /**
   * Announces (or ends) a duty link to `id`, which makes it P0. Returns true when the connection
   * should close now: the duty ended for a held peer outside the roster.
   */
  duty(id: string, on: boolean): boolean {
    if (id === this.selfId) return false;
    if (on) {
      this.dutyIds.add(id);
      return false;
    }
    if (!this.dutyIds.delete(id) || this.roster.has(id) || !this.heldIds.has(id)) return false;
    this.heldIds.delete(id);
    return true;
  }

  isDuty(id: string): boolean {
    return this.dutyIds.has(id);
  }

  /** The connection to a peer closed or was dropped, but the peer is still in the roster. */
  release(id: string): void {
    this.heldIds.delete(id);
  }

  held(): string[] {
    return [...this.heldIds];
  }

  isHeld(id: string): boolean {
    return this.heldIds.has(id);
  }

  /** Decides which connections to open and close, and records them as held. */
  plan(): ConnectionPlan {
    const ids = new Set([...this.roster.keys(), ...this.dutyIds]);
    const { keep, crowded } = selectLinks(this.candidates(ids), this.cap);
    const connect = [...keep].filter((id) => !this.heldIds.has(id));
    const evict = [...this.heldIds].filter((id) => !keep.has(id));
    this.heldIds.clear();
    for (const id of keep) this.heldIds.add(id);
    return { connect, evict, crowded };
  }

  /** Decides on an inbound offer by the caller's class, against the links held now. */
  admit(id: string): Admission {
    if (!this.entryOf(id)) return { accepted: false };
    if (this.heldIds.has(id)) return { accepted: true };
    const before = selectLinks(this.candidates(this.heldIds), this.cap).keep;
    const after = selectLinks(this.candidates([...this.heldIds, id]), this.cap).keep;
    if (!after.has(id)) return { accepted: false };
    const evict = [...before].find((h) => !after.has(h));
    this.heldIds.add(id);
    if (evict === undefined) return { accepted: true };
    this.heldIds.delete(evict);
    return { accepted: true, evict };
  }

  private candidates(ids: Iterable<string>): LinkCandidate[] {
    const out: LinkCandidate[] = [];
    for (const id of ids) {
      const e = this.entryOf(id);
      if (e) out.push({ id, ...e, held: this.heldIds.has(id) });
    }
    return out;
  }

  /** A roster peer's entry, P0 while it is a duty peer; a duty peer outside the roster counts as far. */
  private entryOf(id: string): Entry | null {
    const entry = this.roster.get(id);
    if (!this.dutyIds.has(id)) return entry ?? null;
    return { distance: entry?.distance ?? Number.POSITIVE_INFINITY, linkClass: 0 };
  }
}
