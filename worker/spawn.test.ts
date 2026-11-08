import { beforeEach, describe, expect, it } from 'vitest';
import { INTERACT_LEAD_WU, INTERACT_RADII } from '../src/net/aoi';
import type { HubMsg } from '../src/net/protocol';
import { Directory } from './directory';
import {
  advance,
  authority,
  CENTRE,
  hatched,
  join,
  NEAR,
  type Player,
  pair,
  refusal,
  setEnv,
  snap,
  useFightHub,
} from './fight-test-kit';
import { must } from './ledger-test-kit';
import { breed, grower, promote, restore } from './lineage-test-kit';
import { clearance } from './placement';
import {
  anchorAt as anchorPlayer,
  type Client,
  flush,
  nextOf,
  placed,
  report,
  signIn,
  sql,
} from './test-hub';

// Spawning by the authority (M12 T4, ADR 0064): where lives go, the answers, and the anchors that
// hold the first report under a binding near where the hub put the creature. The object's
// directory is swapped for one of 262,144 wu, as M11's hub tests do.

useFightHub();

// A fixed world seed: placement reads the depth field and the plumes around the groups, so a random
// seed puts a test's chosen spots out of the band about 1 run in 12 (the hub then falls back).
const SEED = '5'.repeat(64);
beforeEach(async () => {
  await sql('UPDATE world SET seed = ?', SEED);
  await authority((o) => {
    o.directory = new Directory(262_144);
    o.spawns.length = 0;
  });
});

const STARTER = { r: 10, aoi: 233 };
type Spawn = Extract<HubMsg, { t: 'spawn' }>;
type Who = { c: Client; id: { playerId: string } };

/** Asks where the creature enters the water and returns the answer. */
async function spawnOf(p: Who, ask = STARTER): Promise<Spawn> {
  p.c.send({ t: 'spawn', ...ask });
  return nextOf(p.c, 'spawn');
}
/** The member as the directory holds it. */
const memberOf = (p: Who) =>
  authority(
    (o) =>
      must(o.directory.member(p.id.playerId)) as { x: number; y: number; r: number; aoi: number },
  );
/** Reports at (x, y) with the directory's own size for the member; resolves true once `near` came. */
async function reports(p: Who, x: number, y: number): Promise<boolean> {
  const m = await memberOf(p).catch(() => ({ ...STARTER }));
  p.c.send({ t: 'where', x, y, r: m.r, aoi: m.aoi });
  return (await flush(p.c)).some((msg) => msg.t === 'near');
}
/** Sets the anchor of the session's current binding at (x, y): as if the hub had put it there. */
const anchorAt = (p: Who, x: number, y: number) => anchorPlayer(p.id.playerId, x, y);
/** Places a practice cell's report at (x, y), anchored there first. */
async function standAt(p: Who, x: number, y: number, size = STARTER): Promise<void> {
  await anchorAt(p, x, y);
  p.c.send({ t: 'where', x, y, ...size });
  await nextOf(p.c, 'near');
}
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y);
const p1Reach = (a: { r: number }, b: { r: number }) =>
  INTERACT_RADII * Math.max(a.r, b.r) + INTERACT_LEAD_WU;
const droppedWheres = () => authority((o) => o.dropped.get('where') ?? 0);
const teleports = async (creature: string) =>
  (
    await sql<{ n: number }>(
      "SELECT COUNT(*) AS n FROM flags WHERE kind = 'teleport' AND creature = ?",
      creature,
    )
  )[0]?.n;

describe('where lives go', () => {
  it('spawns the first player’s genesis on the world’s centre, protected', async () => {
    const a = await hatched();
    expect(await spawnOf(a)).toEqual({
      t: 'spawn',
      x: CENTRE,
      y: CENTRE,
      why: 'placed',
      protect: true,
    });
  });

  it('spawns a second starter outside the first’s clearance and within its P1 reach', async () => {
    const a = await hatched();
    const at = await spawnOf(a);
    expect(await reports(a, at.x, at.y)).toBe(true);
    const b = await hatched();
    const there = await spawnOf(b);
    const [ma, mb] = [await memberOf(a), await memberOf(b)];
    expect(dist(there, ma)).toBeGreaterThanOrEqual(clearance(ma, mb));
    expect(dist(there, ma)).toBeLessThanOrEqual(p1Reach(ma, mb));
  });

  it('spawns a starter by the group of starters, not by a T1 member near the centre', async () => {
    const t1 = await join();
    await standAt(t1, CENTRE + 600, CENTRE, { r: 63, aoi: 992 });
    const group = [await join(), await join(), await join()];
    for (const [i, p] of group.entries()) await standAt(p, CENTRE + 6000 + 300 * i, CENTRE);
    const a = await hatched();
    const at = await spawnOf(a);
    const reach = Math.min(
      ...group.map((_, i) => dist(at, { x: CENTRE + 6000 + 300 * i, y: CENTRE })),
    );
    expect(reach).toBeLessThanOrEqual(p1Reach({ r: 20 }, { r: 10 }));
    expect(dist(at, { x: CENTRE + 600, y: CENTRE })).toBeGreaterThan(3000);
  });

  it('keeps two genesis spawns of the same minute apart, with nobody near', async () => {
    const a = await hatched();
    const first = await spawnOf(a);
    const ma = await memberOf(a);
    // A leaves the water at once: only the recent spawn keeps B off its place.
    a.c.send({ t: 'gone' });
    await flush(a.c);
    await advance(30_000);
    const b = await hatched();
    const second = await spawnOf(b);
    expect(dist(first, second)).toBeGreaterThanOrEqual(clearance(ma, await memberOf(b)));
  });

  it('spawns 30 sessions one after another, each outside every earlier one’s clearance', async () => {
    const placedSoFar: { x: number; y: number; r: number; aoi: number }[] = [];
    for (let i = 0; i < 30; i++) {
      const p = await join();
      const at = await spawnOf(p);
      expect(await reports(p, at.x, at.y)).toBe(true);
      for (const earlier of placedSoFar) {
        expect(dist(at, earlier)).toBeGreaterThanOrEqual(clearance(STARTER, earlier) - 1e-6);
      }
      placedSoFar.push({ x: at.x, y: at.y, ...STARTER });
      // Each a minute apart: the clearance holds by the reports, not by the recent spawns.
      await advance(61_000);
    }
  }, 60_000);
});

describe('answers', () => {
  it('answers the same place to a spawn asked twice under one binding', async () => {
    const a = await hatched();
    const first = await spawnOf(a);
    await advance(1000);
    expect(await spawnOf(a)).toEqual(first);
  });

  it('refuses a locked creature `spawn`', async () => {
    const [a, b] = await pair();
    a.c.send({
      t: 'engage',
      target: b.id.playerId,
      mine: snap(a, ...NEAR.a),
      theirs: snap(b, ...NEAR.b),
    });
    await nextOf(b.c, 'lock-ask');
    a.c.send({ t: 'spawn', ...STARTER });
    expect(await nextOf(a.c, 'refused')).toEqual({ t: 'refused', reason: 'spawn' });
  });

  it('places an unrecorded cell by the radius and AoI it states, unprotected', async () => {
    const p = await join();
    const at = await spawnOf(p, { r: 30, aoi: 500 });
    expect(at).toMatchObject({ why: 'placed', protect: false });
    expect(await memberOf(p)).toMatchObject({ x: at.x, y: at.y, r: 30, aoi: 500 });
  });

  it('protects a resume never, and a restore from its answer on', async () => {
    await setEnv(true);
    const [a, b] = await pair();
    for (const p of [a, b]) {
      await advance(10_000);
      p.ticks += 300;
      report(p.c, p.ticks);
      await nextOf(p.c, 'ack');
    }
    await placed(a, b);
    // A reload resumes the creature: placed, unprotected.
    const again = await join(a.id);
    const resumed: Player = { ...a, c: again.c, pond: again.pond };
    expect(await spawnOf(resumed)).toMatchObject({ why: 'placed', protect: false });
    await placed(resumed, b);
    const [bornA] = await breed(resumed, b);
    const child = await promote(await grower(resumed), bornA);
    child.c.send({ t: 'death', cause: 'toxin', ticks: 0 });
    const ancestor = must((await nextOf(child.c, 'died')).fallback?.ancestor);
    await setEnv(false);
    await restore(child, ancestor, child.creature);
    // The binding came 10 s before the answer, and the engage 10 s after it.
    await advance(10_000);
    expect(await spawnOf(resumed)).toMatchObject({ why: 'placed', protect: true });
    await advance(10_000);
    const parent = { ...resumed, creature: a.creature, ref: a.ref };
    expect(await refusal(b, parent, snap(parent, ...NEAR.a), snap(b, ...NEAR.b))).toBe(
      'engage:protected',
    );
  });
});

describe('anchors', () => {
  it('drops a first report 2,500 wu from the given place, flags teleport once, and takes one 500 wu off', async () => {
    const a = await hatched();
    const at = await spawnOf(a);
    await advance(1000);
    const before = await droppedWheres();
    expect(await reports(a, at.x + 2500, at.y)).toBe(false);
    expect(await reports(a, at.x - 2500, at.y)).toBe(false);
    expect(await droppedWheres()).toBe(before + 2);
    expect(await teleports(a.creature)).toBe(1);
    expect(await reports(a, at.x + 500, at.y)).toBe(true);
    expect(await teleports(a.creature)).toBe(1);
  });

  it('drops a report under a binding with no anchor yet', async () => {
    const a = await hatched();
    const before = await droppedWheres();
    expect(await reports(a, CENTRE, CENTRE)).toBe(false);
    expect(await droppedWheres()).toBe(before + 1);
    expect(await teleports(a.creature)).toBe(0);
  });

  it('takes both in fixture mode', async () => {
    await setEnv(true);
    const a = await hatched();
    expect(await reports(a, CENTRE + 9000, CENTRE)).toBe(true);
    const b = await hatched();
    const at = await spawnOf(b);
    expect(await reports(b, at.x + 9000, at.y)).toBe(true);
  });

  it('drops a promoted child’s report 5,000 wu from its parent’s last report', async () => {
    await setEnv(true);
    const [a, b] = await pair();
    for (const p of [a, b]) {
      await advance(10_000);
      p.ticks += 300;
      report(p.c, p.ticks);
      await nextOf(p.c, 'ack');
    }
    await placed(a, b);
    const [bornA] = await breed(a, b);
    await setEnv(false);
    const child = await promote(await grower(a), bornA);
    const before = await droppedWheres();
    expect(await reports(child, CENTRE + 5000, CENTRE)).toBe(false);
    expect(await droppedWheres()).toBe(before + 1);
    // Beside the parent's last report (the world's centre, where `placed` put it), it is taken.
    expect(await reports(child, CENTRE + 300, CENTRE)).toBe(true);
  });
});

describe('the welcome', () => {
  it('holds no spawn hint', async () => {
    const { c } = await signIn();
    const welcome = await nextOf(c, 'welcome');
    expect(welcome).not.toHaveProperty('you');
  });
});
