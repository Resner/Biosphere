import { expect, test } from '@playwright/test';
import { state } from './helpers';
import { CENTRE, closeAll, linksAre, type Player } from './m11-steps';
import {
  clearance,
  type DirectoryView,
  directory,
  dist,
  emptyWorld,
  joinRecorded,
  p1Reach,
  reloadAndResume,
  type Sized,
  spawnOf,
} from './m12-steps';

// M12 T4: the authority places every life. A hatches (a genesis) on the world's centre; B, C and D hatch one
// after another, each placed outside every earlier player's clearance (by the hub's directory) and
// every earlier spawn's, and within P1 reach of one of them, so each pair links at once. D reloads
// and comes back where it left the water, unprotected (M12 T10).

const HUB = 'http://localhost:8833';

test.describe.configure({ mode: 'serial' });

/** The directory's members, by player id. */
const membersOf = (view: DirectoryView) => new Map(view.members.map((m) => [m.id, m]));

test('the authority places each hatch around the others, and a reload comes back unprotected @slow', async ({
  browser,
  request,
}) => {
  test.setTimeout(300_000);
  await emptyWorld(request, HUB);
  const players: Player[] = [];
  try {
    const a = await joinRecorded(browser, HUB);
    players.push(a);
    expect(await spawnOf(a)).toEqual({ x: CENTRE, y: CENTRE, why: 'placed', protect: true });

    for (const name of ['B', 'C', 'D']) {
      // The hub placed by the directory as it stood at the spawn: read it on both sides of the hatch.
      const before = membersOf(await directory(request, HUB));
      const p = await joinRecorded(browser, HUB);
      const view = await directory(request, HUB);
      const after = membersOf(view);
      const at = await spawnOf(p);
      expect(at, `${name} is placed, protected`).toMatchObject({ why: 'placed', protect: true });
      // The hub's own note of this spawn: the size it placed by, and the time.
      const self = view.spawns.find((s) => s.x === at.x && s.y === at.y);
      if (!self) throw new Error(`the hub has no note of ${name}’s spawn`);
      for (const earlier of players) {
        const was = [before.get(earlier.id), after.get(earlier.id)].filter(
          (m): m is NonNullable<typeof m> => m !== undefined,
        );
        expect(was.length, `${name}: the hub knows ${earlier.id}`).toBeGreaterThan(0);
        expect(
          Math.max(...was.map((m) => dist(at, m) - clearance(self, m))),
          `${name} lies outside an earlier player’s clearance`,
        ).toBeGreaterThanOrEqual(-1e-6);
      }
      // The hub keeps each spawn's clearance for a minute (`SPAWN_RECENT_MS`).
      for (const s of view.spawns.filter((s) => s !== self && self.t - s.t < 60_000)) {
        expect(dist(at, s), `${name} keeps clear of an earlier spawn`).toBeGreaterThanOrEqual(
          clearance(self, s) - 1e-6,
        );
      }
      const reach = Math.min(
        ...players.map((q) => {
          const m = after.get(q.id) as Sized;
          return dist(at, m) - p1Reach(self, m);
        }),
      );
      expect(reach, `${name} lies within P1 reach of an earlier player`).toBeLessThanOrEqual(0);
      players.push(p);
      // Every pair links at once (the harness's gate 11 times it; here a ceiling for a slow runner).
      for (const q of players) {
        await linksAre(
          q,
          players.filter((o) => o !== q).map((o) => o.id),
          `${name}: every pair links`,
          20_000,
        );
      }
    }

    // D reloads: the resume comes back where it left the water (M12 T10), unprotected, and A sees
    // no shimmer on it.
    const d = players[3] as Player;
    const left = (await state(d.page)).player;
    await reloadAndResume(d);
    const back = await spawnOf(d);
    expect(back).toMatchObject({ why: 'back', protect: false });
    expect(dist(back, left), 'D comes back where it left').toBeLessThanOrEqual(300);
    expect(dist((await state(d.page)).player, left), 'D plays on from there').toBeLessThanOrEqual(
      300,
    );
    await expect
      .poll(async () => (await state(a.page)).remotes.find((r) => r.id === d.id)?.protected, {
        message: 'A sees D again, unprotected',
        timeout: 30_000,
      })
      .toBe(false);
  } finally {
    await closeAll(players);
  }
});
