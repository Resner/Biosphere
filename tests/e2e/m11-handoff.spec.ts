import { expect, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { AOI_PER_HALF_HEIGHT } from '../../src/net/aoi';
import { state } from './helpers';
import { CENTRE, closeAll, directory, join, type Player, place } from './m11-steps';

// M11 T13: seamless handoffs. The hub splits leaves above two members (`LEAF_MAX=2`), so the root
// is four quadrants. A steers 3,000 wu diagonally past the world's centre, across both quadrant
// edges, with B following, while C, 10,000 wu ahead on A's line, swims toward A. A reports at each
// leaf it leaves, A–B never closes, A and C link while still more than twice A's AoI apart (so
// before C can come into A's view), and every remote in A's view stays fully drawn.

const HUB = 'http://localhost:8828';

test.describe.configure({ mode: 'serial' });

/** A's path: from S to E, crossing y = centre at x = centre − 300 and then x = centre at y = centre + 300. */
const S = { x: -1600, y: -1300 };
const E = { x: 1400, y: 1700 };
const DIAG = Math.SQRT1_2;

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
}

test('crossing leaves keeps every link in view, and a creature ahead is linked before it comes into view @slow', async ({
  browser,
  request,
}) => {
  test.setTimeout(300_000);
  const players: Player[] = [];
  try {
    for (let i = 0; i < 3; i++) players.push(await join(browser, HUB));
    const [a, b, c] = players as [Player, Player, Player];
    await place(a, S.x, S.y);
    await place(b, S.x - 150, S.y - 150);
    await place(c, S.x + 10_000 * DIAG, S.y + 10_000 * DIAG);
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
          }
          if (!links.includes(idB)) watch.lostB++;
          const remoteC = s.remotes.find((r) => r.id === idC);
          if (!watch.cLinked && links.includes(idC) && remoteC && me) {
            watch.cLinked = {
              d: Math.hypot(remoteC.x - me.x, remoteC.y - me.y),
              aoi: perHalfHeight * fx.halfHeight,
            };
          }
          // A leaf change with A outside the leaf it held is an exit (a split or merge keeps A inside).
          const leaf = s.net.where.leaf;
          const sent = s.net.where.sent;
          const held = watch.leaf;
          const same =
            leaf && held && leaf.x === held.x && leaf.y === held.y && leaf.size === held.size;
          if (leaf && me && !same) {
            if (held) {
              const dx = Math.max(held.x - me.x, 0, me.x - (held.x + held.size));
              const dy = Math.max(held.y - me.y, 0, me.y - (held.y + held.size));
              if (Math.hypot(dx, dy) > 32) watch.exits.push({ before: held.sent, after: sent });
            }
            watch.leaf = { ...leaf, sent };
          }
        }, 100);
      },
      { idB: b.id, idC: c.id, perHalfHeight: AOI_PER_HALF_HEIGHT },
    );
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
      const cAt = (await state(c.page)).player;
      if (cAt && Math.hypot(cAt.x - me.x, cAt.y - me.y) > 300)
        await steer(c, me.x - CENTRE, me.y - CENTRE);
      await a.page.waitForTimeout(1000);
    }
    expect(crossed, 'A reached the end of its path').toBe(true);

    const watch = await a.page.evaluate(() => (window as unknown as { __watch: Watch }).__watch);
    // Each leaf A left brought a report: the count rose before A was inside a leaf again.
    const exits = JSON.stringify(watch.exits);
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
  } finally {
    await closeAll(players);
  }
});
