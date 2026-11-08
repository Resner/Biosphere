import { beforeEach, describe, expect, it } from 'vitest';
import { INTERACT_LEAD_WU, INTERACT_RADII } from '../src/net/aoi';
import type { HubMsg } from '../src/net/protocol';
import { Directory } from './directory';
import {
  advance,
  advanceTo,
  authority,
  CENTRE,
  clock,
  editSession,
  fighters,
  hatched,
  join,
  killB,
  NEAR,
  type Player,
  pair,
  refusal,
  snap,
  spawned,
  useFightHub,
} from './fight-test-kit';
import { RIDE_AFTER_FIGHT_MS } from './fights';
import { must } from './ledger-test-kit';
import { clearance } from './placement';
import { RIDE_ALONE_MS, rideAloneMsOf } from './ride';
import { anchorAt, type Client, flush, nextOf, rowsWritten, sql } from './test-hub';

// Riding the current (M12 T7, ADR 0064): the refusals in their order, and a granted ride that lands
// by the group, protected, anchored, in the directory at once and writing no row. The object's
// directory is swapped for one of 262,144 wu, as the spawn tests do.

useFightHub();

// A fixed world seed: placement reads the depth field and the plumes around the groups.
const SEED = '5'.repeat(64);
beforeEach(async () => {
  await sql('UPDATE world SET seed = ?', SEED);
  await authority((o) => {
    o.directory = new Directory(262_144);
    o.spawns.length = 0;
  });
});

const STARTER = { r: 10, aoi: 233 };
/** Far out from the centre: nobody there is within anyone's Q of it. */
const FAR = { x: CENTRE + 40_000, y: CENTRE };
type Who = { c: Client; id: { playerId: string } };
type Answer = Extract<HubMsg, { t: 'spawn' | 'ride-no' }>;

/** Asks to ride and returns the answer: a `spawn` or a `ride-no`. */
async function rideOf(p: Who): Promise<Answer> {
  p.c.send({ t: 'ride' });
  const answer = (await flush(p.c)).find((m) => m.t === 'spawn' || m.t === 'ride-no');
  return must(answer) as Answer;
}
const why = async (p: Who) => (await rideOf(p)).why;
/** Anchors the binding at (x, y) and reports there; resolves with the `near` answer. */
async function standAt(p: Who, x: number, y: number) {
  await anchorAt(p.id.playerId, x, y);
  p.c.send({ t: 'where', x, y, ...STARTER });
  return nextOf(p.c, 'near');
}
/** A player alone far out for the full wait, its creature in the water there. */
async function lonely(p: Who) {
  expect((await standAt(p, FAR.x, FAR.y)).peers).toEqual([]);
  await advance(RIDE_ALONE_MS);
}
const memberOf = (p: Who) =>
  authority(
    (o) =>
      must(o.directory.member(p.id.playerId)) as { x: number; y: number; r: number; aoi: number },
  );
/** Puts the player in the directory at (x, y) as the hub's own word, with no `near` (so never seen alone). */
const inDirectory = (p: Who, x: number, y: number) =>
  authority((o) =>
    o.directory.report({ id: p.id.playerId, name: 'p', x, y, ...STARTER, t: clock.t }),
  );
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y);
const p1Reach = (a: { r: number }, b: { r: number }) =>
  INTERACT_RADII * Math.max(a.r, b.r) + INTERACT_LEAD_WU;

describe('the refusals, in their order', () => {
  it('refuses a creature in a lock `locked`, before anything else', async () => {
    const [a, b] = await pair();
    await lonely(a);
    a.c.send({
      t: 'engage',
      target: b.id.playerId,
      mine: snap(a, ...NEAR.a),
      theirs: snap(b, ...NEAR.b),
    });
    await nextOf(b.c, 'lock-ask');
    expect(await why(a)).toBe('locked');
    expect(await why(b)).toBe('locked');
  });

  it('refuses a court outstanding `busy`, either side, before the wait', async () => {
    const [a, b] = await pair();
    await lonely(a);
    await editSession(a, (s) => ({
      ...s,
      court: {
        ask: {
          v: 1,
          kind: 'mate',
          creature: a.creature,
          partner: b.id.playerId,
          partnerCreature: b.creature,
          nonce: 'n',
          sig: 's',
        },
        sentAt: Date.now(),
      },
    }));
    expect(await why(a)).toBe('busy');
    expect(await why(b)).toBe('busy');
  });

  it('refuses `soon` while alone under the wait, then `none` with nobody to ride to', async () => {
    const a = await hatched();
    expect((await standAt(a, FAR.x, FAR.y)).peers).toEqual([]);
    expect(await why(a)).toBe('soon');
    await advance(RIDE_ALONE_MS - 1);
    expect(await why(a)).toBe('soon');
    await advance(1);
    expect(await why(a)).toBe('none');
  });

  it('refuses `soon` within 120 s of the last fight, however long alone', async () => {
    const [a, b] = await fighters();
    await killB(a, b);
    const ended = must(await authority((o) => o.fights.lastFightEnd(a.id.playerId)));
    // A has been alone far out for a long time, by the hub's word.
    await inDirectory(a, FAR.x, FAR.y);
    await editSession(a, (s) => ({ ...s, aloneSince: clock.t - 10 * RIDE_ALONE_MS }));
    expect(await why(a)).toBe('soon');
    await advanceTo(ended + RIDE_AFTER_FIGHT_MS - 1);
    expect(await why(a)).toBe('soon');
    await advance(1);
    expect(await why(a)).toBe('none');
  });

  it('refuses `company` when the directory places a linkable member within its Q now', async () => {
    const [a, b] = await pair();
    await lonely(a);
    // B arrives 1,000 wu off after A's last report: the hub judges by the directory now.
    await standAt(b, FAR.x + 1000, FAR.y);
    expect(await why(a)).toBe('company');
    // And a creature in the water that the hub has never seen alone is `soon`, not ridden off.
    const c = await join();
    await inDirectory(c, FAR.x - 30_000, FAR.y);
    expect(await why(c)).toBe('soon');
  });

  it('honours `RIDE_ALONE_MS` in fixture mode only, from 1,000 ms', () => {
    const fixture = (v: string) => rideAloneMsOf({ DRAND_SOURCE: 'fixture', RIDE_ALONE_MS: v });
    expect(fixture('3000')).toBe(3000);
    expect(fixture('999')).toBe(RIDE_ALONE_MS);
    expect(fixture('1.5e3')).toBe(1500);
    expect(rideAloneMsOf({ RIDE_ALONE_MS: '3000' })).toBe(RIDE_ALONE_MS);
  });
});

describe('a granted ride', () => {
  /** A placed in the water by the hub with its protection over, and B alone far out for the wait. */
  async function setUp(): Promise<[Player, Player]> {
    const [a, b] = await pair();
    const at = await spawned(a);
    a.c.send({ t: 'where', x: at.x, y: at.y, ...STARTER });
    await nextOf(a.c, 'near');
    await advance(16_000);
    await lonely(b);
    return [a, b];
  }

  it('lands by the group, protected, and a report there is taken', async () => {
    const [a, b] = await setUp();
    const rows = await rowsWritten();
    const there = await rideOf(b);
    expect(there).toMatchObject({ t: 'spawn', why: 'ride', protect: true });
    if (there.t !== 'spawn') return;
    const [ma, mb] = [await memberOf(a), await memberOf(b)];
    // In the directory at its arrival at once, as a spawn's answer puts it.
    expect(mb).toMatchObject({ x: there.x, y: there.y });
    expect(dist(mb, ma)).toBeGreaterThanOrEqual(clearance(ma, mb) - 1e-6);
    expect(dist(mb, ma)).toBeLessThanOrEqual(p1Reach(ma, mb));
    expect(await rowsWritten()).toBe(rows);
    // The first report at the arrival lies by its anchor: taken, and A is near now.
    await advance(1000);
    b.c.send({ t: 'where', x: mb.x + 100, y: mb.y, ...STARTER });
    const near = await nextOf(b.c, 'near');
    expect(near.peers.map((p) => p.id)).toContain(a.id.playerId);
    // Pressing again with A near: `company`.
    expect(await why(b)).toBe('company');
    expect(await rowsWritten()).toBe(rows);
  });

  it('protects the rider for 15 s: an engage 10 s after the ride is refused', async () => {
    const [a, b] = await setUp();
    expect(await rideOf(b)).toMatchObject({ why: 'ride', protect: true });
    await advance(10_000);
    expect(await refusal(a, b, snap(b, ...NEAR.b), snap(a, ...NEAR.a))).toBe('engage:protected');
  });

  it('drops a first report far from the arrival', async () => {
    const [, b] = await setUp();
    expect(await rideOf(b)).toMatchObject({ why: 'ride' });
    await advance(1000);
    const before = await authority((o) => o.dropped.get('where') ?? 0);
    // Back where it was: past the anchor's bound.
    b.c.send({ t: 'where', ...FAR, ...STARTER });
    expect((await flush(b.c)).some((m) => m.t === 'near')).toBe(false);
    expect(await authority((o) => o.dropped.get('where') ?? 0)).toBe(before + 1);
  });
});
