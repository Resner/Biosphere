// Which peers to hold connections to: the cap, nearest first, and the priority classes M7 and M11
// will fill in. Pure bookkeeping; the mesh carries out the plan.

export const DEFAULT_CAP = 24;
/** Browsers get unreliable beyond this many peer connections (ADR 0007). */
export const MAX_CAP = 32;

/** 0: encounter and witness duty, 1: creatures that can interact, 2: everyone else. */
export type Priority = 0 | 1 | 2;

export interface PeerInfo {
  /** Last known distance in world units; unknown counts as far. */
  distance?: number;
  priority?: Priority;
}

export interface ConnectionPolicyOptions {
  selfId: string;
  cap?: number;
}

export interface ConnectionPlan {
  /** Peers to call now; this side is the lower `playerId`. */
  connect: string[];
  /** Held peers to close to make room. */
  evict: string[];
}

export type Admission = { accepted: false } | { accepted: true; evict?: string };

interface Entry {
  distance: number;
  priority: Priority;
}

/** Lower is better: priority class first, then distance, then id for a stable order. */
function compare(a: [string, Entry], b: [string, Entry]): number {
  const [ida, ea] = a;
  const [idb, eb] = b;
  return (
    ea.priority - eb.priority || ea.distance - eb.distance || (ida < idb ? -1 : ida > idb ? 1 : 0)
  );
}

/** True when `a` is strictly better than `b` (a tie never evicts). */
function strictlyBetter(a: Entry, b: Entry): boolean {
  return a.priority < b.priority || (a.priority === b.priority && a.distance < b.distance);
}

export class ConnectionPolicy {
  readonly cap: number;
  private readonly selfId: string;
  private readonly roster = new Map<string, Entry>();
  /** Connections attempted or open. */
  private readonly heldIds = new Set<string>();

  constructor(opts: ConnectionPolicyOptions) {
    const cap = opts.cap ?? DEFAULT_CAP;
    if (!Number.isInteger(cap) || cap < 1 || cap > MAX_CAP) {
      throw new RangeError(`connection cap must be an integer from 1 to ${MAX_CAP}, got ${cap}`);
    }
    this.cap = cap;
    this.selfId = opts.selfId;
  }

  /** Adds a roster peer or updates its distance and priority. */
  upsert(id: string, info: PeerInfo): void {
    if (id === this.selfId) return;
    const prev = this.roster.get(id);
    this.roster.set(id, {
      distance: info.distance ?? prev?.distance ?? Number.POSITIVE_INFINITY,
      priority: info.priority ?? prev?.priority ?? 2,
    });
  }

  /** The peer left the roster. */
  remove(id: string): void {
    this.roster.delete(id);
    this.heldIds.delete(id);
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
    const connect: string[] = [];
    const evict: string[] = [];
    const candidates = [...this.roster]
      .filter(([id]) => !this.heldIds.has(id) && this.selfId < id)
      .sort(compare);
    for (const cand of candidates) {
      if (this.heldIds.size >= this.cap) {
        const victim = this.victimFor(cand[1]);
        if (victim === null) continue;
        this.heldIds.delete(victim);
        evict.push(victim);
      }
      this.heldIds.add(cand[0]);
      connect.push(cand[0]);
    }
    return { connect, evict };
  }

  /** Decides on an inbound offer from a peer that this side does not call. */
  admit(id: string): Admission {
    const entry = this.roster.get(id);
    if (!entry) return { accepted: false };
    if (this.heldIds.has(id)) return { accepted: true };
    if (this.heldIds.size < this.cap) {
      this.heldIds.add(id);
      return { accepted: true };
    }
    const victim = this.victimFor(entry);
    if (victim === null) return { accepted: false };
    this.heldIds.delete(victim);
    this.heldIds.add(id);
    return { accepted: true, evict: victim };
  }

  /** The worst held P2 peer that `cand` is strictly better than, if any. */
  private victimFor(cand: Entry): string | null {
    let worst: [string, Entry] | null = null;
    for (const id of this.heldIds) {
      const e = this.roster.get(id);
      if (!e || e.priority < 2) continue;
      if (worst === null || compare([id, e], worst) > 0) worst = [id, e];
    }
    return worst !== null && strictlyBetter(cand, worst[1]) ? worst[0] : null;
  }
}
