import { type Browser, expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { INTERPOLATION_MS } from '../../src/net/pond-sync';
import { chatTexts, hatch, openGame, openMenu, say, state } from './helpers';

// The milestone's end-to-end check: three real browser contexts share a pond through the local
// Worker and real WebRTC (host candidates only). Smaller pieces have their own specs: the offline
// chip in m2-online, chat details in m2-social, the 24-peer mesh in peer-mesh.test.ts.

// Its own hub (see playwright.config.ts), so other specs' ponds stay as they count them.
const HUB = 'http://localhost:8789';

// One hub, and it fills the fullest pond first: one scenario at a time.
test.describe.configure({ mode: 'serial' });

async function joinThree(browser: Browser): Promise<[Page, Page, Page]> {
  const pages: Page[] = [];
  for (let i = 0; i < 3; i++) {
    const page = await (await browser.newContext()).newPage();
    await openGame(page, `?debug=1&hub=${HUB}`);
    await page.waitForFunction(() => window.__bs?.state().playerId);
    // One after the other: a hatch waits for its hub welcome, and all land in one pond.
    await hatch(page);
    pages.push(page);
  }
  for (const page of pages) {
    await page.waitForFunction(() => window.__bs?.state().remotes.length === 2, undefined, {
      timeout: 5000,
    });
  }
  return pages as [Page, Page, Page];
}

/** Distances between consecutive samples. */
const stepsOf = (samples: Sample[]) =>
  samples.slice(1).map((s, i) => {
    const prev = samples[i] as Sample;
    return Math.hypot(s.x - prev.x, s.y - prev.y);
  });

const nearestInTime = (samples: Sample[], t: number) =>
  samples.reduce((best, s) => (Math.abs(s.t - t) < Math.abs(best.t - t) ? s : best));

const closeAll = (pages: Page[]) => Promise.all(pages.map((p) => p.context().close()));

interface Sample {
  t: number;
  x: number;
  y: number;
}

/** Records a position every ~33 ms (wall clock) until `stopSeries` returns the samples. */
function recordSeries(page: Page, who: 'self' | string): Promise<void> {
  return page.evaluate((who) => {
    const w = window as unknown as { __series?: { samples: Sample[]; timer: number } };
    const samples: Sample[] = [];
    const timer = window.setInterval(() => {
      const s = (window.__bs as BsHook).state();
      const p = who === 'self' ? s.player : s.remotes.find((r) => r.id === who);
      if (p) samples.push({ t: Date.now(), x: p.x, y: p.y });
    }, 33);
    w.__series = { samples, timer };
  }, who);
}

function stopSeries(page: Page): Promise<Sample[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __series: { samples: Sample[]; timer: number } };
    clearInterval(w.__series.timer);
    return w.__series.samples;
  });
}

test('three players see each other move smoothly, share food and chat @slow', async ({
  browser,
}) => {
  // Three software-GL browsers take 21–29 s; the online and social specs get 60 s too.
  test.setTimeout(60_000);
  const [a, b, c] = await joinThree(browser);
  try {
    const [sa, sb, sc] = await Promise.all([a, b, c].map(state));
    if (!sa?.playerId || !sb?.playerId || !sc) throw new Error('three states expected');
    expect(sb.pond?.id).toBe(sa.pond?.id);
    expect(sc.pond?.id).toBe(sa.pond?.id);

    // A steers in a circle at full throttle for 5 s while B records what it sees of A.
    await Promise.all([recordSeries(a, 'self'), recordSeries(b, sa.playerId)]);
    const { width, height } = a.viewportSize() ?? { width: 960, height: 540 };
    const [cx, cy] = [width / 2, height / 2];
    const started = Date.now();
    while (Date.now() - started < 5000) {
      const angle = ((Date.now() - started) / 5000) * Math.PI * 2 * 1.5;
      await a.mouse.move(cx + 220 * Math.cos(angle), cy + 220 * Math.sin(angle));
      await a.waitForTimeout(50);
    }
    const [own, seen] = await Promise.all([stopSeries(a), stopSeries(b)]);
    expect(own.length).toBeGreaterThan(10); // a slow runner samples far below 30 Hz
    expect(seen.length).toBeGreaterThan(10);

    // No jumps in what B draws, and a small mean error against A's own positions at the same time.
    // The samples come off a wall-clock timer, so a busy runner leaves gaps and a step grows with its
    // gap: a jump is a step beyond 25 plus what A's own top speed covers in the time over 66 ms.
    const top = Math.max(
      ...own.slice(1).map((s, i) => {
        const prev = own[i] as Sample;
        return Math.hypot(s.x - prev.x, s.y - prev.y) / Math.max(1, s.t - prev.t);
      }),
    );
    const excess = seen.slice(1).map((s, i) => {
      const prev = seen[i] as Sample;
      const allowed = 25 + 1.25 * top * Math.max(0, s.t - prev.t - 66);
      return Math.hypot(s.x - prev.x, s.y - prev.y) - allowed;
    });
    expect(Math.max(...excess), 'no step beyond what the time between samples allows').toBeLessThan(
      0,
    );
    const errors = seen.map((s) => {
      // B draws A as it was INTERPOLATION_MS ago, by design; the error is against that moment.
      const o = nearestInTime(own, s.t - INTERPOLATION_MS);
      return Math.hypot(s.x - o.x, s.y - o.y);
    });
    expect(errors.reduce((sum, e) => sum + e, 0) / errors.length).toBeLessThan(12);
    // A really moved, or the bounds above prove nothing.
    expect(stepsOf(own).reduce((sum, d) => sum + d, 0)).toBeGreaterThan(10);

    // After the run, every remote sits near where its owner says it is.
    await a.mouse.move(cx, cy);
    await a.waitForTimeout(600);
    const everyone = await Promise.all([a, b, c].map(state));
    for (const watcher of everyone) {
      for (const remote of watcher.remotes) {
        const owner = everyone.find((s) => s.playerId === remote.id)?.player;
        expect(Math.hypot(remote.x - (owner?.x ?? 1e9), remote.y - (owner?.y ?? 1e9))).toBeLessThan(
          40,
        );
      }
    }

    // Only the contested item counts: a cell given a bite back is hungry again and may eat a
    // neighbour, which says nothing about who holds the contested one.
    const bitesKept = (p: Page, id: string) =>
      p.evaluate((id) => {
        const e = (window.__bs as BsHook).events();
        return (e[`eat@${id}`] ?? 0) - (e[`stolen@${id}`] ?? 0);
      }, id);
    // A and B reach the same item at once: exactly one of them keeps it, and C loses it.
    const item = await a.evaluate(() => {
      const bs = window.__bs as BsHook;
      bs.debug?.setEnergy(10);
      return bs.debug?.nearestFood() ?? null;
    });
    expect(item).toBeTruthy();
    const { id, x, y } = item as { id: string; x: number; y: number };
    await c.evaluate(
      ({ x, y }) => {
        const debug = (window.__bs as BsHook).debug;
        debug?.setEnergy(1e9); // a full cell does not eat
        debug?.teleport(x + 60, y);
      },
      { x, y },
    );
    await c.waitForFunction((id) => (window.__bs as BsHook).debug?.hasFood(id) === true, id);
    await b.evaluate(() => (window.__bs as BsHook).debug?.setEnergy(10));
    await Promise.all(
      [a, b].map((p) =>
        p.evaluate(({ x, y }) => (window.__bs as BsHook).debug?.teleport(x, y), { x, y }),
      ),
    );
    // Three software-GL browsers on a busy runner tick slowly; the claims need a few frames.
    await c.waitForFunction((id) => (window.__bs as BsHook).debug?.hasFood(id) === false, id, {
      timeout: 6000,
    });
    // Count the bites each keeps (eaten minus given back). The loser's "stolen" event travels over
    // the channel, so wait for the count to settle at one, then check that it holds.
    const gained = async () => (await bitesKept(a, id)) + (await bitesKept(b, id));
    await expect.poll(gained, { timeout: 5000 }).toBe(1);
    await a.waitForTimeout(500);
    expect(await gained()).toBe(1);

    // Chat reaches both others; a muted sender does not reach B.
    await say(a, 'hello pond');
    for (const p of [b, c]) {
      await p.waitForFunction(() => window.__bs?.state().social.chat.length === 1, undefined, {
        timeout: 2000,
      });
      expect(await chatTexts(p)).toEqual(['hello pond']);
    }
    const aName = sb.remotes.find((r) => r.id === sa.playerId)?.name ?? '';
    await openMenu(b);
    await b.getByTestId('roster').getByRole('button', { name: aName }).click();
    expect((await state(b)).social.muted).toEqual([sa.playerId]);
    await say(a, 'still there?');
    await c.waitForFunction(() => window.__bs?.state().social.chat.length === 2, undefined, {
      timeout: 2000,
    });
    await b.waitForTimeout(500);
    expect(await chatTexts(b)).toEqual([]);
  } finally {
    await closeAll([a, b, c]);
  }
});

test('a closed tab drops out of the pond and a reload comes back to it @slow', async ({
  browser,
}) => {
  const [a, b, c] = await joinThree(browser);
  try {
    const [sa, sc] = await Promise.all([a, c].map(state));
    const aId = sa?.playerId as string;

    // A closes the tab: B and C drop A within 6 s.
    await a.close();
    for (const p of [b, c]) {
      await p.waitForFunction((id) => !window.__bs?.state().remotes.some((r) => r.id === id), aId, {
        timeout: 6000,
      });
    }

    // C reloads with the same keypair: its old session ends, the pond has room, so it returns to it.
    await c.reload();
    await c.waitForFunction(() => window.__bs?.ready === true);
    await c.waitForFunction(() => window.__bs?.state().pond !== null, undefined, {
      timeout: 10_000,
    });
    expect((await state(c)).playerId).toBe(sc?.playerId);
    expect((await state(c)).pond?.id).toBe(sc?.pond?.id);
    await hatch(c);
    await c.waitForFunction(() => window.__bs?.state().remotes.length === 1, undefined, {
      timeout: 10_000,
    });
  } finally {
    await closeAll([a, b, c]);
  }
});
