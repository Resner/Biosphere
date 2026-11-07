import { expect, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { closeAll, join, linked, linksAre, type Player, place } from './m11-steps';

// M11 T13: the cap under the area of interest. A holds a cap of 2 (`debug.netCap`): B beside it can
// interact (P1, never dropped), and of C and D, 3,000 wu off (P4), A holds the nearer. When D swims
// up beside A it becomes P1, and C, the worst P4, gives up its place.

const HUB = 'http://localhost:8829';

test.describe.configure({ mode: 'serial' });

test('a cap of 2 holds the creature that can interact and the nearer far one, and a newcomer beside A takes the far one’s place @slow', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const players: Player[] = [];
  try {
    for (let i = 0; i < 4; i++) players.push(await join(browser, HUB));
    const [a, b, c, d] = players as [Player, Player, Player, Player];
    await a.page.evaluate(() => (window.__bs as BsHook).debug?.netCap(2));
    await place(a, 0, 0);
    await place(b, 120, 0);
    await place(c, 3000, 0);
    await place(d, -3300, 0);

    // The links settle once A has seen everyone's new place (at the spawn all four can interact):
    // B as P1 and C as P4, and nothing else.
    const settled = async () =>
      (await a.page.evaluate(() => (window.__bs as BsHook).state().net.links))
        .filter((l) => l.hello)
        .map((l) => [l.id, l.class])
        .sort();
    await expect
      .poll(settled, {
        message: 'A holds B (P1) and C (P4), the nearer of C and D',
        timeout: 60_000,
      })
      .toEqual(
        [
          [b.id, 1],
          [c.id, 4],
        ].sort(),
      );
    // From here on B must never leave A's links.
    await a.page.evaluate((idB) => {
      const w = window as unknown as { __lostB?: number; __watch?: number };
      w.__lostB = 0;
      w.__watch = window.setInterval(() => {
        const links = (window.__bs as BsHook).state().net.links;
        if (!links.some((l) => l.id === idB && l.hello)) w.__lostB = (w.__lostB ?? 0) + 1;
      }, 100);
    }, b.id);

    // D swims up beside A: P1 now, so C, the worst P4, goes.
    await place(d, -120, 60);
    await linksAre(a, [b.id, d.id], 'D takes C’s place beside A', 60_000);
    // C keeps asking now and then; A keeps refusing it.
    await a.page.waitForTimeout(6000);
    expect(await linked(a)).toEqual([b.id, d.id].sort());
    const lost = await a.page.evaluate(() => (window as unknown as { __lostB: number }).__lostB);
    expect(lost, 'B is never evicted').toBe(0);
    expect(await a.page.evaluate(() => (window.__bs as BsHook).state().net.crowded)).toBe(false);
  } finally {
    await closeAll(players);
  }
});
