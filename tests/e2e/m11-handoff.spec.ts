import { expect, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { AOI_PER_HALF_HEIGHT, INTERACT_HOLD_WU, INTERACT_RADII } from '../../src/net/aoi';
import { state } from './helpers';
import { CENTRE, closeAll, directory, join, type Player, place } from './m11-steps';

// M11 T13: seamless handoffs. The hub splits leaves above two members (`LEAF_MAX=2`), so the root
// is four quadrants. A steers 3,000 wu diagonally past the world's centre, across both quadrant
// edges, with B following, while C, 7,000 wu ahead on A's line, swims toward A. A reports at each
// leaf it leaves, A–B never closes, A and C link while still more than twice A's AoI apart (so
// before C can come into A's view), and every remote in A's view stays fully drawn.
// M11 T15: C sends to A at 2 Hz or less while far and at 10 Hz once near, and A never draws C
// faster than 1.2 × its snapshots' speed (`pace`).

const HUB = 'http://localhost:8828';

test.describe.configure({ mode: 'serial' });

/** A's path: from S to E, crossing y = centre at x = centre − 300 and then x = centre at y = centre + 300. */
const S = { x: -1600, y: -1300 };
const E = { x: 1400, y: 1700 };
const DIAG = Math.SQRT1_2;
/** C's start, along A's line from S. A covers 4,243 wu of it; a slow runner's C swims only a few wu/s,
 * so C starts near enough to reach A's view, and far enough to link while more than 2 AoI away. */
const C_AHEAD = 6_000;
/** C's budget to swim into A's view, in its own sim ticks (300 s of sim time). */
const NEAR_TICKS = 9_000;

interface Watch {
  /** Samples where a remote in A's view was drawn below full alpha. */
  faded: { id: string; alpha: number }[];
  /** Samples after B first linked in which B was not linked. */
  lostB: number;
  /** A–C distance and A's AoI when C first linked, and whether C was ever drawn in view before. */
  cLinked: { d: number; aoi: number } | null;
  cSeenUnlinked: boolean;
  /** Each new leaf A took on leaving its last one: the `where` count when it took the last, and the new. */
  exits: { before: number; after: number }[];
  /** The leaf A holds, and the `where` count when it took it. */
  leaf: { x: number; y: number; size: number; sent: number } | null;
  /** Every leaf A held, with where A was and the `where` count when it took it (for a failure's message). */
  path: string[];
  /** The rates A asked of C while C was in A's view, other than 10 Hz. */
  slowInView: number[];
}

/** C's link to A every 100 ms (M11 T15): the rate C sends A, the distance and how long linked. */
interface RateSample {
  hz: number;
  d: number;
  linkedMs: number;
}

test('crossing leaves keeps every link in view, and a creature ahead is linked before it comes into view @slow', async ({
  browser,
  request,
}) => {
  test.setTimeout(780_000);
  const players: Player[] = [];
  try {
    for (let i = 0; i < 3; i++) players.push(await join(browser, HUB));
    // Nothing here looks at a picture: three pages drawing in software take a slow runner's CPU
    // and memory, and a starved page plays no ticks (C swam 0 and 200 in 8 minutes).
    await Promise.all(
      players.map((p) => p.page.evaluate(() => (window.__bs as BsHook).debug?.skipDraw(true))),
    );
    const [a, b, c] = players as [Player, Player, Player];
    await place(a, S.x, S.y);
    await place(b, S.x - 150, S.y - 150);
    await place(c, S.x + C_AHEAD * DIAG, S.y + C_AHEAD * DIAG);
    await expect
      .poll(async () => (await state(a.page)).net.links.some((l) => l.id === b.id && l.hello), {
        message: 'A and B link',
        timeout: 60_000,
      })
      .toBe(true);
    await expect
      .poll(async () => (await directory(request, HUB)).leaves.length, {
        message: 'the hub splits its root',
        timeout: 60_000,
      })
      .toBeGreaterThanOrEqual(4);

    // A's watcher: every 100 ms, the remotes in its view, B's link, C's first link and its leaves.
    await a.page.evaluate(
      ({ idB, idC, perHalfHeight }) => {
        const w = window as unknown as { __watch: Watch };
        const watch: Watch = {
          faded: [],
          lostB: 0,
          cLinked: null,
          cSeenUnlinked: false,
          exits: [],
          leaf: null,
          path: [],
          slowInView: [],
        };
        w.__watch = watch;
        window.setInterval(() => {
          const bs = window.__bs as BsHook;
          const s = bs.state();
          const fx = bs.render.fx();
          const halfW = (fx.halfHeight * innerWidth) / innerHeight;
          const me = s.player;
          const links = s.net.links.filter((l) => l.hello).map((l) => l.id);
          for (const r of s.remotes) {
            const inView =
              Math.abs(r.x - fx.camX) <= halfW && Math.abs(r.y - fx.camY) <= fx.halfHeight;
            if (inView && r.alpha < 1) watch.faded.push({ id: r.id, alpha: r.alpha });
            if (inView && r.id === idC && !links.includes(idC)) watch.cSeenUnlinked = true;
            const wanted = s.net.links.find((l) => l.id === idC)?.wanted;
            if (inView && r.id === idC && wanted !== undefined && wanted !== 10)
              watch.slowInView.push(wanted);
          }
          if (!links.includes(idB)) watch.lostB++;
          const remoteC = s.remotes.find((r) => r.id === idC);
          if (!watch.cLinked && links.includes(idC) && remoteC && me) {
            watch.cLinked = {
              d: Math.hypot(remoteC.x - me.x, remoteC.y - me.y),
              aoi: perHalfHeight * fx.halfHeight,
            };
          }
          // A leaf change with A outside the leaf it held is an exit (a split keeps A inside).
          const leaf = s.net.where.leaf;
          const sent = s.net.where.sent;
          const held = watch.leaf;
          const same =
            leaf && held && leaf.x === held.x && leaf.y === held.y && leaf.size === held.size;
          if (leaf && me && !same) {
            if (held) {
              const dx = Math.max(held.x - me.x, 0, me.x - (held.x + held.size));
              const dy = Math.max(held.y - me.y, 0, me.y - (held.y + held.size));
              // Past the 64 wu slack A must have reported; just past the edge, a report that came
              // anyway (its 30 s) counts, and a split's message landing then does not.
              const out = Math.hypot(dx, dy);
              if (out > 64 || (out > 0 && sent > held.sent)) {
                watch.exits.push({ before: held.sent, after: sent });
              }
            }
            watch.leaf = { ...leaf, sent };
            watch.path.push(
              `${leaf.x - 131_072},${leaf.y - 131_072}/${leaf.size} @${Math.round(me.x - 131_072)},${Math.round(me.y - 131_072)} #${sent}`,
            );
          }
        }, 100);
      },
      { idB: b.id, idC: c.id, perHalfHeight: AOI_PER_HALF_HEIGHT },
    );
    // C's watcher: the rate it sends A, and how far A is.
    await c.page.evaluate((idA) => {
      const w = window as unknown as { __rates: RateSample[] };
      w.__rates = [];
      window.setInterval(() => {
        const s = (window.__bs as BsHook).state();
        const link = s.net.links.find((l) => l.id === idA && l.hello);
        const remoteA = s.remotes.find((r) => r.id === idA);
        if (!link || link.since === null || !remoteA || !s.player) return;
        w.__rates.push({
          hz: link.hz,
          d: Math.hypot(remoteA.x - s.player.x, remoteA.y - s.player.y),
          linkedMs: performance.now() - link.since,
        });
      }, 100);
    }, a.id);
    const sentBefore = (await state(a.page)).net.where.sent;

    // B follows A; A and C steer toward each other along the line.
    await b.page.evaluate(
      (id) => (window.__bs as BsHook).debug?.hover({ id, distance: 150 }),
      a.id,
    );
    const steer = (p: Player, dx: number, dy: number) =>
      p.page.evaluate(
        ([x, y]) => void (window.__bs as BsHook).debug?.steerTo({ x: x as number, y: y as number }),
        [CENTRE + dx, CENTRE + dy],
      );
    const deadline = Date.now() + 200_000;
    let crossed = false;
    while (Date.now() < deadline) {
      const sa = await state(a.page);
      const me = sa.player;
      if (!me) throw new Error('A has no creature');
      crossed = me.x - CENTRE >= E.x - 50 && me.y - CENTRE >= E.y - 50;
      const linkedC = sa.net.links.some((l) => l.id === c.id && l.hello);
      if (crossed && linkedC) break;
      // Steering targets a point ahead (a steer gives up after 30 s of sim time, so it is renewed).
      if (!crossed) await steer(a, E.x, E.y);
      // C waits unfed for as long as A's slower pages take to cross: its belly stays full, so it
      // is alive when its swim starts (it was found dead, with no tick played, after A crossed).
      await c.page.evaluate(() =>
        (window.__bs as BsHook).debug?.setEnergy(Number.MAX_SAFE_INTEGER),
      );
      const cState = await state(c.page);
      expect(cState.screen, 'C is alive while A crosses').not.toBe('dead');
      const cAt = cState.player;
      if (cAt && Math.hypot(cAt.x - me.x, cAt.y - me.y) > 300)
        await steer(c, me.x - CENTRE, me.y - CENTRE);
      await a.page.waitForTimeout(1000);
    }
    expect(crossed, 'A reached the end of its path').toBe(true);
    // C swims on into A's view (M11 T15: its rate there), and A's watcher keeps watching.
    // Its own budget: the way there took as long as a slow runner's ticks made it, and C still has
    // to swim the rest.
    // C's page plays far fewer ticks a second than A's on a loaded runner (C was still 1,549 wu away
    // after 300 s), so C swims on at four times the sim's pace, its belly full against the hunger.
    // The budget is C's own sim time: a loaded runner draws few frames, and a page plays only a
    // few ticks per frame, so how far C swims in a wall second is not the runner's to promise. Wall
    // time only bounds a hang.
    let nearSince: number | null = null;
    let lastD = Number.NaN;
    // A page that is not the front one may be throttled or not drawn at all: C swam 0 ticks in 8
    // minutes beside two pages that were polled as often.
    await c.page.bringToFront();
    const swumFrom = (await state(c.page)).tick;
    let swumTicks = 0;
    const nearDeadline = Date.now() + 480_000;
    while (Date.now() < nearDeadline && swumTicks < NEAR_TICKS) {
      const me = (await state(a.page)).player;
      const cState = await state(c.page);
      const cAt = cState.player;
      if (!me || !cAt) throw new Error('A or C has no creature');
      swumTicks = cState.tick - swumFrom;
      await c.page.evaluate(() => {
        const debug = (window.__bs as BsHook).debug;
        debug?.setEnergy(Number.MAX_SAFE_INTEGER);
        debug?.timeScale(4);
      });
      const d = Math.hypot(cAt.x - me.x, cAt.y - me.y);
      lastD = d;
      if (d > 120) {
        nearSince = null;
        await steer(c, me.x - CENTRE, me.y - CENTRE);
      } else {
        nearSince ??= Date.now();
        if (Date.now() - nearSince > 3000) break;
      }
      await a.page.waitForTimeout(500);
    }
    const cEnd = await c.page.evaluate(() => ({
      visibility: document.visibilityState,
      screen: (window.__bs as BsHook).state().screen,
    }));
    expect(
      nearSince,
      `C came into A’s view (last distance ${Math.round(lastD)} wu after ${swumTicks} of C’s ticks; C ${JSON.stringify(cEnd)})`,
    ).not.toBeNull();
    await c.page.evaluate(() => (window.__bs as BsHook).debug?.timeScale(1));

    const watch = await a.page.evaluate(() => (window as unknown as { __watch: Watch }).__watch);
    // Each leaf A left brought a report: the count rose before A was inside a leaf again.
    const exits = JSON.stringify({ exits: watch.exits, path: watch.path });
    expect(watch.exits.length, `A's leaf exits: ${exits}`).toBeGreaterThanOrEqual(2);
    for (const e of watch.exits)
      expect(e.after, `A's leaf exits: ${exits}`).toBeGreaterThan(e.before);
    expect((await state(a.page)).net.where.sent).toBeGreaterThan(sentBefore + 1);
    expect(watch.lostB, 'A–B never closes').toBe(0);
    expect(watch.cLinked, 'A and C link').not.toBeNull();
    const { d, aoi } = watch.cLinked as { d: number; aoi: number };
    expect(d, 'A and C link while more than twice A’s AoI apart').toBeGreaterThan(2 * aoi);
    expect(watch.cSeenUnlinked).toBe(false);
    expect(watch.faded, 'every remote in A’s view keeps an alpha of 1').toEqual([]);

    // M11 T15: far, C sends A 2 Hz or less (once A has asked: a link starts at 10 Hz); near, 10 Hz.
    expect(watch.slowInView, 'A asks 10 Hz of C while C is in its view').toEqual([]);
    const rates = await c.page.evaluate(
      () => (window as unknown as { __rates: RateSample[] }).__rates,
    );
    // Far: beyond P1's hold (a peer that could interact is asked for every snapshot, and stays P1
    // out to 8 radii + 900 wu), and beyond twice A's AoI.
    const radii = [
      (await state(a.page)).player?.radius ?? 0,
      (await state(c.page)).player?.radius ?? 0,
    ];
    const farFrom = Math.max(
      2 * aoi + 300,
      INTERACT_RADII * Math.max(...radii) + INTERACT_HOLD_WU + 100,
    );
    const far = rates.filter((r) => r.d > farFrom && r.linkedMs > 2000);
    const near = rates.filter((r) => r.d < 300);
    expect(far.length, 'C was linked to A while far').toBeGreaterThan(5);
    expect(near.length, 'C came near A').toBeGreaterThan(5);
    expect(
      far.filter((r) => r.hz > 2),
      'C sends A 2 Hz or less while far',
    ).toEqual([]);
    expect(
      near.filter((r) => r.hz !== 10),
      'C sends A 10 Hz once near',
    ).toEqual([]);
    // A draws C: a bounded wait on A's own frame (a loaded runner's C may have sent no snapshot for
    // a while when its time scale dropped back, and A draws only what it heard lately); the pace is
    // read from the frame that shows C.
    const drawnDeadline = Date.now() + 120_000;
    let drawnC: Awaited<ReturnType<typeof state>>['remotes'][number] | undefined;
    let lastA = await state(a.page);
    while (Date.now() < drawnDeadline) {
      lastA = await state(a.page);
      drawnC = lastA.remotes.find((r) => r.id === c.id);
      if (drawnC) break;
      await a.page.waitForTimeout(500);
    }
    expect(
      drawnC,
      `A draws C (A draws ${JSON.stringify(lastA.remotes.map((r) => ({ id: r.id, alpha: r.alpha })))}, links ${JSON.stringify(lastA.net.links.map((l) => ({ id: l.id, hello: l.hello })))})`,
    ).toBeDefined();
    expect(
      drawnC?.pace,
      'A never draws C faster than 1.2 × its snapshots’ speed',
    ).toBeLessThanOrEqual(1.2 + 1e-6);
  } finally {
    await closeAll(players);
  }
});
