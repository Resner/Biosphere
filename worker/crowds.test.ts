import { describe, expect, it } from 'vitest';
import { INTERACT_HOLD_WU, INTERACT_RADII } from '../src/net/aoi';
import { INSTANCE_MAX, OPEN_WATER, sameWater } from '../src/net/instance';
import { createRng, type Rng, seedFromString } from '../src/sim/prng';
import { heavyTest, speedTest } from '../tests/heavy';
import {
  CROWD_LIST_TTL_MS,
  type CrowdContext,
  type CrowdMember,
  Crowds,
  type Moved,
  QUIET_MS,
  RESPLIT_GAP_MS,
  SPLIT_WAIT_MS,
} from './crowds';

// Crowd instances, pure (M12 T3, ADR 0064): the authority's crowds, driven by reports, crowd lists
// and a hand-moved clock, against a directory of its own.

const C = 131_072;
const R = 20;
const id = (n: number) => `P${String(n).padStart(3, '0')}${'x'.repeat(39)}`;

/** The hub's side, as `Crowds` sees it: the directory's positions, the locks and the partners. */
class Hub implements CrowdContext {
  readonly at = new Map<string, CrowdMember>();
  readonly locks = new Set<string>();
  readonly pairs = new Map<string, string[]>();
  readonly crowds: Crowds;
  readonly heard = new Map<string, number>();

  constructor(opts?: { instanceMax?: number; quietMs?: number }) {
    this.crowds = new Crowds(opts);
  }

  locked = (who: string): boolean => this.locks.has(who);
  partners = (who: string): readonly string[] => this.pairs.get(who) ?? [];
  around = (x: number, y: number, radius: number): CrowdMember[] =>
    [...this.at.values()].filter((m) => Math.hypot(m.x - x, m.y - y) <= radius);

  /** A report at (x, y), with the page's crowd list when it is crowded. */
  report(who: string, x: number, y: number, now: number, crowd: string[] | null = null, r = R) {
    const m = { id: who, x, y, r };
    this.at.set(who, m);
    return this.tell(this.crowds.report(m, crowd, now, this));
  }

  /** A report from where `who` last was. */
  again(who: string, now: number, crowd: string[] | null = null): Moved[] {
    const m = this.pos(who);
    return this.report(who, m.x, m.y, now, crowd, m.r);
  }

  pos(who: string): CrowdMember {
    const m = this.at.get(who);
    if (!m) throw new Error(`no ${who}`);
    return m;
  }

  settle(now: number): Moved[] {
    return this.tell(this.crowds.settle(now, this));
  }

  remove(who: string, now: number): Moved[] {
    this.at.delete(who);
    return this.tell(this.crowds.remove(who, now, this));
  }

  /** Two players paired (a fight's fighters, or a court). */
  pair(a: string, b: string): void {
    this.pairs.set(a, [...this.partners(a), b]);
    this.pairs.set(b, [...this.partners(b), a]);
  }

  n(who: string): number {
    return this.crowds.instanceOf(who);
  }

  /** The members of each instance, by instance. */
  bins(): Map<number, string[]> {
    const out = new Map<number, string[]>();
    for (const who of this.at.keys()) {
      const n = this.n(who);
      if (n === OPEN_WATER) continue;
      out.set(n, [...(out.get(n) ?? []), who]);
    }
    return out;
  }

  private tell(moved: Moved[]): Moved[] {
    for (const m of moved) this.heard.set(m.id, m.n);
    return moved;
  }
}

/** The ids within the page's engage reach (8 × the larger radius) of `who`, nearest first. */
function listOf(hub: Hub, who: string): string[] {
  const me = hub.at.get(who) as CrowdMember;
  return [...hub.at.values()]
    .filter((m) => m.id !== who)
    .map((m) => [Math.hypot(m.x - me.x, m.y - me.y), m] as const)
    .filter(([d, m]) => d <= INTERACT_RADII * Math.max(me.r, m.r))
    .sort((a, b) => a[0] - b[0])
    .slice(0, 32)
    .map(([, m]) => m.id);
}

/** `count` starters scattered in a disc of `radius` around (cx, cy), at least `gap` apart. */
function scatter(
  rng: Rng,
  count: number,
  radius: number,
  gap = 0,
  cx = C,
  cy = C,
): [number, number][] {
  const out: [number, number][] = [];
  while (out.length < count) {
    const a = rng.next() * 2 * Math.PI;
    const d = radius * Math.sqrt(rng.next());
    const p: [number, number] = [cx + d * Math.cos(a), cy + d * Math.sin(a)];
    if (out.every(([x, y]) => Math.hypot(x - p[0], y - p[1]) >= gap)) out.push(p);
  }
  return out;
}

/** A crowd formed of `count` members around the reporter `id(0)` at the centre, at time 0. */
function formed(count: number, opts?: { instanceMax?: number; quietMs?: number; seed?: string }) {
  const hub = new Hub(opts);
  const rng = createRng(seedFromString(opts?.seed ?? 'crowd'));
  hub.report(id(0), C, C, 0);
  scatter(rng, count - 1, 350, 30).forEach(([x, y], i) => hub.report(id(i + 1), x, y, 0));
  hub.report(id(0), C, C, 100, listOf(hub, id(0)));
  hub.settle(100 + SPLIT_WAIT_MS);
  return hub;
}

describe('Crowds: forming', () => {
  it('splits a crowded reporter and the open water in its P1 reach 3 s after the report', () => {
    const hub = new Hub();
    const rng = createRng(seedFromString('forty'));
    hub.report(id(0), C, C, 0);
    scatter(rng, 40, 350, 30).forEach(([x, y], i) => hub.report(id(i + 1), x, y, 0));
    // One far away, and one two tiers up next to the reporter: neither is in the crowd.
    hub.report(id(90), C + 5000, C, 0);
    hub.report(id(91), C + 50, C, 0, null, 400);
    const list = listOf(hub, id(0)).filter((who) => who !== id(91));
    expect(list.length).toBeGreaterThan(0);
    expect(hub.report(id(0), C, C, 1000, list)).toEqual([]);
    expect(hub.crowds.due()).toBe(1000 + SPLIT_WAIT_MS);
    expect(hub.settle(1000 + SPLIT_WAIT_MS - 1)).toEqual([]);
    expect(hub.n(id(0))).toBe(OPEN_WATER);

    const moved = hub.settle(1000 + SPLIT_WAIT_MS);
    expect(moved).toHaveLength(41);
    const bins = hub.bins();
    expect(bins.size).toBe(3);
    for (const members of bins.values()) expect(members.length).toBeLessThanOrEqual(INSTANCE_MAX);
    // The reporter's list is one unit: every creature in it shares its instance.
    for (const who of list) expect(hub.n(who)).toBe(hub.n(id(0)));
    expect(hub.n(id(90))).toBe(OPEN_WATER);
    expect(hub.n(id(91))).toBe(OPEN_WATER);
    for (const [who, n] of hub.heard) expect(hub.n(who)).toBe(n);
    expect(hub.crowds.view()).toEqual([
      {
        id: expect.any(Number),
        instances: [...bins]
          .sort((a, b) => a[0] - b[0])
          .map(([n, m]) => ({ n, members: m.length })),
      },
    ]);
    expect(hub.crowds.crowdOf(id(0))).toBe(hub.crowds.view()[0]?.id);
    expect(hub.crowds.crowdOf(id(90))).toBe(0);
  });

  it('splits into at least two instances, and never forms a crowd of one', () => {
    const hub = new Hub();
    hub.report(id(0), C, C, 0);
    hub.report(id(0), C, C, 0, [id(0)]);
    hub.settle(SPLIT_WAIT_MS);
    expect(hub.crowds.view()).toEqual([]);
    hub.report(id(1), C + 300, C, 4000);
    hub.report(id(2), C - 300, C, 4000);
    hub.report(id(0), C, C, 4000, [id(0)]);
    hub.settle(4000 + SPLIT_WAIT_MS);
    expect(hub.bins().size).toBe(2);
    expect(new Set([hub.n(id(1)), hub.n(id(2))]).size).toBe(2);
  });

  it('a crowded report that reaches a crowd joins it instead of forming another', () => {
    const hub = formed(20);
    expect(hub.crowds.view()).toHaveLength(1);
    hub.report(id(50), C + 600, C, 10_000, [id(1)]);
    expect(hub.n(id(50))).not.toBe(OPEN_WATER);
    hub.settle(20_000);
    expect(hub.crowds.view()).toHaveLength(1);
  });

  it('keeps locked creatures in the open water when it forms', () => {
    const hub = new Hub();
    for (let i = 0; i < 6; i++) hub.report(id(i), C + 60 * i, C, 0);
    hub.locks.add(id(4)).add(id(5));
    hub.pair(id(4), id(5));
    hub.report(id(0), C, C, 0, [id(1)]);
    hub.settle(SPLIT_WAIT_MS);
    expect(hub.n(id(4))).toBe(OPEN_WATER);
    expect(hub.n(id(5))).toBe(OPEN_WATER);
    expect(hub.bins().size).toBe(2);
  });
});

describe('Crowds: units', () => {
  it('a unit larger than an instance keeps one to itself, and the others fill the rest', () => {
    const hub = new Hub();
    // A chain of 20 listed pairs 50 wu apart, and 20 singles more than 160 wu from anyone.
    for (let i = 0; i < 20; i++) hub.report(id(i), C + 50 * (i % 5), C + 50 * Math.floor(i / 5), 0);
    for (let i = 0; i < 20; i++) {
      const a = (2 * Math.PI * i) / 20;
      hub.report(id(100 + i), C + 100 + 600 * Math.cos(a), C + 75 + 600 * Math.sin(a), 0);
    }
    for (let i = 1; i < 20; i++) hub.again(id(i), 0, [id(i - 1)]);
    hub.report(id(0), C, C, 0, [id(1)]);
    hub.settle(SPLIT_WAIT_MS);
    const big = hub.n(id(0));
    const bins = hub.bins();
    expect(bins.get(big)?.sort()).toEqual(Array.from({ length: 20 }, (_, i) => id(i)).sort());
    expect(bins.size).toBe(3);
    for (const [n, members] of bins) if (n !== big) expect(members).toHaveLength(10);
  });

  it('a fight, a court and a chain of listed pairs end up whole in one instance (1,000 crowds)', () => {
    unitsHold(1000, 'quick');
  });

  heavyTest('a fight, a court and a chain of listed pairs end up whole (10,000 crowds)', () => {
    unitsHold(10_000, 'full');
  });
});

/**
 * Random crowds of 2 to 60, with fights (locked pairs), courts and lists: after the split every
 * fight's fighters and court's pair share an instance, and every listed pair (a chain) does.
 */
function unitsHold(runs: number, seed: string): void {
  for (let run = 0; run < runs; run++) {
    const rng = createRng(seedFromString(`${seed}:${run}`));
    const hub = new Hub({ instanceMax: rng.int(1, 16) });
    const count = rng.int(2, 60);
    // Every one within the reporter's P1 reach (760 wu): the reporter at the centre, the rest in 700.
    scatter(rng, count, 700).forEach(([x, y], i) =>
      hub.report(id(i), i === 0 ? C : x, i === 0 ? C : y, 0),
    );
    // The reporter asks first, so its crowd takes everyone; the other lists only make units.
    hub.again(id(0), 0, [id(1)]);
    const pairs: [string, string][] = [[id(0), id(1)]];
    for (let k = rng.int(0, 3); k > 0; k--) {
      const a = id(rng.int(0, count - 1));
      const b = id(rng.int(0, count - 1));
      if (a === b || hub.partners(a).length + hub.partners(b).length > 0) continue;
      if (rng.next() < 0.5) hub.locks.add(a).add(b);
      hub.pair(a, b);
      pairs.push([a, b]);
    }
    // A later list replaces its sender's earlier one, so the reporter sends no other.
    for (let i = 1; i < count; i++) {
      if (rng.next() < 0.4) {
        const list = Array.from({ length: rng.int(1, 3) }, () => id(rng.int(0, count - 1)));
        hub.again(id(i), 100, [...new Set(list)]);
        for (const other of new Set(list)) if (other !== id(i)) pairs.push([id(i), other]);
      }
    }
    hub.settle(100 + SPLIT_WAIT_MS);
    for (const [a, b] of pairs) {
      // A locked creature stays in the open water, which shares water with every instance.
      const locked = hub.locks.has(a) || hub.locks.has(b);
      if (locked ? !sameWater(hub.n(a), hub.n(b)) : hub.n(a) !== hub.n(b)) {
        throw new Error(`run ${run}: ${a} in ${hub.n(a)} and ${b} in ${hub.n(b)}`);
      }
    }
  }
}

describe('Crowds: joining', () => {
  it('an open-water member reporting within P1 reach of a member joins, and further out does not', () => {
    const hub = formed(20, { seed: 'join' });
    const east = [...hub.at.values()].reduce((a, b) => (b.x > a.x ? b : a));
    expect(hub.report(id(60), east.x + 761, east.y, 10_000)).toEqual([]);
    expect(hub.n(id(60))).toBe(OPEN_WATER);
    const moved = hub.report(id(61), east.x + 760, east.y, 10_000);
    expect(moved).toEqual([{ id: id(61), n: hub.n(id(61)) }]);
    expect(hub.n(id(61))).not.toBe(OPEN_WATER);
  });

  it('takes its partner’s instance, else the one holding most of its list with room, else the least-full', () => {
    const hub = formed(32, { seed: 'pick' });
    const bins = [...hub.bins()].sort((a, b) => a[0] - b[0]);
    expect(bins.map(([, m]) => m.length)).toEqual([16, 16]);
    const [[n1, in1], [n2, in2]] = bins as [number, string[]][];

    // A court partner in the first instance, though its list names the second's.
    hub.pair(id(70), in1[0] as string);
    hub.report(id(70), C + 20, C + 20, 10_000, in2.slice(0, 3));
    expect(hub.n(id(70))).toBe(n1);

    // Its list in the second instance, which is full: the least-full (the second, as the first now
    // holds 17).
    hub.report(id(71), C - 20, C - 20, 10_000, in2.slice(0, 3));
    expect(hub.n(id(71))).toBe(n2);

    // Its list in the first instance, which is full now: the least-full is the second (17 vs 17,
    // the lower number).
    hub.report(id(72), C - 20, C + 20, 10_000, in1.slice(0, 3));
    expect(hub.n(id(72))).toBe(n1 < n2 ? n1 : n2);

    // A crowd with room: its list wins over the least-full (the fuller instance, or the higher
    // number of two as full).
    const roomy = formed(12, { seed: 'room' });
    const [[r1, m1], [r2]] = [...roomy.bins()].sort(
      (a, b) => b[1].length - a[1].length || b[0] - a[0],
    ) as [number, string[]][];
    expect(r1).not.toBe(r2);
    roomy.report(id(73), C + 10, C - 10, 10_000, m1.slice(0, 2));
    expect(roomy.n(id(73))).toBe(r1);
  });

  it('a locked creature in the open water never joins, and shares water with its partner inside', () => {
    const hub = formed(20, { seed: 'lockjoin' });
    const inside = id(3);
    hub.locks.add(id(80)).add(inside);
    hub.pair(id(80), inside);
    hub.report(id(80), C + 10, C + 10, 10_000);
    expect(hub.n(id(80))).toBe(OPEN_WATER);
    expect(sameWater(hub.n(id(80)), hub.n(inside))).toBe(true);
  });
});

describe('Crowds: leaving', () => {
  it('a member further than 2 × (8 × r + 900) wu from every other member goes back to 0', () => {
    const hub = formed(20, { seed: 'leave' });
    const others = [...hub.at.values()].filter((m) => m.id !== id(5));
    const far = 2 * (INTERACT_RADII * R + INTERACT_HOLD_WU);
    const east = others.reduce((a, b) => (b.x > a.x ? b : a));
    expect(hub.report(id(5), east.x + far, east.y, 10_000)).toEqual([]);
    expect(hub.n(id(5))).not.toBe(OPEN_WATER);
    // Further than that from every other member: each lies west of the easternmost.
    expect(hub.report(id(5), east.x + far + 1, east.y, 11_000)).toEqual([
      { id: id(5), n: OPEN_WATER },
    ]);
    expect(hub.n(id(5))).toBe(OPEN_WATER);
  });

  it('the last member of a crowd leaves it when the others go, and an empty crowd ends at once', () => {
    const hub = new Hub({ instanceMax: 2 });
    hub.report(id(0), C, C, 0);
    hub.report(id(1), C + 100, C, 0);
    hub.report(id(2), C + 300, C, 0);
    hub.report(id(3), C + 400, C, 0);
    hub.report(id(0), C, C, 0, [id(1)]);
    hub.report(id(2), C + 300, C, 0, [id(3)]);
    hub.settle(SPLIT_WAIT_MS);
    expect(hub.bins().size).toBe(2);
    hub.report(id(3), C + 6400, C, 5000);
    hub.report(id(2), C + 6500, C, 5000);
    expect(hub.n(id(2))).toBe(OPEN_WATER);
    expect(hub.n(id(3))).toBe(OPEN_WATER);
    hub.remove(id(1), 6000);
    expect(hub.n(id(0))).toBe(OPEN_WATER);
    expect(hub.crowds.view()).toEqual([]);
  });
});

describe('Crowds: more room', () => {
  it('a crowded report from inside adds an instance and moves only overflow units; a second within 10 s changes nothing', () => {
    const hub = formed(32, { seed: 'room' });
    const before = new Set([...hub.at.keys()].map((who) => hub.n(who)));
    expect([...hub.bins().values()].map((m) => m.length)).toEqual([16, 16]);
    // Eight more swim in: joins go to the least-full, so both instances are over-full.
    for (let i = 0; i < 8; i++) hub.report(id(40 + i), C + 5 * i, C + 30, 10_000);
    expect([...hub.bins().values()].map((m) => m.length)).toEqual([20, 20]);
    const joined = new Map([...hub.at.keys()].map((who) => [who, hub.n(who)]));

    // A list of the sender alone says it is crowded and pairs no one.
    hub.again(id(1), 20_000, [id(1)]);
    expect(hub.crowds.due()).toBe(20_000 + SPLIT_WAIT_MS);
    expect(hub.settle(20_000 + SPLIT_WAIT_MS - 1)).toEqual([]);
    const moved = hub.settle(20_000 + SPLIT_WAIT_MS);
    const bins = hub.bins();
    expect(bins.size).toBe(3);
    for (const members of bins.values()) expect(members.length).toBeLessThanOrEqual(INSTANCE_MAX);
    const fresh = [...bins.keys()].find((n) => !before.has(n));
    expect(fresh).toBeDefined();
    // Only overflow moved, each into the new instance, and 16 stayed in each old one.
    expect(moved).toHaveLength(8);
    for (const m of moved) expect(m.n).toBe(fresh);
    for (const [who, n] of joined) {
      if (!moved.some((m) => m.id === who)) expect(hub.n(who)).toBe(n);
    }

    // Another within 10 s of the first changes nothing.
    hub.report(id(48), C, C - 30, 24_000);
    expect(hub.bins().get(fresh as number)).toHaveLength(9);
    hub.again(id(2), 20_000 + RESPLIT_GAP_MS - 1, [id(2)]);
    expect(hub.settle(20_000 + RESPLIT_GAP_MS + SPLIT_WAIT_MS)).toEqual([]);
    expect(hub.bins().size).toBe(3);
  });
});

describe('Crowds: merging', () => {
  it('a crowd of 16 with no lists for 30 s merges, and every member is told 0', () => {
    const hub = formed(16, { seed: 'merge' });
    const t0 = 100 + SPLIT_WAIT_MS;
    expect(hub.crowds.due()).toBe(t0 + QUIET_MS);
    expect(hub.settle(t0 + QUIET_MS - 1)).toEqual([]);
    const moved = hub.settle(t0 + QUIET_MS);
    expect(moved).toHaveLength(16);
    for (const m of moved) expect(m.n).toBe(OPEN_WATER);
    for (const who of hub.at.keys()) expect(hub.heard.get(who)).toBe(OPEN_WATER);
    expect(hub.crowds.view()).toEqual([]);
    expect(hub.crowds.due()).toBeNull();
  });

  it('a list from a member, or more than 16 members, keeps it apart', () => {
    const hub = formed(16, { seed: 'merge-list' });
    const t0 = 100 + SPLIT_WAIT_MS;
    hub.again(id(2), t0 + 20_000, [id(2)]);
    expect(hub.settle(t0 + QUIET_MS)).toEqual([]);
    expect(hub.settle(t0 + 20_000 + QUIET_MS)).toHaveLength(16);

    const full = formed(17, { seed: 'merge-full' });
    expect(full.settle(t0 + QUIET_MS)).toEqual([]);
    // Down to 16: quiet counts from then.
    full.remove(id(16), t0 + QUIET_MS + 1);
    expect(full.settle(t0 + 2 * QUIET_MS)).toEqual([]);
    expect(full.settle(t0 + 2 * QUIET_MS + 1)).toHaveLength(16);
  });

  it('one with a locked member waits for the lock to go', () => {
    const hub = formed(8, { seed: 'merge-lock', quietMs: 3000 });
    const t0 = 100 + SPLIT_WAIT_MS;
    hub.locks.add(id(1)).add(id(2));
    hub.pair(id(1), id(2));
    expect(hub.settle(t0 + 3000)).toEqual([]);
    expect(hub.settle(t0 + 30_000)).toEqual([]);
    hub.locks.clear();
    expect(hub.settle(t0 + 32_000)).toEqual([]);
    expect(hub.settle(t0 + 33_000)).toHaveLength(8);
  });

  it('numbers instances from 1, and gives fresh numbers to the next crowd once one ends', () => {
    const hub = formed(8, { seed: 'numbers', quietMs: 1000 });
    expect([...hub.bins().keys()].sort()).toEqual([1, 2]);
    expect(hub.settle(100 + SPLIT_WAIT_MS + 1000)).toHaveLength(8);
    hub.again(id(0), 10_000, [id(0)]);
    hub.settle(10_000 + SPLIT_WAIT_MS);
    expect([...hub.bins().keys()].sort()).toEqual([3, 4]);
  });
});

describe('Crowds: restore', () => {
  it('a crowd rebuilt from its members’ (crowd, instance) pairs gives every member the same instance', () => {
    const hub = formed(40, { seed: 'restore' });
    hub.report(id(60), C + 5000, C, 5000);
    const saved = [...hub.at.values()].map((m) => ({
      m,
      crowd: hub.crowds.crowdOf(m.id),
      n: hub.n(m.id),
    }));
    const woke = new Hub();
    woke.crowds.restore(saved, 10_000);
    for (const { m } of saved) woke.at.set(m.id, m);
    for (const { m, n } of saved) expect(woke.n(m.id)).toBe(n);
    expect(woke.crowds.view()).toEqual(hub.crowds.view());
    // Quiet timers start again on a wake.
    expect(woke.crowds.due()).toBe(10_000 + QUIET_MS);
    // A new crowd takes numbers the woken one does not hold.
    for (let i = 0; i < 3; i++) woke.report(id(200 + i), 20_000 + 100 * i, 20_000, 11_000);
    woke.again(id(200), 11_000, [id(201)]);
    woke.settle(11_000 + SPLIT_WAIT_MS);
    const used = new Set(saved.map((s) => s.n));
    for (let i = 0; i < 3; i++) {
      expect(woke.n(id(200 + i))).not.toBe(OPEN_WATER);
      expect(used.has(woke.n(id(200 + i)))).toBe(false);
    }
  });
});

describe('Crowds: locked members', () => {
  it('a locked member’s instance never changes, and every member has exactly one (2,000 sequences)', () => {
    lockedHold(2000, 'quick');
  });

  heavyTest('a locked member’s instance never changes (10,000 sequences)', () => {
    lockedHold(10_000, 'full');
  });
});

/**
 * Random sequences of reports (some crowded, with lists), locks, unlocks, removes and settles over
 * 12 creatures in a 2,000 wu square: a member's instance holds while it is locked, and the crowds
 * agree with every member's instance.
 */
function lockedHold(runs: number, seed: string): void {
  for (let run = 0; run < runs; run++) {
    const rng = createRng(seedFromString(`${seed}:${run}`));
    const hub = new Hub({ instanceMax: rng.int(1, 4), quietMs: 2000 });
    const frozen = new Map<string, number>();
    let now = 0;
    for (let step = 0; step < 60; step++) {
      now += rng.int(0, 2000);
      const who = id(rng.int(0, 11));
      const roll = rng.next();
      if (roll < 0.55) {
        const m = hub.at.get(who);
        const x = (m?.x ?? C) + rng.int(-800, 800);
        const y = (m?.y ?? C) + rng.int(-800, 800);
        const list =
          rng.next() < 0.4 ? [...new Set([id(rng.int(0, 11)), id(rng.int(0, 11))])] : null;
        hub.report(
          who,
          Math.min(Math.max(x, C - 1000), C + 1000),
          Math.min(Math.max(y, C - 1000), C + 1000),
          now,
          list,
        );
      } else if (roll < 0.7) {
        const other = id(rng.int(0, 11));
        if (other !== who && !hub.locks.has(who) && !hub.locks.has(other)) {
          hub.locks.add(who).add(other);
          hub.pairs.set(who, [other]);
          hub.pairs.set(other, [who]);
          frozen.set(who, hub.n(who)).set(other, hub.n(other));
        }
      } else if (roll < 0.8) {
        for (const p of [who, ...hub.partners(who)]) {
          hub.locks.delete(p);
          hub.pairs.delete(p);
          frozen.delete(p);
        }
      } else if (roll < 0.87) {
        if (!hub.locks.has(who)) hub.remove(who, now);
      } else {
        hub.settle(now);
      }
      for (const [p, n] of frozen) {
        if (hub.at.has(p) && hub.n(p) !== n) throw new Error(`run ${run} step ${step}: ${p} moved`);
      }
      const view = hub.crowds.view();
      const counted = new Map<number, number>();
      for (const c of view) for (const i of c.instances) counted.set(i.n, i.members);
      const seen = new Map<number, number>();
      for (const p of hub.at.keys()) {
        const n = hub.n(p);
        if (n !== OPEN_WATER) seen.set(n, (seen.get(n) ?? 0) + 1);
      }
      for (const [n, k] of seen)
        if (counted.get(n) !== k) throw new Error(`run ${run}: instance ${n}`);
      const numbers = view.flatMap((c) => c.instances.map((i) => i.n));
      if (new Set(numbers).size !== numbers.length) throw new Error(`run ${run}: a number twice`);
    }
  }
}

describe('Crowds: lists', () => {
  it('a list pairs creatures only for 10 s', () => {
    // One creature an instance, so only a unit shares one.
    const hub = new Hub({ instanceMax: 1 });
    for (let i = 0; i < 4; i++) hub.report(id(i), C + 200 * i, C, 0);
    hub.again(id(0), 0, [id(1)]);
    hub.again(id(2), CROWD_LIST_TTL_MS + 1, [id(3)]);
    hub.settle(CROWD_LIST_TTL_MS + 1 + SPLIT_WAIT_MS);
    expect(hub.n(id(2))).toBe(hub.n(id(3)));
    expect(hub.n(id(0))).not.toBe(OPEN_WATER);
    expect(hub.n(id(0))).not.toBe(hub.n(id(1)));
  });
});

describe('Crowds: speed', () => {
  speedTest('a report into a crowd of 300 under 1 ms, forming one of 300 under 20 ms', () => {
    const rng = createRng(seedFromString('speed'));
    // All within the reporter's P1 reach, 10 of them with lists.
    const points = scatter(rng, 300, 700);
    points[0] = [C, C];
    let forming = Number.POSITIVE_INFINITY;
    let reporting = Number.POSITIVE_INFINITY;
    for (let round = 0; round < 5; round++) {
      const hub = new Hub();
      points.forEach(([x, y], i) => hub.report(id(i), x, y, 0));
      for (let i = 0; i < 300; i += 30) hub.again(id(i), 0, listOf(hub, id(i)));
      const t0 = performance.now();
      hub.settle(SPLIT_WAIT_MS);
      forming = Math.min(forming, performance.now() - t0);
      expect(hub.bins().size).toBeGreaterThanOrEqual(2);
      const t1 = performance.now();
      points.forEach(([x, y], i) => hub.report(id(i), x + 1, y, 5000));
      for (let i = 0; i < 300; i++) hub.report(id(400 + i), C + 760 + i, C, 5000);
      reporting = Math.min(reporting, (performance.now() - t1) / 600);
    }
    expect(forming).toBeLessThan(20);
    expect(reporting).toBeLessThan(1);
  });
});
