import { describe, expect, it, vi } from 'vitest';
import { type MateAsk, signMateAsk } from '../src/ledger/mating';
import { CLOSE_RATE_LIMITED, type HubMsg } from '../src/net/protocol';
import { heavyTest } from '../tests/heavy';
import { Crowds, QUIET_MS, SPLIT_WAIT_MS } from './crowds';
import { Directory } from './directory';
import {
  advance,
  authority,
  clock,
  engage,
  fighters,
  hatched,
  join,
  killB,
  lockIn,
  NEAR,
  type Player,
  refusal,
  setEnv,
  snap,
  useFightHub,
} from './fight-test-kit';
import type { Session } from './socket';
import { type Client, flush, freshNonce, nextOf, report, rowsWritten } from './test-hub';
import { armCrowds, instanceMaxOf, quietMsOf, rebuildCrowds } from './where';

// Crowd instances on the authority (M12 T5, ADR 0064): `hub.crowds` beside the directory. Crowded
// reports split a crowd into instances, each member hears its own, and `near`, the relay, courts,
// engages, joins and carrion keep to the water a member shares. The object's directory is swapped
// for one of 262,144 wu and its crowds for fresh ones in each test.

useFightHub();

const WORLD = 262_144;
const [CX, CY] = NEAR.a;
const STARTER_AOI = 233;

type Who = Pick<Player, 'c' | 'id'>;

/** A fresh directory and fresh crowds (filled to `instanceMax`) on the object. */
const freshWater = (instanceMax?: number) =>
  authority((o) => {
    o.directory = new Directory(WORLD);
    o.crowds = new Crowds(instanceMax === undefined ? {} : { instanceMax });
    o.crowdTimer = null;
    o.crowdsKept.clear();
  });

/** Reports (with a crowd list when given) and waits for the answer. */
const placed = async (p: Who, x: number, y: number, crowd?: string[]) => {
  p.c.send({ t: 'where', x, y, r: 10, aoi: STARTER_AOI, ...(crowd ? { crowd } : {}) });
  return nextOf(p.c, 'near');
};
const idOf = (p: Who) => p.id.playerId;
const instanceOn = (p: Who) => authority((o) => o.crowds.instanceOf(idOf(p)));
const types = (ms: HubMsg[]) => ms.map((m) => m.t);

/** Fresh crowds with each player in an instance (crowd id = instance), at its directory position. */
const inInstances = (entries: [Who, number][]) =>
  authority((o) => {
    o.crowds = new Crowds();
    o.crowds.restore(
      entries.map(([p, n]) => {
        const m = o.directory.member(idOf(p));
        return { m: { id: idOf(p), x: m?.x ?? CX, y: m?.y ?? CY, r: m?.r ?? 10 }, crowd: n, n };
      }),
      clock.t,
    );
  });

/** A crowd attachment as the object keeps it. */
const attachedCrowd = (p: Who) =>
  authority((o) => {
    for (const ws of o.ctx.getWebSockets()) {
      const s = ws.deserializeAttachment() as Session | null;
      if (s?.phase === 'active' && s.playerId === idOf(p)) return s.crowd;
    }
    return undefined;
  });

/**
 * 20 sessions on a 5 × 4 grid 180 wu apart; the first three (the crowded reporters) lie within the
 * P1 reach (680 wu) of every other, so whichever of them forms the crowd takes all 20.
 */
async function grid(): Promise<Who[]> {
  const out: Who[] = [];
  const first: [number, number][] = [
    [0, -90],
    [0, 90],
    [180, 90],
  ];
  const spots = [...first];
  for (const dx of [-360, -180, 0, 180, 360]) {
    for (const dy of [-270, -90, 90, 270]) {
      if (!first.some(([x, y]) => x === dx && y === dy)) spots.push([dx, dy]);
    }
  }
  for (const [dx, dy] of spots) {
    const p = await join();
    await placed(p, CX + dx, CY + dy);
    out.push(p);
  }
  return out;
}

/** The grid's crowd: three crowded reports naming nobody but themselves, then the split. */
async function formed(ps: Who[]): Promise<Map<string, number>> {
  for (const p of ps.slice(0, 3)) {
    const m = await authority((o) => o.directory.member(idOf(p)));
    await placed(p, m?.x ?? CX, m?.y ?? CY, [idOf(p)]);
  }
  await advance(SPLIT_WAIT_MS);
  const told = new Map<string, number>();
  for (const p of ps) told.set(idOf(p), (await nextOf(p.c, 'instance')).n);
  return told;
}

describe('forming', () => {
  heavyTest(
    'splits 20 sessions into two instances of 10, tells each its own, and answers near by water',
    async () => {
      await freshWater();
      const ps = await grid();
      const rows = await rowsWritten();
      for (const p of ps.slice(0, 3)) {
        const m = await authority((o) => o.directory.member(idOf(p)));
        await placed(p, m?.x ?? CX, m?.y ?? CY, [idOf(p)]);
      }
      // Nothing moves before the wait is up.
      await advance(SPLIT_WAIT_MS - 1);
      expect(types(await flush(ps[0]?.c as Client))).toEqual([]);
      expect(await instanceOn(ps[0] as Who)).toBe(0);
      await advance(1);
      const told = new Map<string, number>();
      for (const p of ps) told.set(idOf(p), (await nextOf(p.c, 'instance')).n);
      const counts = new Map<number, number>();
      for (const n of told.values()) counts.set(n, (counts.get(n) ?? 0) + 1);
      expect([...counts.keys()].every((n) => n > 0)).toBe(true);
      expect([...counts.values()]).toEqual([10, 10]);
      for (const p of ps) {
        expect(await instanceOn(p)).toBe(told.get(idOf(p)));
        expect(await attachedCrowd(p)).toEqual({ id: expect.any(Number), n: told.get(idOf(p)) });
      }
      // Each near lists only its own instance's members (nobody is in the open water here), with n.
      for (const p of ps) {
        const m = await authority((o) => o.directory.member(idOf(p)));
        const near = await placed(p, m?.x ?? CX, m?.y ?? CY);
        expect(near.peers).toHaveLength(9);
        expect(near.peers.every((q) => q.n === told.get(idOf(p)))).toBe(true);
        expect(near.peers.every((q) => told.get(q.id) === told.get(idOf(p)))).toBe(true);
      }
      expect(await rowsWritten()).toBe(rows);
      // An open-water session far enough out not to join sees both instances.
      const outside = await join();
      const near = await placed(outside, CX, CY + 1500);
      expect(new Set(near.peers.map((q) => q.n))).toEqual(new Set(counts.keys()));
      expect(await instanceOn(outside)).toBe(0);
    },
  );

  it('drops crowd ids that are not seated', async () => {
    await freshWater();
    const [a, b] = [await join(), await join()];
    await placed(b, CX + 100, CY);
    await placed(a, CX, CY, [idOf(b), 'Z'.repeat(43)]);
    const lists = await authority(
      (o) => (o.crowds as unknown as { lists: Map<string, { ids: string[] }> }).lists,
    );
    expect(lists.get(idOf(a))?.ids).toEqual([idOf(b)]);
  });

  it('reads INSTANCE_MAX (1–16) and QUIET_MS (at least 500) only in fixture mode', () => {
    expect(instanceMaxOf({ INSTANCE_MAX: '2' })).toBe(16);
    expect(instanceMaxOf({ DRAND_SOURCE: 'fixture', INSTANCE_MAX: '2' })).toBe(2);
    expect(instanceMaxOf({ DRAND_SOURCE: 'fixture', INSTANCE_MAX: '17' })).toBe(16);
    expect(instanceMaxOf({ DRAND_SOURCE: 'fixture', INSTANCE_MAX: '0' })).toBe(16);
    expect(quietMsOf({ QUIET_MS: '3000' })).toBe(QUIET_MS);
    expect(quietMsOf({ DRAND_SOURCE: 'fixture', QUIET_MS: '3000' })).toBe(3000);
    expect(quietMsOf({ DRAND_SOURCE: 'fixture', QUIET_MS: '499' })).toBe(QUIET_MS);
  });
});

describe('units', () => {
  it('keeps a fight in one instance, and a fighter that signs in again during it takes it back', async () => {
    await freshWater(2);
    const [a, b] = await fighters();
    const [c, d] = [await join(), await join()];
    await placed(c, CX + 200, CY);
    await placed(d, CX, CY + 200);
    await placed(b, NEAR.b[0], NEAR.b[1], [idOf(a)]);
    await placed(a, CX, CY, [idOf(b)]);
    await advance(SPLIT_WAIT_MS);
    const n = (await nextOf(a.c, 'instance')).n;
    expect((await nextOf(b.c, 'instance')).n).toBe(n);
    expect((await nextOf(c.c, 'instance')).n).not.toBe(n);
    await lockIn(a, b);
    // B's page closes during the fight: its instance is kept, and its next sign-in hears it.
    b.c.ws.close(1000);
    await b.c.closed;
    expect(await instanceOn(b)).toBe(n);
    const back = await join(b.id);
    expect((await nextOf(back.c, 'instance')).n).toBe(n);
    expect(await attachedCrowd(back)).toMatchObject({ n });
    // After a wake, B (away again) takes it back from its fight's other fighter.
    back.c.ws.close(1000);
    await back.c.closed;
    await authority((o) => {
      o.crowds = rebuildCrowds(o);
    });
    expect(await instanceOn(b)).toBe(0);
    const again = await join(b.id);
    expect((await nextOf(again.c, 'instance')).n).toBe(n);
    expect(await instanceOn(b)).toBe(n);
  });

  it('keeps a courting pair in one instance', async () => {
    await setEnv(true);
    await freshWater(2);
    const [a, b] = [await hatched(), await hatched()];
    // Past maturity under MATING_SCALE 0.01.
    await advance(12_000);
    for (const p of [a, b]) {
      p.ticks += 360;
      report(p.c, p.ticks);
      await nextOf(p.c, 'ack');
    }
    const others = [await join(), await join(), await join(), await join()];
    await placed(a, CX, CY);
    await placed(b, CX + 300, CY);
    for (const [i, p] of others.entries()) await placed(p, CX + 100 * i, CY + 250);
    const ask: MateAsk = signMateAsk(a.id, {
      creature: a.creature,
      partner: idOf(b),
      partnerCreature: b.creature,
      nonce: freshNonce(),
    });
    a.c.send({ t: 'court', ask });
    await nextOf(b.c, 'invite');
    const first = others[0] as Who;
    await placed(first, CX, CY + 250, [idOf(first)]);
    await advance(SPLIT_WAIT_MS);
    const [na, nb] = [(await nextOf(a.c, 'instance')).n, (await nextOf(b.c, 'instance')).n];
    expect(na).toBe(nb);
    // Six members, two to an instance: the pair fills one and the others the other two.
    const rest = [];
    for (const p of others) rest.push((await nextOf(p.c, 'instance')).n);
    expect(rest).not.toContain(na);
    expect(new Set(rest).size).toBe(2);
  });
});

describe('refusals across instances', () => {
  it('refuses an engage from instance 1 on instance 2, and lets one from 0 on 2 go on', async () => {
    await freshWater();
    const [a, b] = await fighters();
    await inInstances([
      [a, 1],
      [b, 2],
    ]);
    expect(await refusal(a, b)).toBe('engage:instance');
    await inInstances([[b, 2]]);
    engage(a, b);
    expect(await nextOf(b.c, 'lock-ask')).toMatchObject({ by: idOf(a) });
  });

  it('refuses a join from instance 2 into a fight of a 1 and a 0', async () => {
    await freshWater();
    const [a, b] = await fighters();
    const c = await hatched();
    await advance(16_000);
    await inInstances([
      [a, 1],
      [c, 2],
    ]);
    await lockIn(a, b);
    expect(await refusal(c, b, snap(b, ...NEAR.b), snap(c, NEAR.b[0] + 12, NEAR.b[1]))).toBe(
      'engage:instance',
    );
  });

  it('answers not-near to a court between instances', async () => {
    await setEnv(true);
    await freshWater();
    const [a, b] = [await hatched(), await hatched()];
    await advance(12_000);
    for (const p of [a, b]) {
      p.ticks += 360;
      report(p.c, p.ticks);
      await nextOf(p.c, 'ack');
    }
    await placed(a, CX, CY);
    await placed(b, CX + 300, CY);
    await inInstances([
      [a, 1],
      [b, 2],
    ]);
    a.c.send({ t: 'mate-check', partner: idOf(b) });
    expect((await nextOf(a.c, 'mate-info')).reason).toBe('not-near');
    const ask = signMateAsk(a.id, {
      creature: a.creature,
      partner: idOf(b),
      partnerCreature: b.creature,
      nonce: freshNonce(),
    });
    a.c.send({ t: 'court', ask });
    expect(await nextOf(a.c, 'refused')).toEqual({ t: 'refused', reason: 'not-near' });
  });

  it('answers no-peer to a signal between instances, and passes a duty pair’s', async () => {
    await freshWater();
    const [a, b] = [await join(), await join()];
    await placed(a, CX, CY);
    await placed(b, CX + 300, CY);
    await inInstances([
      [a, 1],
      [b, 2],
    ]);
    a.c.send({ t: 'signal', to: idOf(b), kind: 'offer', sdp: 'v=0' });
    expect(await nextOf(a.c, 'error')).toEqual({ t: 'error', code: 'no-peer' });
    await authority((o) => {
      vi.spyOn(o.duties, 'linksOf').mockImplementation((p) => (p === idOf(a) ? [idOf(b)] : []));
    });
    a.c.send({ t: 'signal', to: idOf(b), kind: 'offer', sdp: 'v=0' });
    expect(await nextOf(b.c, 'signal')).toMatchObject({ from: idOf(a) });
  });
});

describe('carrion by water', () => {
  /** Everything a client hears from now on. */
  function log(c: Client): HubMsg[] {
    const seen: HubMsg[] = [];
    c.ws.addEventListener('message', (e) => {
      seen.push(JSON.parse(String(e.data)) as HubMsg);
    });
    return seen;
  }

  it('reaches open-water and instance-1 sessions near a kill in instance 1, and no instance-2 session', async () => {
    await freshWater();
    const [a, b] = await fighters();
    const [open, one, two] = [await join(), await join(), await join()];
    await placed(open, NEAR.b[0] + 9000, NEAR.b[1]);
    await placed(one, NEAR.b[0], NEAR.b[1] + 9000);
    await placed(two, NEAR.b[0] - 9000, NEAR.b[1]);
    await inInstances([
      [a, 1],
      [b, 1],
      [one, 1],
      [two, 2],
    ]);
    const seen = [log(open.c), log(one.c), log(two.c)];
    await killB(a, b);
    for (const p of [open, one, two]) await flush(p.c);
    const carrion = seen.map((s) => s.filter((m) => m.t === 'carrion').length);
    expect(carrion).toEqual([1, 1, 0]);
  });
});

describe('a wake', () => {
  heavyTest(
    'rebuilds the crowds from the attachments: every member keeps its instance and near',
    async () => {
      await freshWater();
      const ps = await grid();
      const told = await formed(ps);
      const p = ps[5] as Who;
      const m = await authority((o) => o.directory.member(idOf(p)));
      const before = await placed(p, m?.x ?? CX, m?.y ?? CY);
      await authority((o) => {
        o.crowds = rebuildCrowds(o);
      });
      for (const q of ps) expect(await instanceOn(q)).toBe(told.get(idOf(q)));
      const after = await placed(p, m?.x ?? CX, m?.y ?? CY);
      expect(after.peers.map((q) => [q.id, q.n])).toEqual(before.peers.map((q) => [q.id, q.n]));
    },
  );
});

describe('merging', () => {
  /** Four sessions 200 wu apart, two to an instance, in one crowd that may merge (at most 16). */
  async function four(): Promise<Who[]> {
    await freshWater();
    const ps: Who[] = [];
    for (const [dx, dy] of [
      [0, 0],
      [200, 0],
      [0, 200],
      [200, 200],
    ] as const) {
      const p = await join();
      await placed(p, CX + dx, CY + dy);
      ps.push(p);
    }
    await placed(ps[0] as Who, CX, CY, [idOf(ps[0] as Who)]);
    await advance(SPLIT_WAIT_MS);
    for (const p of ps) expect((await nextOf(p.c, 'instance')).n).toBeGreaterThan(0);
    return ps;
  }

  it('merges a crowd quiet for QUIET_MS: every member hears 0, and no row is written', async () => {
    const ps = await four();
    const rows = await rowsWritten();
    await advance(QUIET_MS - 1);
    expect(types(await flush(ps[0]?.c as Client))).toEqual([]);
    await advance(1);
    for (const p of ps) {
      expect(await nextOf(p.c, 'instance')).toEqual({ t: 'instance', n: 0 });
      expect(await attachedCrowd(p)).toBeUndefined();
    }
    expect(await authority((o) => o.crowds.view())).toEqual([]);
    expect(await rowsWritten()).toBe(rows);
  });

  it('waits for a locked member’s fight to end', async () => {
    const ps = await four();
    const locked = idOf(ps[1] as Who);
    await authority((o) =>
      o.fights.open('crowd-lock', [locked], ['crowd-creature'], 600_000, () => {}),
    );
    await advance(QUIET_MS + 1000);
    for (const p of ps) expect(types(await flush(p.c))).toEqual([]);
    await authority((o) => o.fights.release('crowd-lock'));
    await advance(QUIET_MS);
    for (const p of ps) expect(await nextOf(p.c, 'instance')).toEqual({ t: 'instance', n: 0 });
  });
});

describe('the budget', () => {
  it('still closes a session at its 21st message in 10 s', async () => {
    await freshWater();
    const { c } = await join();
    // The hello was the first message of the window.
    for (let i = 0; i < 19; i++) {
      c.send({ t: 'where', x: CX, y: CY, r: 10, aoi: STARTER_AOI, crowd: ['A'.repeat(43)] });
    }
    c.send({ t: 'where', x: CX, y: CY, r: 10, aoi: STARTER_AOI });
    expect(await c.closed).toBe(CLOSE_RATE_LIMITED);
  });
});

describe('the crowds’ timer', () => {
  function fake(due: number | null) {
    const timers: { at: number; live: boolean }[] = [];
    const hub = {
      crowds: { due: () => due },
      crowdTimer: null as { at: number; handle: unknown } | null,
      clock: {
        now: () => 0,
        after: (ms: number) => {
          const t = { at: ms, live: true };
          timers.push(t);
          return t;
        },
        cancel: (h: unknown) => {
          (h as { live: boolean }).live = false;
        },
      },
    };
    return { hub, timers, set: (d: number | null) => (due = d) };
  }

  it('keeps a timer held for the same time or earlier, replaces one held for later, clears it at null', () => {
    const f = fake(100);
    // biome-ignore lint/suspicious/noExplicitAny: a hub with only the fields armCrowds reads
    const h = f.hub as any;
    armCrowds(h);
    expect(f.timers).toHaveLength(1);
    f.set(100);
    armCrowds(h);
    f.set(250);
    armCrowds(h);
    expect(f.timers).toHaveLength(1);
    f.set(40);
    armCrowds(h);
    expect(f.timers.map((t) => t.live)).toEqual([false, true]);
    f.set(null);
    armCrowds(h);
    expect(f.timers.map((t) => t.live)).toEqual([false, false]);
    expect(f.hub.crowdTimer).toBeNull();
  });
});
