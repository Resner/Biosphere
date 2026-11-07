// Crowd instances (M12 T3, ADR 0064): the authority splits a crowded area into instances of at most
// `INSTANCE_MAX`, keeps membership sticky, never separates creatures that interact, never moves a
// locked creature, and merges a crowd back into the open water once it is quiet. Pure: no Hub and
// no wire, so the hub (T5), the harness (T8) and the wave (T9) run the same rules.

import { INTERACT_HOLD_WU, INTERACT_LEAD_WU, INTERACT_RADII } from '../src/net/aoi';
import { INSTANCE_MAX, OPEN_WATER } from '../src/net/instance';
import { INSTANCE_WIRE_MAX, WIRE_RADIUS_MAX } from '../src/net/protocol';
import { linkTiers, TIER_LINK_MARGIN } from '../src/sim/size';

/** A crowd forms, or re-bins, this long after the crowded report that asks for it. */
export const SPLIT_WAIT_MS = 3000;
/** A crowd adds an instance at most this often. */
export const RESPLIT_GAP_MS = 10_000;
/** A crowd quiet this long merges into the open water (fixture `QUIET_MS`, at least 500). */
export const QUIET_MS = 30_000;
/** A crowd list pairs its sender with the creatures it names for this long. */
export const CROWD_LIST_TTL_MS = 10_000;

/** A member as the directory last placed it: its centre and radius (wu). */
export interface CrowdMember {
  id: string;
  x: number;
  y: number;
  r: number;
}

/** A member whose instance changed, and its new one. */
export interface Moved {
  id: string;
  n: number;
}

/** What the hub knows that a crowd needs. */
export interface CrowdContext {
  /** In a fight, or a lock waiting for its answer. */
  locked(id: string): boolean;
  /** Its fight's other fighters, its court partner. */
  partners(id: string): readonly string[];
  /** The directory's members within `radius` of (x, y). */
  around(x: number, y: number, radius: number): CrowdMember[];
}

/** P1 reach between two radii: 8 × the larger + 600 wu. */
const p1Reach = (a: number, b: number): number =>
  INTERACT_RADII * Math.max(a, b) + INTERACT_LEAD_WU;
/** A member this far from every other member of its crowd leaves it: twice the P1 hold. */
const strayAt = (a: number, b: number): number =>
  2 * (INTERACT_RADII * Math.max(a, b) + INTERACT_HOLD_WU);
/** The P1 reach to the largest creature `linkTiers` lets a creature of radius `r` link with. */
const reachBound = (r: number): number =>
  p1Reach(r, Math.min(WIRE_RADIUS_MAX, 16 * TIER_LINK_MARGIN ** 2 * r));
const dist = (a: CrowdMember, b: CrowdMember): number => Math.hypot(a.x - b.x, a.y - b.y);
const inReach = (a: CrowdMember, b: CrowdMember): boolean =>
  linkTiers(a.r, b.r) && dist(a, b) <= p1Reach(a.r, b.r);
const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface Crowd {
  id: number;
  /** Its instance numbers, ascending; empty ones are kept until the crowd ends. */
  instances: number[];
  members: Set<string>;
  /** Since when it has had at most `instanceMax` members, no list and no locked member. */
  quietSince: number;
  /** When it last split or asked for more room (`RESPLIT_GAP_MS`). */
  splitAt: number;
  /** When an asked-for re-bin falls due. */
  rebinAt: number | null;
}

interface Entry {
  m: CrowdMember;
  crowd: Crowd | null;
  n: number;
}

/** An instance being filled: its number (null until it gets one), its count, and whether a unit
 * past `instanceMax` holds it alone. */
interface Slot {
  n: number | null;
  count: number;
  closed: boolean;
}

export class Crowds {
  private readonly max: number;
  private readonly quietMs: number;
  private readonly entries = new Map<string, Entry>();
  /** Each sender's last crowd list, the sender left out. */
  private readonly lists = new Map<string, { ids: readonly string[]; t: number }>();
  /** Crowds asked for by a crowded report from the open water: the reporter and when it falls due. */
  private readonly forming = new Map<string, number>();
  private readonly crowds = new Map<number, Crowd>();
  /** Instance numbers a live crowd holds. */
  private readonly used = new Set<number>();
  private nextN = 1;
  private nextCrowd = 1;

  constructor(opts: { instanceMax?: number; quietMs?: number } = {}) {
    this.max = opts.instanceMax ?? INSTANCE_MAX;
    this.quietMs = opts.quietMs ?? QUIET_MS;
  }

  /** A member's instance: 0 (the open water) unless a crowd holds it. */
  instanceOf(id: string): number {
    return this.entries.get(id)?.n ?? OPEN_WATER;
  }

  /** The id of the crowd that holds a member, 0 for none (what an attachment keeps). */
  crowdOf(id: string): number {
    return this.entries.get(id)?.crowd?.id ?? 0;
  }

  /**
   * A member's report, with its page's crowd list while it is crowded (a list of the sender alone
   * says it is crowded and names no one). A member inside a crowd leaves it when it has strayed, or
   * asks for more room; one in the open water joins a crowd whose member it is within P1 reach of,
   * or, crowded, asks for a crowd of its own.
   */
  report(m: CrowdMember, crowd: readonly string[] | null, now: number, ctx: CrowdContext): Moved[] {
    const moved: Moved[] = [];
    let e = this.entries.get(m.id);
    if (e === undefined) {
      e = { m, crowd: null, n: OPEN_WATER };
      this.entries.set(m.id, e);
    } else e.m = m;
    if (crowd !== null) this.lists.set(m.id, { ids: crowd.filter((id) => id !== m.id), t: now });
    const locked = ctx.locked(m.id);
    const c = e.crowd;
    if (c !== null) {
      if (crowd !== null) c.quietSince = now;
      if (locked || !this.strayed(e)) {
        if (crowd !== null && c.rebinAt === null && now - c.splitAt >= RESPLIT_GAP_MS) {
          c.rebinAt = now + SPLIT_WAIT_MS;
          c.splitAt = now;
        }
        return moved;
      }
      this.leave(e, now, moved);
      this.strays(c, now, ctx, moved);
    }
    const near = this.nearestCrowd(e);
    if (near !== null) {
      if (!locked) this.join(e, near, now, ctx, moved);
    } else if (crowd !== null && !this.forming.has(m.id)) {
      this.forming.set(m.id, now + SPLIT_WAIT_MS);
    }
    return moved;
  }

  /** When the next split, re-bin or merge falls due, or null. */
  due(): number | null {
    let at = Number.POSITIVE_INFINITY;
    for (const t of this.forming.values()) at = Math.min(at, t);
    for (const c of this.crowds.values()) {
      at = Math.min(at, c.rebinAt ?? at, c.quietSince + this.quietMs);
    }
    return at === Number.POSITIVE_INFINITY ? null : at;
  }

  /** Forms, re-bins and merges whatever is due by `now`. */
  settle(now: number, ctx: CrowdContext): Moved[] {
    const moved: Moved[] = [];
    this.expireLists(now);
    const due = [...this.forming].filter(([, t]) => t <= now);
    due.sort((a, b) => a[1] - b[1] || byId(a[0], b[0]));
    for (const [id] of due) {
      this.forming.delete(id);
      const e = this.entries.get(id);
      if (e === undefined || e.crowd !== null) continue;
      const near = this.nearestCrowd(e);
      if (near === null) this.form(e, now, ctx, moved);
      else if (!ctx.locked(id)) this.join(e, near, now, ctx, moved);
    }
    for (const c of [...this.crowds.values()]) {
      if (c.rebinAt !== null && c.rebinAt <= now) {
        c.rebinAt = null;
        this.rebin(c, now, ctx, moved);
      }
    }
    for (const c of [...this.crowds.values()]) {
      if (c.members.size > this.max || [...c.members].some((id) => ctx.locked(id))) {
        c.quietSince = now;
      } else if (now - c.quietSince >= this.quietMs) {
        for (const id of [...c.members].sort(byId)) {
          this.leave(this.entries.get(id) as Entry, now, moved);
        }
      }
    }
    return moved;
  }

  /** A member leaves the water (or the directory): its crowd forgets it, and any member that
   * strayed with it gone leaves too. */
  remove(id: string, now: number, ctx: CrowdContext): Moved[] {
    const moved: Moved[] = [];
    const e = this.entries.get(id);
    this.lists.delete(id);
    this.forming.delete(id);
    if (e === undefined) return moved;
    const c = e.crowd;
    this.leave(e, now, []);
    this.entries.delete(id);
    if (c !== null) this.strays(c, now, ctx, moved);
    return moved;
  }

  /** Rebuilds the crowds from each member's (crowd, instance) pair after a wake; quiet starts again. */
  restore(members: readonly { m: CrowdMember; crowd: number; n: number }[], now: number): void {
    for (const { m, crowd, n } of members) {
      if (crowd <= 0 || n === OPEN_WATER) {
        this.entries.set(m.id, { m, crowd: null, n: OPEN_WATER });
        continue;
      }
      let c = this.crowds.get(crowd);
      if (c === undefined) {
        c = {
          id: crowd,
          instances: [],
          members: new Set(),
          quietSince: now,
          splitAt: now,
          rebinAt: null,
        };
        this.crowds.set(crowd, c);
        this.nextCrowd = Math.max(this.nextCrowd, crowd + 1);
      }
      if (!c.instances.includes(n)) {
        c.instances.push(n);
        c.instances.sort((a, b) => a - b);
        this.used.add(n);
      }
      c.members.add(m.id);
      this.entries.set(m.id, { m, crowd: c, n });
      if (c.members.size > this.max) c.quietSince = now;
    }
  }

  /** Each crowd and the members of each of its instances, by id and number. */
  view(): { id: number; instances: { n: number; members: number }[] }[] {
    return [...this.crowds.values()]
      .sort((a, b) => a.id - b.id)
      .map((c) => {
        const counts = this.counts(c);
        return {
          id: c.id,
          instances: c.instances.map((n) => ({ n, members: counts.get(n) ?? 0 })),
        };
      });
  }

  /** Whether a crowd's member lies further than twice the P1 hold from every other member. */
  private strayed(e: Entry): boolean {
    for (const id of (e.crowd as Crowd).members) {
      if (id === e.m.id) continue;
      const o = (this.entries.get(id) as Entry).m;
      if (dist(e.m, o) <= strayAt(e.m.r, o.r)) return false;
    }
    return true;
  }

  /** The members of `c` that strayed, unlocked, leave it (a member left or went). */
  private strays(c: Crowd, now: number, ctx: CrowdContext, moved: Moved[]): void {
    for (const id of [...c.members].sort(byId)) {
      const e = this.entries.get(id) as Entry;
      if (e.crowd === c && !ctx.locked(id) && this.strayed(e)) this.leave(e, now, moved);
    }
  }

  /** The crowd of the nearest crowd member within P1 reach of `e`, or null. */
  private nearestCrowd(e: Entry): Crowd | null {
    let best: Crowd | null = null;
    let bestD = Number.POSITIVE_INFINITY;
    for (const c of this.crowds.values()) {
      for (const id of c.members) {
        const o = (this.entries.get(id) as Entry).m;
        const d = dist(e.m, o);
        if (d < bestD && inReach(e.m, o)) {
          best = c;
          bestD = d;
        }
      }
    }
    return best;
  }

  /** Joins `c`: its partner's instance there, else the one holding most of its list pairs when it
   * has room, else the least-full. */
  private join(e: Entry, c: Crowd, now: number, ctx: CrowdContext, moved: Moved[]): void {
    const counts = this.counts(c);
    let n: number | null = null;
    for (const p of ctx.partners(e.m.id)) {
      const pe = this.entries.get(p);
      if (pe?.crowd === c) {
        n = pe.n;
        break;
      }
    }
    if (n === null) {
      // Its list pairs, from either side as units count them: the creatures its own list names,
      // and the members whose lists name it.
      const held = new Map<number, number>();
      const count = (o: Entry | undefined) => {
        if (o?.crowd === c) held.set(o.n, (held.get(o.n) ?? 0) + 1);
      };
      const own = this.lists.get(e.m.id);
      if (own !== undefined && now - own.t <= CROWD_LIST_TTL_MS) {
        for (const id of own.ids) count(this.entries.get(id));
      }
      for (const id of c.members) {
        const list = this.lists.get(id);
        if (list !== undefined && now - list.t <= CROWD_LIST_TTL_MS && list.ids.includes(e.m.id)) {
          count(this.entries.get(id));
        }
      }
      let most = 0;
      for (const [i, k] of [...held].sort((a, b) => a[0] - b[0])) {
        if (k > most) {
          most = k;
          n = i;
        }
      }
      if (n !== null && (counts.get(n) ?? 0) >= this.max) n = null;
    }
    n ??= this.leastFull(c, counts);
    this.enter(e, c, n, now, moved);
  }

  /** A crowd of the reporter and the unlocked open-water members in its P1 reach, if two or more. */
  private form(e: Entry, now: number, ctx: CrowdContext, moved: Moved[]): void {
    const pool: string[] = ctx.locked(e.m.id) ? [] : [e.m.id];
    for (const a of ctx.around(e.m.x, e.m.y, reachBound(e.m.r))) {
      if (a.id === e.m.id || !inReach(e.m, a) || ctx.locked(a.id)) continue;
      let o = this.entries.get(a.id);
      if (o === undefined) {
        o = { m: a, crowd: null, n: OPEN_WATER };
        this.entries.set(a.id, o);
      }
      if (o.crowd === null) pool.push(a.id);
    }
    if (pool.length < 2) return;
    const slots: Slot[] = [];
    const want = Math.max(2, Math.ceil(pool.length / this.max));
    for (let i = 0; i < want; i++) slots.push({ n: null, count: 0, closed: false });
    const placed = this.fill(this.units(pool, now, ctx), slots);
    if (!this.number(slots)) return;
    const c: Crowd = {
      id: this.nextCrowd++,
      instances: [],
      members: new Set(),
      quietSince: now,
      splitAt: now,
      rebinAt: null,
    };
    for (const s of slots) if (s.n !== null) c.instances.push(s.n);
    this.crowds.set(c.id, c);
    for (const [unit, slot] of placed) {
      for (const id of unit)
        this.enter(this.entries.get(id) as Entry, c, slot.n as number, now, moved);
    }
  }

  /**
   * More room: a unit stays in its instance while that instance holds at most `instanceMax` (the
   * largest first, a unit with a locked member always), and the overflow goes to the least-full
   * instance with room, a new one first, else another new one.
   */
  private rebin(c: Crowd, now: number, ctx: CrowdContext, moved: Moved[]): void {
    const slots = new Map<number, Slot>(
      c.instances.map((n) => [n, { n, count: 0, closed: false }]),
    );
    const units = this.units([...c.members], now, ctx);
    const homes = new Map<string[], number>();
    const pinned = (u: string[]) => u.some((id) => ctx.locked(id));
    for (const u of units) {
      const lock = u.find((id) => ctx.locked(id));
      if (lock !== undefined) homes.set(u, this.instanceOf(lock));
      else {
        const held = new Map<number, number>();
        for (const id of u) held.set(this.instanceOf(id), (held.get(this.instanceOf(id)) ?? 0) + 1);
        const [home] = [...held].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0] as [number, number];
        homes.set(u, home);
      }
    }
    const stay = new Map<string[], Slot>();
    const over: string[][] = [];
    for (const u of units.filter(pinned)) {
      const s = slots.get(homes.get(u) as number) as Slot;
      s.count += u.length;
      stay.set(u, s);
    }
    for (const u of units.filter((u) => !pinned(u))) {
      const s = slots.get(homes.get(u) as number) as Slot;
      const fits =
        u.length > this.max ? s.count === 0 && !s.closed : s.count + u.length <= this.max;
      if (!fits) {
        over.push(u);
        continue;
      }
      s.count += u.length;
      if (u.length > this.max) s.closed = true;
      stay.set(u, s);
    }
    const all = [{ n: null, count: 0, closed: false } as Slot, ...slots.values()];
    const placed = new Map([...stay, ...this.fill(over, all)]);
    if (!this.number(all)) return;
    for (const s of all) {
      if (s.n !== null && !c.instances.includes(s.n)) c.instances.push(s.n);
    }
    c.instances.sort((a, b) => a - b);
    for (const [unit, slot] of placed) {
      for (const id of unit) {
        const e = this.entries.get(id) as Entry;
        if (!ctx.locked(id) && e.n !== slot.n) this.enter(e, c, slot.n as number, now, moved);
      }
    }
  }

  /**
   * Puts each unit whole into the least-full open slot with room, the largest unit first (`units`
   * comes so), adding a slot when none has room; a unit past `instanceMax` takes an empty slot to
   * itself. Slots keep their order, so the first of the least-full wins a tie.
   */
  private fill(units: readonly string[][], slots: Slot[]): Map<string[], Slot> {
    const placed = new Map<string[], Slot>();
    for (const u of units) {
      let slot: Slot | null = null;
      for (const s of slots) {
        if (s.closed) continue;
        const ok = u.length > this.max ? s.count === 0 : s.count + u.length <= this.max;
        if (ok && (slot === null || s.count < slot.count)) slot = s;
      }
      if (slot === null) {
        slot = { n: null, count: 0, closed: false };
        slots.push(slot);
      }
      slot.count += u.length;
      if (u.length > this.max) slot.closed = true;
      placed.set(u, slot);
    }
    return placed;
  }

  /** Gives every filled slot without a number a fresh one; false (and none taken) if they ran out. */
  private number(slots: Slot[]): boolean {
    const fresh = slots.filter((s) => s.n === null && s.count > 0);
    const taken: number[] = [];
    for (const s of fresh) {
      const n = this.take();
      if (n === null) {
        for (const t of taken) this.used.delete(t);
        for (const f of fresh) f.n = null;
        return false;
      }
      taken.push(n);
      s.n = n;
    }
    return true;
  }

  /** The next instance number no live crowd holds, going round from the last one given. */
  private take(): number | null {
    for (let i = 0; i < INSTANCE_WIRE_MAX; i++) {
      const n = ((this.nextN - 1 + i) % INSTANCE_WIRE_MAX) + 1;
      if (!this.used.has(n)) {
        this.used.add(n);
        this.nextN = (n % INSTANCE_WIRE_MAX) + 1;
        return n;
      }
    }
    return null;
  }

  /**
   * The units among `ids`: a member with its partners, and every pair a crowd list under 10 s old
   * names (from either side), joined into chains. The largest first, then by the lowest id.
   */
  private units(ids: readonly string[], now: number, ctx: CrowdContext): string[][] {
    const index = new Map(ids.map((id, i) => [id, i]));
    const parent = ids.map((_, i) => i);
    const find = (i: number): number => {
      let at = i;
      while (parent[at] !== at) {
        const up = parent[parent[at] as number] as number;
        parent[at] = up;
        at = up;
      }
      return at;
    };
    const union = (a: number, b: number | undefined) => {
      if (b !== undefined) parent[find(a)] = find(b);
    };
    ids.forEach((id, i) => {
      for (const p of ctx.partners(id)) union(i, index.get(p));
      const list = this.lists.get(id);
      if (list !== undefined && now - list.t <= CROWD_LIST_TTL_MS) {
        for (const o of list.ids) union(i, index.get(o));
      }
    });
    const sets = new Map<number, string[]>();
    ids.forEach((id, i) => {
      const root = find(i);
      const set = sets.get(root);
      if (set === undefined) sets.set(root, [id]);
      else set.push(id);
    });
    const out = [...sets.values()].map((u) => u.sort(byId));
    return out.sort((a, b) => b.length - a.length || byId(a[0] as string, b[0] as string));
  }

  /** Each instance's members in `c`. */
  private counts(c: Crowd): Map<number, number> {
    const counts = new Map<number, number>(c.instances.map((n) => [n, 0]));
    for (const id of c.members) {
      const n = (this.entries.get(id) as Entry).n;
      counts.set(n, (counts.get(n) ?? 0) + 1);
    }
    return counts;
  }

  /** The instance of `c` with the fewest members, the lowest number of a tie. */
  private leastFull(c: Crowd, counts: ReadonlyMap<number, number>): number {
    let best = c.instances[0] as number;
    for (const n of c.instances) if ((counts.get(n) ?? 0) < (counts.get(best) ?? 0)) best = n;
    return best;
  }

  /** Puts `e` in instance `n` of `c`. */
  private enter(e: Entry, c: Crowd, n: number, now: number, moved: Moved[]): void {
    const before = c.members.size;
    c.members.add(e.m.id);
    if (before <= this.max && c.members.size > this.max) c.quietSince = now;
    e.crowd = c;
    if (e.n !== n) {
      e.n = n;
      moved.push({ id: e.m.id, n });
    }
  }

  /** Takes `e` back to the open water; its crowd ends once empty. */
  private leave(e: Entry, now: number, moved: Moved[]): void {
    const c = e.crowd;
    if (c === null) return;
    const before = c.members.size;
    c.members.delete(e.m.id);
    if (before > this.max && c.members.size <= this.max) c.quietSince = now;
    e.crowd = null;
    if (e.n !== OPEN_WATER) {
      e.n = OPEN_WATER;
      moved.push({ id: e.m.id, n: OPEN_WATER });
    }
    if (c.members.size === 0) {
      this.crowds.delete(c.id);
      for (const n of c.instances) this.used.delete(n);
    }
  }

  private expireLists(now: number): void {
    for (const [id, list] of this.lists) {
      if (now - list.t > CROWD_LIST_TTL_MS) this.lists.delete(id);
    }
  }
}
