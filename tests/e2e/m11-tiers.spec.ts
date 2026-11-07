import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, type TestInfo, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { PRESETS } from '../../src/render/presets';
import { state } from './helpers';
import { CENTRE, closeAll, directory, join, linksAre, type Player, place } from './m11-steps';

// M11 T17: the tiers. A stays a starter (T0), B grows to T1 and C to T2, all within 2,000 wu. A–B
// and B–C link (±1 tier); A and C never do. C, the giant, sees A only as a faint swarm the
// directory reports, and A draws nothing of C. C's view scales its look and stays within medium's
// budget, and a screenshot of each view is attached.

const HUB = 'http://localhost:8831';

test.describe.configure({ mode: 'serial' });
// The screenshots judge the picture, so the giant's page draws on medium (the others on low).
test.use({ storageState: { cookies: [], origins: [] } });

/** Counts, every 100 ms, the times `p` holds a link whose hello passed with `other`. */
const watchNoLink = (p: Player, other: string) =>
  p.page.evaluate((id) => {
    const w = window as unknown as { __linkedTo?: number };
    w.__linkedTo = 0;
    window.setInterval(() => {
      const links = (window.__bs as BsHook).state().net.links;
      if (links.some((l) => l.id === id && l.hello)) w.__linkedTo = (w.__linkedTo ?? 0) + 1;
    }, 100);
  }, other);

const linkedCount = (p: Player) =>
  p.page.evaluate(() => (window as unknown as { __linkedTo: number }).__linkedTo);

const info = (p: Player) => p.page.evaluate(() => (window.__bs as BsHook).render.info());

/** Attaches a shot of `p`'s view to the report and keeps it as `test-results/<name>.png`. */
async function shoot(testInfo: TestInfo, p: Player, name: string): Promise<void> {
  const png = await p.page.screenshot();
  mkdirSync('test-results', { recursive: true });
  writeFileSync(`test-results/${name}.png`, png);
  await testInfo.attach(name, { body: png, contentType: 'image/png' });
}

test('a starter, a T1 and a T2 link only within a tier of each other, and the giant sees the starter as a swarm @slow', async ({
  browser,
}, testInfo) => {
  test.setTimeout(300_000);
  const players: Player[] = [];
  try {
    // The giant first, grown to T2 before anyone else hatches, so the starter never links it.
    const c = await join(browser, HUB, '&quality=medium');
    players.push(c);
    await c.page.evaluate(() => (window.__bs as BsHook).debug?.setBiomass(20_000));
    const b = await join(browser, HUB, '&quality=low');
    players.push(b);
    await b.page.evaluate(() => (window.__bs as BsHook).debug?.setBiomass(4000));
    const a = await join(browser, HUB, '&quality=low');
    players.push(a);
    await watchNoLink(a, c.id);
    await watchNoLink(c, a.id);

    await place(a, 0, 0);
    await place(b, 500, 0);
    await place(c, 1100, 300);
    // A grows within T0: its view widens by more than a quarter, so it reports its new place.
    await a.page.evaluate(() => (window.__bs as BsHook).debug?.setBiomass(380));
    await expect
      .poll(
        async () => {
          const m = (await directory(a.page.request, HUB)).members.find((x) => x.id === a.id);
          return m ? Math.hypot(m.x - CENTRE, m.y - CENTRE) : Number.POSITIVE_INFINITY;
        },
        { message: 'the directory holds A at its new place', timeout: 30_000, intervals: [250] },
      )
      .toBeLessThan(50);
    // C grows on to 70,000 (still T2): its view widens too, and the answer to its report lists A
    // in its swarm.
    await c.page.evaluate(() => (window.__bs as BsHook).debug?.setBiomass(70_000));

    await linksAre(a, [b.id], 'A links B alone', 60_000);
    await linksAre(b, [a.id, c.id], 'B links A and C', 60_000);
    await linksAre(c, [b.id], 'C links B alone', 60_000);

    await expect
      .poll(async () => (await info(c)).swarms, {
        message: 'C draws A as a swarm',
        timeout: 30_000,
        intervals: [250],
      })
      .toBeGreaterThanOrEqual(1);
    // The clouds fade in over a second: shoot once they are fully there.
    await c.page.waitForTimeout(1500);

    // A draws no C: not as a creature (nothing links them) and not as a swarm (C is bigger).
    const seenByA = await state(a.page);
    expect(seenByA.remotes.map((r) => r.id)).not.toContain(c.id);
    const aInfo = await info(a);
    expect(aInfo.swarms).toBe(0);
    expect(aInfo.look).toBe(1);

    // C's look scales with its view (radius 264.6: about 10× a starter adult's), within medium's budget.
    const cInfo = await info(c);
    expect(cInfo.preset).toBe('medium');
    expect(cInfo.look).toBeGreaterThan(8);
    const budget = PRESETS.medium.budget;
    expect(cInfo.calls).toBeLessThanOrEqual(budget.calls);
    expect(cInfo.triangles).toBeLessThanOrEqual(budget.triangles);
    expect(cInfo.targetBytes).toBeLessThanOrEqual(budget.targetBytes);

    await shoot(testInfo, a, 'm11-tiers-a-t0');
    await shoot(testInfo, b, 'm11-tiers-b-t1');
    await shoot(testInfo, c, 'm11-tiers-c-t2');

    expect(await linkedCount(a), 'A never links C').toBe(0);
    expect(await linkedCount(c), 'C never links A').toBe(0);
  } finally {
    await closeAll(players);
  }
});
