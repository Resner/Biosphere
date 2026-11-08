import { expect, test } from '@playwright/test';
import { BUSY_TEXT } from '../../src/game/crowd-view';
import type { BsHook } from '../../src/game/debug';
import { closeAll, directory, join, linksAre, type Player, place } from './m11-steps';

// M12 T6: crowd instances in the page. The hub (8834) fills an instance with 2 (`INSTANCE_MAX`)
// and merges a crowd quiet for 3 s (`QUIET_MS`); `LEAF_MAX=2` keeps its leaves small, so a page
// that swims out reports at once. Four pages crowd at 3 links (`debug.crowdAt(3)`), in a row: B,
// A, C, D. A and B are 50 wu apart, as are C and D (each pair inside the other's crowd list, 8 ×
// the larger radius), and A and C 130 wu apart (outside it, and inside A's view), so all four link
// first. The hub splits them into {A, B} and {C, D}; in A's view C and D fade out over a second,
// with the busy toast; D and then C swim out to the open water, and the crowd, down to A and B,
// merges.

const HUB = 'http://localhost:8834';

test.describe.configure({ mode: 'serial' });

/** A page's own instance (`state().net.instance.n`). */
const instanceOf = (p: Player) =>
  p.page.evaluate(() => (window.__bs as BsHook).state().net.instance.n);

interface Sample {
  t: number;
  c: number;
  d: number;
}

test('a crowd splits into instances, the others fade out of view, and the crowd merges once quiet @slow', async ({
  browser,
  request,
}, testInfo) => {
  test.setTimeout(300_000);
  const players: Player[] = [];
  try {
    for (let i = 0; i < 4; i++) players.push(await join(browser, HUB));
    const [a, b, c, d] = players as [Player, Player, Player, Player];
    await place(a, 0, 0);
    await place(b, -50, 0);
    await place(c, 130, 0);
    await place(d, 180, 0);
    for (const p of players) {
      const others = players.filter((o) => o !== p).map((o) => o.id);
      await linksAre(p, others, 'all four link before any crowds', 60_000);
    }
    // Every page draws the other three before they crowd.
    await expect
      .poll(
        () =>
          a.page.evaluate(
            (ids) =>
              ids.every(
                (id) =>
                  (window.__bs as BsHook).state().remotes.find((r) => r.id === id)?.alpha === 1,
              ),
            [c.id, d.id],
          ),
        { message: 'A draws C and D in full', timeout: 30_000 },
      )
      .toBe(true);
    for (const p of players) expect(await instanceOf(p)).toBe(0);

    // A samples C's and D's alpha every 100 ms from here on (a creature not drawn is 0).
    await a.page.evaluate(
      ([idC, idD]) => {
        const w = window as unknown as { __crowdSamples: Sample[] };
        w.__crowdSamples = [];
        const alpha = (id: string) =>
          (window.__bs as BsHook).state().remotes.find((r) => r.id === id)?.alpha ?? 0;
        window.setInterval(() => {
          w.__crowdSamples.push({ t: performance.now(), c: alpha(idC), d: alpha(idD) });
        }, 100);
      },
      [c.id, d.id] as const,
    );
    for (const p of players) await p.page.evaluate(() => (window.__bs as BsHook).debug?.crowdAt(3));

    // A leaves the open water: the shot catches C fading, beside the busy toast.
    await expect
      .poll(() => instanceOf(a), {
        message: 'A is in an instance',
        timeout: 20_000,
        intervals: [100],
      })
      .not.toBe(0);
    await testInfo.attach('m12-crowd-fade', {
      body: await a.page.screenshot(),
      contentType: 'image/png',
    });
    await expect(a.page.getByTestId('toast')).toBeVisible();
    await expect(a.page.getByTestId('toast')).toHaveText(BUSY_TEXT);
    // The split: {A, B} in one instance and {C, D} in another.
    const split = async () => {
      const [na, nb, nc, nd] = await Promise.all(players.map(instanceOf));
      return na !== 0 && nc !== 0 && na === nb && nc === nd && na !== nc;
    };
    await expect
      .poll(split, {
        message: 'the hub splits the four into {A, B} and {C, D}',
        timeout: 10_000,
        intervals: [100],
      })
      .toBe(true);
    const view = await directory(request, HUB);
    const nOf = (id: string) => view.members.find((m) => m.id === id)?.n;
    expect(nOf(a.id)).toBe(nOf(b.id));
    expect(nOf(c.id)).toBe(nOf(d.id));
    expect(nOf(a.id)).not.toBe(nOf(c.id));
    const shown = await a.page.evaluate(() => (window.__bs as BsHook).state().net.instance);
    expect(shown.changes).toBe(1);
    expect(shown.crowdSent).toBeGreaterThanOrEqual(1);

    // A then holds a link to B alone.
    await linksAre(a, [b.id], 'A holds B alone once the crowd splits', 10_000);
    // The fade: C and D go from 1 to 0 over at least 0.8 s, never in one step.
    await expect
      .poll(
        () =>
          a.page.evaluate(() => {
            const s = (window as unknown as { __crowdSamples: Sample[] }).__crowdSamples;
            const last = s[s.length - 1];
            return last !== undefined && last.c === 0 && last.d === 0;
          }),
        { message: 'C and D faded out of A’s view', timeout: 10_000 },
      )
      .toBe(true);
    const samples = await a.page.evaluate(
      () => (window as unknown as { __crowdSamples: Sample[] }).__crowdSamples,
    );
    for (const who of ['c', 'd'] as const) {
      const gone = samples.findIndex((s) => s[who] === 0);
      expect(gone, `${who} reached 0`).toBeGreaterThan(0);
      let full = gone - 1;
      while (full >= 0 && (samples[full] as Sample)[who] < 0.999) full--;
      expect(full, `${who} was drawn in full before its fade`).toBeGreaterThanOrEqual(0);
      const between = samples.slice(full + 1, gone);
      expect(between.length, `${who} passed through partial alpha`).toBeGreaterThan(0);
      expect(between.every((s) => s[who] > 0 && s[who] < 1)).toBe(true);
      const span = (samples[gone] as Sample).t - (samples[full] as Sample).t;
      expect(span, `${who} faded over at least 0.8 s`).toBeGreaterThanOrEqual(800);
    }

    // D swims 6,000 wu out, back to the open water; then C does the same.
    await place(d, 6000, 0);
    await expect
      .poll(() => instanceOf(d), { message: 'D is back in the open water', timeout: 30_000 })
      .toBe(0);
    await place(c, -6000, 0);
    await expect
      .poll(() => instanceOf(c), { message: 'C is back in the open water', timeout: 30_000 })
      .toBe(0);
    // A and B's crowd, now two, merges once quiet.
    await expect
      .poll(async () => Promise.all([a, b].map(instanceOf)), {
        message: 'the crowd of A and B merges into the open water',
        timeout: 20_000,
      })
      .toEqual([0, 0]);
    await expect
      .poll(async () => (await directory(request, HUB)).crowds.length, {
        message: 'no crowd is left',
        timeout: 10_000,
      })
      .toBe(0);
  } finally {
    await closeAll(players);
  }
});
