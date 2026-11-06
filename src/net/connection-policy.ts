// Which peers to hold connections to: the cap, nearest first, and the priority classes M7 and M11
// will fill in. Duty links (M10, ADR 0058) are priority 0 and may take the total past the cap,
// never past `MAX_CAP`. Pure bookkeeping; the mesh carries out the plan.

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
  /** Peers announced for a witness duty (`duty-peer`), in the roster or not. */
  private readonly dutyIds = new Set<string>();
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

  /** The peer left the roster; a duty peer's link stays until its duty ends. */
  remove(id: string): void {
    this.roster.delete(id);
    if (!this.dutyIds.has(id)) this.heldIds.delete(id);
  }

  /**
   * Announces (or ends) a duty link to `id`. Returns true when the connection should close now:
   * the duty ended for a held peer outside the roster.
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
    const connect: string[] = [];
    const evict: string[] = [];
    const ids = new Set([...this.roster.keys(), ...this.dutyIds]);
    const candidates: [string, Entry][] = [];
    for (const id of ids) {
      const entry = this.entryOf(id);
      if (entry && !this.heldIds.has(id) && this.selfId < id) candidates.push([id, entry]);
    }
    candidates.sort(compare);
    for (const [id] of candidates) {
      const taken = this.take(id);
      if (!taken.accepted) continue;
      if (taken.evict) evict.push(taken.evict);
      connect.push(id);
    }
    return { connect, evict };
  }

  /** Decides on an inbound offer from a peer that this side does not call. */
  admit(id: string): Admission {
    if (this.heldIds.has(id)) return this.entryOf(id) ? { accepted: true } : { accepted: false };
    return this.take(id);
  }

  /**
   * Holds `id` if there is room: a pond peer within the cap, a duty peer within `MAX_CAP`, else in
   * the place of a worse P2 peer.
   */
  private take(id: string): Admission {
    const entry = this.entryOf(id);
    if (!entry) return { accepted: false };
    const duty = this.dutyIds.has(id);
    let pond = 0;
    for (const h of this.heldIds) if (!this.dutyIds.has(h)) pond++;
    const room = duty
      ? this.heldIds.size < MAX_CAP
      : pond < this.cap && this.heldIds.size < MAX_CAP;
    if (room) {
      this.heldIds.add(id);
      return { accepted: true };
    }
    const victim = this.victimFor(entry);
    if (victim === null) return { accepted: false };
    this.heldIds.delete(victim);
    this.heldIds.add(id);
    return { accepted: true, evict: victim };
  }

  /** A roster peer's entry, priority 0 while it is a duty peer; a duty peer outside the roster counts as far. */
  private entryOf(id: string): Entry | null {
    const entry = this.roster.get(id);
    if (!this.dutyIds.has(id)) return entry ?? null;
    return { distance: entry?.distance ?? Number.POSITIVE_INFINITY, priority: 0 };
  }

  /** The worst held P2 peer that `cand` is strictly better than, if any. */
  private victimFor(cand: Entry): string | null {
    let worst: [string, Entry] | null = null;
    for (const id of this.heldIds) {
      const e = this.entryOf(id);
      if (!e || e.priority < 2) continue;
      if (worst === null || compare([id, e], worst) > 0) worst = [id, e];
    }
    return worst !== null && strictlyBetter(cand, worst[1]) ? worst[0] : null;
  }
}
