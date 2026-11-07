import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type MateAsk, signMateAsk } from '../src/ledger/mating';
import type { HubMsg } from '../src/net/protocol';
import { Directory } from './directory';
import {
  advance,
  authority,
  editSession,
  fighters,
  hatched,
  join,
  killB,
  NEAR,
  outcomeOf,
  type Player,
  rehatch,
  setEnv,
  useFightHub,
} from './fight-test-kit';
import { type Client, flush, freshNonce, nextOf, report, rowsWritten } from './test-hub';
import { leafMaxOf, rebuildDirectory } from './where';

// The authority's directory on the hub (M11 T6): `where` answered with `near`, `leaf` to the
// members a split moves, jumps, the wake, and the relay, courts and carrion by distance. The
// object's directory is swapped for one of 262,144 wu, so distances past today's world fit.

useFightHub();

const WORLD = 262_144;
const C = 100_000;
const STARTER_AOI = 233;

beforeEach(() =>
  authority((o) => {
    o.directory = new Directory(WORLD);
  }),
);

type Who = Pick<Player, 'c' | 'id'>;
const where = (p: Who, x: number, y = C, r = 10, aoi = STARTER_AOI) =>
  p.c.send({ t: 'where', x, y, r, aoi });
/** Reports and waits for the answer. */
const placed = async (p: Who, x: number, y = C, r = 10, aoi = STARTER_AOI) => {
  where(p, x, y, r, aoi);
  return nextOf(p.c, 'near');
};
const droppedWheres = () => authority((o) => o.dropped.get('where') ?? 0);
const elsewhere = (p: Who) => editSession(p as Player, (s) => ({ ...s, pondId: 'another' }));
const types = (ms: HubMsg[]) => ms.map((m) => m.t).filter((t) => t !== 'member');

describe('where and near', () => {
  it('answers a where with the linkable members of its pond near it, nearest first, writing no row', async () => {
    const [a, b, c, d, giant] = [
      await join(),
      await join(),
      await join(),
      await join(),
      await join(),
    ];
    await placed(b, C + 3000);
    await advance(400);
    await placed(c, C + 1000);
    await elsewhere(d);
    await placed(d, C + 500);
    await placed(giant, C + 200, C, 300, 3000);
    await advance(100);
    const rows = await rowsWritten();
    const near = await placed(a, C);
    expect(near.peers.map((p) => p.id)).toEqual([c.id.playerId, b.id.playerId]);
    expect(near.peers.map((p) => p.age)).toEqual([100, 500]);
    expect(near.peers[0]).toMatchObject({ name: 'Tester', x: C + 1000, y: C, r: 10 });
    expect(near.leaf).toEqual({ x: 0, y: 0, size: WORLD });
    expect(near.swarm).toEqual([]);
    // The giant sees the starters of its pond within its AoI as a swarm, nearest first.
    expect((await placed(giant, C + 200, C, 300, 3000)).swarm).toEqual([
      [C, C],
      [C + 1000, C],
      [C + 3000, C],
    ]);
    expect(await rowsWritten()).toBe(rows);
  });

  it('sends one leaf to each member a split moved', async () => {
    await authority((o) => {
      o.directory = new Directory(WORLD, { leafMax: 2 });
    });
    const [a, b, c] = [await join(), await join(), await join()];
    await placed(a, 1000, 1000);
    await placed(b, 200_000, 1000);
    const near = await placed(c, 200_000, 200_000);
    expect(near.leaf).toEqual({ x: WORLD / 2, y: WORLD / 2, size: WORLD / 2 });
    const [seenA, seenB, seenC] = [await flush(a.c), await flush(b.c), await flush(c.c)];
    expect(seenA.filter((m) => m.t === 'leaf')).toEqual([
      { t: 'leaf', leaf: { x: 0, y: 0, size: WORLD / 2 } },
    ]);
    expect(seenB.filter((m) => m.t === 'leaf')).toEqual([
      { t: 'leaf', leaf: { x: WORLD / 2, y: 0, size: WORLD / 2 } },
    ]);
    expect(types(seenC)).toEqual([]);
    // A report within its leaf moves nobody.
    await placed(c, 200_100, 200_000);
    expect(types([...(await flush(a.c)), ...(await flush(b.c))])).toEqual([]);
  });

  it('reads LEAF_MAX (1–16) only in fixture mode', () => {
    expect(leafMaxOf({ LEAF_MAX: '2' })).toBe(16);
    expect(leafMaxOf({ DRAND_SOURCE: 'fixture', LEAF_MAX: '2' })).toBe(2);
    expect(leafMaxOf({ DRAND_SOURCE: 'fixture', LEAF_MAX: '17' })).toBe(16);
    expect(leafMaxOf({ DRAND_SOURCE: 'fixture', LEAF_MAX: '0' })).toBe(16);
  });

  it('takes a member out on gone and on a closed socket', async () => {
    const [a, b, c] = [await join(), await join(), await join()];
    await placed(b, C + 100);
    await placed(c, C + 200);
    b.c.send({ t: 'gone' });
    expect(types(await flush(b.c))).toEqual([]);
    c.c.ws.close(1000);
    await c.c.closed;
    expect((await placed(a, C)).peers).toEqual([]);
    expect(await authority((o) => o.directory.leaves())).toEqual([
      { leaf: { x: 0, y: 0, size: WORLD }, members: 1 },
    ]);
  });

  it('drops and counts a centre outside the world', async () => {
    const a = await join();
    const before = await droppedWheres();
    where(a, WORLD + 10);
    expect(types(await flush(a.c))).toEqual([]);
    expect(await droppedWheres()).toBe(before + 1);
  });
});

describe('jumps', () => {
  it('drops and counts a report 5,000 wu from one 2 s earlier', async () => {
    const p = await hatched();
    await placed(p, C);
    await advance(2000);
    const before = await droppedWheres();
    where(p, C + 5000);
    expect(types(await flush(p.c))).toEqual([]);
    expect(await droppedWheres()).toBe(before + 1);
    // Within reach (300 wu/s × 2 s + 2,000 wu), it is taken.
    expect((await placed(p, C + 2500)).leaf.size).toBe(WORLD);
  });

  it('takes the jump after a genesis', async () => {
    const p = await join();
    await placed(p, C);
    await advance(2000);
    await rehatch({ ...p, pond: p.pond });
    const before = await droppedWheres();
    await placed(p, C + 50_000);
    expect(await droppedWheres()).toBe(before);
  });

  it('takes every jump in fixture mode', async () => {
    await setEnv(true);
    const p = await hatched();
    await placed(p, C);
    await advance(2000);
    await placed(p, C + 50_000);
    expect(await authority((o) => o.directory.member(p.id.playerId)?.x)).toBe(C + 50_000);
  });
});

describe('a wake', () => {
  it('rebuilds the directory from the attachments: the next where gets the same peers', async () => {
    const [a, b, c] = [await join(), await join(), await join()];
    await placed(b, C + 700);
    await placed(c, C + 300);
    const before = await placed(a, C);
    await authority((o) => {
      o.directory = rebuildDirectory(o, WORLD);
    });
    const after = await placed(a, C);
    expect(after.peers.map((p) => p.id)).toEqual(before.peers.map((p) => p.id));
    expect(after.peers.map((p) => p.id)).toEqual([c.id.playerId, b.id.playerId]);
  });
});

describe('the relay by distance', () => {
  const offer = (from: Who, to: Who) =>
    from.c.send({ t: 'signal', to: to.id.playerId, kind: 'offer', sdp: 'v=0' });

  it('passes a signal 3,000 wu across ponds with the sender’s position, and refuses one 30,000 wu off', async () => {
    const [a, b, far] = [await join(), await join(), await join()];
    for (const p of [b, far]) await elsewhere(p);
    await placed(a, C);
    await placed(b, C + 3000);
    await placed(far, C + 30_000);
    offer(a, b);
    expect(await nextOf(b.c, 'signal')).toEqual({
      t: 'signal',
      from: a.id.playerId,
      kind: 'offer',
      sdp: 'v=0',
      at: [C, C, 10],
    });
    const pair = [a.id.playerId, b.id.playerId].sort().join(':');
    expect(await authority((o) => o.relays.get(pair))).toBe(1);
    offer(a, far);
    expect(await nextOf(a.c, 'error')).toEqual({ t: 'error', code: 'no-peer' });
    expect(types(await flush(far.c))).toEqual([]);
  });

  it('passes a duty pair’s signal at any distance', async () => {
    const [a, far] = [await join(), await join()];
    await elsewhere(far);
    await placed(a, C);
    await placed(far, C + 100_000);
    await authority((o) => {
      vi.spyOn(o.duties, 'linksOf').mockImplementation((p) =>
        p === a.id.playerId ? [far.id.playerId] : [],
      );
    });
    offer(a, far);
    expect(await nextOf(far.c, 'signal')).toMatchObject({ from: a.id.playerId, at: [C, C, 10] });
  });
});

describe('courts by distance', () => {
  /** The creatures play 12 s, past maturity under MATING_SCALE 0.01. */
  async function grow(...ps: Player[]): Promise<void> {
    await advance(12_000);
    for (const p of ps) {
      p.ticks += 360;
      report(p.c, p.ticks);
      await nextOf(p.c, 'ack');
    }
  }
  const askOf = (from: Player, to: Player): MateAsk =>
    signMateAsk(from.id, {
      creature: from.creature,
      partner: to.id.playerId,
      partnerCreature: to.creature,
      nonce: freshNonce(),
    });
  const check = async (a: Player, b: Player) => {
    a.c.send({ t: 'mate-check', partner: b.id.playerId });
    return (await nextOf(a.c, 'mate-info')).reason;
  };

  it('answers not-near 15,000 wu apart, and courts as before 2,000 wu apart', async () => {
    await setEnv(true);
    const [a, b] = [await hatched(), await hatched()];
    await grow(a, b);
    await placed(a, C);
    await placed(b, C + 15_000);
    expect(await check(a, b)).toBe('not-near');
    a.c.send({ t: 'court', ask: askOf(a, b) });
    expect(await nextOf(a.c, 'refused')).toEqual({ t: 'refused', reason: 'not-near' });
    await placed(b, C + 2000);
    expect(await check(a, b)).toBeNull();
    a.c.send({ t: 'court', ask: askOf(a, b) });
    expect(await nextOf(b.c, 'invite')).toMatchObject({ from: a.id.playerId });
  });

  it('answers not-near when the directory knows only one of them', async () => {
    const [a, b] = [await hatched(), await hatched()];
    await placed(a, C);
    expect(await check(a, b)).toBe('not-near');
  });
});

describe('carrion by area', () => {
  /** Everything a client hears from now on. */
  function log(c: Client): HubMsg[] {
    const seen: HubMsg[] = [];
    c.ws.addEventListener('message', (e) => {
      seen.push(JSON.parse(String(e.data)) as HubMsg);
    });
    return seen;
  }

  it('reaches a session 9,000 wu from the kill in another pond, and not one 12,000 wu away', async () => {
    const [a, b] = await fighters();
    const [near, far] = [await join(), await join()];
    for (const p of [near, far]) await elsewhere(p);
    // The fight is at `NEAR` (at the world's centre).
    await placed(near, NEAR.b[0] + 9000, NEAR.b[1]);
    await placed(far, NEAR.b[0] + 12_000, NEAR.b[1]);
    const [seenNear, seenFar] = [log(near.c), log(far.c)];
    const { end } = await killB(a, b);
    const victim = outcomeOf(end, b);
    expect(Math.abs(victim.x - NEAR.b[0])).toBeLessThan(500);
    await flush(near.c);
    await flush(far.c);
    expect(seenNear.filter((m) => m.t === 'carrion')).toHaveLength(1);
    expect(seenFar.filter((m) => m.t === 'carrion')).toHaveLength(0);
  });
});
