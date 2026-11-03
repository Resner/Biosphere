import { expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { PRESETS } from '../../src/render/presets';
import { M7_LIFECYCLE_HUB as HUB, openRecorded, ripe, state } from './helpers';
import { fightToEnd, mate, stage } from './m7-fight';

// The M7 line in one scenario (@slow, release gate) at `?quality=medium`, on an authority with
// maturity in seconds: A and B hatch under protection (the shimmer shows, then goes), mate, so both
// carry an egg, and B resumes unprotected; A engages B with the combat HUD and the telegraphs up,
// and the fight runs to its end, whatever that is: both participants' hashes equal the referee's,
// every frame stayed within the medium budget, and the end reads as the outcome says (a kill names
// A on B's death screen and leaves B no pending child; an eaten egg is told; a survivor keeps its
// egg). Fights between hatched bodies end in many ways, so the kill with carrion (`m7-kill`,
// `m7-carrion`), the block (`m7-hud`), the three-way join (`m7-melee`) and the eaten egg of a
// survivor (sim and workerd tests) are covered by their own specs.

test.describe.configure({ mode: 'serial' });
test.use({ storageState: { cookies: [], origins: [] } });

const info = (page: Page) => page.evaluate(() => (window.__bs as BsHook).render.info());

/** The frame is drawn with the medium chain and stays within the medium budget. */
async function withinBudget(page: Page, step: string): Promise<void> {
  const frame = await info(page);
  const { budget } = PRESETS.medium;
  expect(frame.preset, step).toBe('medium');
  expect(frame.calls, `${step}: draw calls`).toBeLessThanOrEqual(budget.calls);
  expect(frame.triangles, `${step}: triangles`).toBeLessThanOrEqual(budget.triangles);
  expect(frame.targetBytes, `${step}: target bytes`).toBeLessThanOrEqual(budget.targetBytes);
}

async function open(page: Page): Promise<void> {
  await openRecorded(page, '&quality=medium', HUB);
}

interface Peaks {
  hud: boolean;
  windups: number;
  glows: number;
  budget: boolean;
}

/**
 * From now on, every frame records what the fight showed: the combat HUD, the windups aimed at the
 * player, the telegraph glows, and whether the frame stayed within the medium budget. A fight is
 * quick on a laptop and slow on a runner; reading the peaks afterwards needs no timing.
 */
const watchFight = (page: Page, budget: { calls: number; triangles: number }) =>
  page.evaluate((limit) => {
    const bs = window.__bs as BsHook;
    const peaks: Peaks = { hud: false, windups: 0, glows: 0, budget: true };
    (window as unknown as { __peaks: Peaks }).__peaks = peaks;
    const look = () => {
      const s = bs.state();
      const fighting = s.encounter !== null && !s.encounter.over;
      if (fighting) {
        const frame = bs.render.info();
        peaks.hud ||= s.encounter?.hud?.shown === true;
        peaks.windups = Math.max(peaks.windups, s.encounter?.hud?.windups ?? 0);
        peaks.glows = Math.max(peaks.glows, frame.telegraphs.glows ?? 0);
        if (frame.calls > limit.calls || frame.triangles > limit.triangles) peaks.budget = false;
      }
      requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  }, budget);

const peaks = (page: Page) =>
  page.evaluate(() => (window as unknown as { __peaks: Peaks }).__peaks);

test('hatch, mate and a fight to its end @slow', async ({ browser }) => {
  test.setTimeout(300_000);
  const pages = await Promise.all([0, 1].map(async () => (await browser.newContext()).newPage()));
  const [a, b] = pages as [Page, Page];
  try {
    await Promise.all(pages.map(open));
    const { budget } = PRESETS.medium;

    // 1-2. A and B hatch (each sees the other's shimmer, and it goes), then mate, so both carry an
    // egg; B then reloads and resumes unprotected and hurt.
    const ids = await stage(
      a,
      b,
      async () => {
        await withinBudget(a, 'hatched');
        await a.waitForFunction(
          () => (window.__bs?.state().attack.shimmer.length ?? 0) > 0,
          undefined,
          { timeout: 10_000 },
        );
        await Promise.all([ripe(a), ripe(b)]);
        await mate(a, b);
        expect((await state(a)).attack.shimmer).toEqual([]);
        await withinBudget(a, 'mated');
      },
      0.3,
    );
    expect((await state(a)).life.pending).toBe(true);
    expect((await state(b)).life.pending).toBe(true);
    await Promise.all([watchFight(a, budget), watchFight(b, budget)]);

    // 3. A engages B and the fight runs to its end.
    const fight = await fightToEnd(a, b, ids);
    for (const page of [a, b]) {
      const seenPeaks = await peaks(page);
      expect(seenPeaks.hud, 'the combat HUD showed in the fight').toBe(true);
      expect(seenPeaks.budget, 'the fight stayed within the medium budget').toBe(true);
    }
    const [onA, onB] = await Promise.all([peaks(a), peaks(b)]);
    expect(Math.max(onA.windups, onB.windups), 'a windup was aimed at someone').toBeGreaterThan(0);
    expect(Math.max(onA.glows, onB.glows), 'a telegraph glow was drawn').toBeGreaterThan(0);
    const ends = await Promise.all([a, b].map(async (page) => (await state(page)).encounter));
    for (const end of ends) {
      expect(end?.id).toBe(fight);
      expect(end?.hash).toBe(end?.endHash);
      expect(end?.desyncs).toBe(0);
    }
    expect(ends[0]?.endHash).toBe(ends[1]?.endHash);
    await withinBudget(a, 'after the fight');

    // 4. The end reads as its outcome says.
    const result = ends[0]?.fighters ?? [];
    const outcomeB = result.find((f) => f.player === ids.idB)?.outcome;
    if (outcomeB === 'killed') {
      await b.waitForFunction(() => window.__bs?.state().screen === 'dead', undefined, {
        timeout: 15_000,
      });
      expect((await state(b)).death?.cause).toBe('killed');
      await expect(b.getByTestId('death-cause')).toHaveText(/^Killed by \S/);
      expect((await state(b)).life.pending).toBe(false);
      expect((await state(b)).life.fallback?.pending ?? false).toBe(false);
      await withinBudget(b, 'death screen');
    } else if (result.find((f) => f.player === ids.idB)?.egg?.eaten) {
      await expect(b.getByTestId('toast')).toContainText('Your egg was eaten', {
        timeout: 10_000,
      });
      expect((await state(b)).life.pending).toBe(false);
    } else {
      expect((await state(b)).life.pending).toBe(true);
    }
  } finally {
    await Promise.all(pages.map((page) => page.context().close()));
  }
});
