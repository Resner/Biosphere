import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, type TestInfo, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { PRESETS } from '../../src/render/presets';
import { state } from './helpers';
import { closeAll, linksAre, type Player, place } from './m11-steps';
import {
  clearance,
  directory,
  dist,
  emptyWorld,
  joinRecorded,
  p1Reach,
  spawnOf,
} from './m12-steps';

// M12 T7: riding the current. A and B hatch, and B is teleported 40,000 wu out into the twilight.
// After 3 s alone (`debug.aloneMs(3000)`, the hub's `RIDE_ALONE_MS=3000`) B's hint offers the ride
// and B presses R: the transition plays (`riding`, then `arrived`), B lands outside A's clearance
// and within its P1 reach, protected, and the two link. R again reads "Someone is near". B plays on
// medium, and the transition keeps medium's budget; a frame mid-ride and one at the arrival are
// attached.

const HUB = 'http://localhost:8835';

test.describe.configure({ mode: 'serial' });
// The screenshots judge the picture, so B draws on medium (A on low).
test.use({ storageState: { cookies: [], origins: [] } });

/** What B's page saw while the ride played, frame by frame (installed before R). */
interface RideWatch {
  phases: string[];
  calls: number;
  triangles: number;
  targetBytes: number;
  preset: string;
  frames: number;
  shot: string | null;
}

async function attach(testInfo: TestInfo, name: string, png: Buffer): Promise<void> {
  mkdirSync('test-results', { recursive: true });
  writeFileSync(`test-results/${name}.png`, png);
  await testInfo.attach(name, { body: png, contentType: 'image/png' });
}

/**
 * Records, every frame after the app's own, the ride's phases as they change, the most the frames
 * of the transition drew, and the canvas of its frame nearest the turn (read in the frame that drew it).
 */
const watchRide = (p: Player) =>
  p.page.evaluate(() => {
    const w = {
      phases: [] as string[],
      calls: 0,
      triangles: 0,
      targetBytes: 0,
      preset: '',
      frames: 0,
      shot: null as string | null,
    };
    (window as unknown as { rideWatch: typeof w }).rideWatch = w;
    const started = performance.now();
    let riding: number | null = null;
    let nearest = Number.POSITIVE_INFINITY;
    const frame = () => {
      const bs = window.__bs as BsHook;
      const s = bs.state();
      if (s.ride.phase !== w.phases.at(-1)) w.phases.push(s.ride.phase);
      if (s.ride.phase === 'riding') {
        const info = bs.render.info();
        w.frames++;
        w.calls = Math.max(w.calls, info.calls);
        w.triangles = Math.max(w.triangles, info.triangles);
        w.targetBytes = Math.max(w.targetBytes, info.targetBytes);
        w.preset = info.preset;
        // The frame nearest the turn (0.6 s in), where the wash is strongest.
        const t = performance.now();
        riding ??= t;
        const off = Math.abs(t - riding - 600);
        if (off < nearest) {
          nearest = off;
          w.shot = (document.querySelector('canvas') as HTMLCanvasElement).toDataURL('image/png');
        }
      }
      if (s.ride.phase !== 'arrived' && performance.now() - started < 120_000) {
        requestAnimationFrame(frame);
      }
    };
    requestAnimationFrame(frame);
  });

const watched = (p: Player) =>
  p.page.evaluate(() => (window as unknown as { rideWatch: RideWatch }).rideWatch);

test('a lone player rides the current to the others, protected, and links on arrival @slow', async ({
  browser,
  request,
}, testInfo) => {
  test.setTimeout(300_000);
  await emptyWorld(request, HUB);
  const players: Player[] = [];
  try {
    const a = await joinRecorded(browser, HUB, '&quality=low');
    players.push(a);
    const b = await joinRecorded(browser, HUB, '&quality=medium');
    players.push(b);
    await linksAre(a, [b.id], 'A and B link after the hatch', 60_000);

    // B swims off 40,000 wu into the twilight: alone there, by the page's and the hub's word.
    await b.page.evaluate(() => (window.__bs as BsHook).debug?.aloneMs(3000));
    await place(b, 40_000, 0);
    await b.page.evaluate(() => (window.__bs as BsHook).debug?.setZone('twilight'));
    await linksAre(b, [], 'B is alone out there', 60_000);
    await expect
      .poll(async () => (await state(b.page)).ride.offered, {
        message: 'B’s hint offers the ride',
        timeout: 60_000,
        intervals: [200],
      })
      .toBe(true);
    await expect(b.page.getByTestId('ride-offer')).toBeVisible();
    await expect(b.page.getByTestId('ride-offer')).toContainText('Alone here.');
    await expect(b.page.getByTestId('ride-button')).toHaveText('Ride the current (R)');

    await watchRide(b);
    await b.page.keyboard.press('r');
    await expect
      .poll(async () => (await state(b.page)).ride.phase, {
        message: 'B’s ride arrives',
        timeout: 30_000,
        intervals: [100],
      })
      .toBe('arrived');
    const watch = await watched(b);
    expect(watch.phases, 'the ride is asked, plays and arrives').toEqual([
      'idle',
      'asking',
      'riding',
      'arrived',
    ]);
    const at = await spawnOf(b);
    expect(at).toMatchObject({ why: 'ride', protect: true });
    // At the arrival, give or take the current's drift since.
    const self = (await state(b.page)).player;
    expect(self && dist(self, at), 'B is at the arrival').toBeLessThan(300);

    // Where the hub put B: outside A's clearance, within its P1 reach.
    const view = await directory(request, HUB);
    const ma = view.members.find((m) => m.id === a.id);
    const note = view.spawns.find((s) => s.x === at.x && s.y === at.y);
    if (!ma || !note) throw new Error('the hub knows A and the ride’s arrival');
    expect(dist(at, ma), 'B lands outside A’s clearance').toBeGreaterThanOrEqual(
      clearance(note, ma) - 1e-6,
    );
    expect(dist(at, ma), 'B lands within A’s P1 reach').toBeLessThanOrEqual(p1Reach(note, ma));

    // A sees B arrive protected, and the two link (a ceiling for a slow runner: the harness times it).
    await expect
      .poll(async () => (await state(a.page)).remotes.find((r) => r.id === b.id)?.protected, {
        message: 'A sees B’s protection shimmer',
        timeout: 15_000,
        intervals: [100],
      })
      .toBe(true);
    await linksAre(a, [b.id], 'A links B after the ride', 20_000);
    await linksAre(b, [a.id], 'B links A after the ride', 20_000);
    await attach(testInfo, 'm12-ride-arrival', await b.page.screenshot());

    // The transition drew on medium within its budget; one frame of it, with the wash up, is attached.
    expect(watch.frames, 'frames drawn while riding').toBeGreaterThan(0);
    expect(watch.preset).toBe('medium');
    const budget = PRESETS.medium.budget;
    expect(watch.calls).toBeLessThanOrEqual(budget.calls);
    expect(watch.triangles).toBeLessThanOrEqual(budget.triangles);
    expect(watch.targetBytes).toBeLessThanOrEqual(budget.targetBytes);
    if (watch.shot) {
      await attach(testInfo, 'm12-ride-mid', Buffer.from(watch.shot.split(',')[1] ?? '', 'base64'));
    }

    // R again, with A near: the hub refuses, and the page says why.
    await b.page.keyboard.press('r');
    await expect(b.page.getByTestId('toast')).toHaveText('Someone is near', { timeout: 15_000 });
    expect((await state(b.page)).ride.last).toBe('company');
  } finally {
    await closeAll(players);
  }
});
