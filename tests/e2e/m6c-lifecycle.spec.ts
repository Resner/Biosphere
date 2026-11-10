import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { PRESETS } from '../../src/render/presets';
import {
  clickHatch,
  goTo,
  M6C_LIFECYCLE_HUB as HUB,
  openRecorded,
  playerOf,
  ripe,
  state,
  topUp,
  waitPlaying,
} from './helpers';

// The M6c line in one scenario (@slow, release gate) at `?quality=medium`, on an authority with
// short lives and maturity in seconds. A returning identity reads the renewal notice once; A
// hatches under a still, charged and player-paced reveal; dives from the shallows with UV landing
// as hits on the T9 cadence while the minimap's gauge goes down with the depth; and B and A court
// and mate, and A hatches the child. The look specs (`m6c-glass`, `m6c-organs`, `m6c-firefox`,
// `m6c-flash`) run apart; every step here checks the medium preset's budgets.

test.describe.configure({ mode: 'serial' });
test.use({ storageState: { cookies: [], origins: [] } });

const NOTICE =
  'The world was renewed in v1.0.0. Your identity is kept; your creatures start again. From now on, lineages are permanent.';

const info = (page: Page) => page.evaluate(() => (window.__bs as BsHook).render.info());
const cues = async (page: Page) => (await state(page)).audio.cues;
const timeScale = (page: Page, scale: number) =>
  page.evaluate((s) => (window.__bs as BsHook).debug?.timeScale(s), scale);

/** The frame is drawn with the medium chain and stays within the medium budget. */
async function withinBudget(page: Page, step: string): Promise<void> {
  const frame = await info(page);
  const { budget } = PRESETS.medium;
  expect(frame.preset, step).toBe('medium');
  expect(frame.passes, `${step}: the post chain is on`).toContain('bloom');
  expect(frame.calls, `${step}: draw calls`).toBeLessThanOrEqual(budget.calls);
  expect(frame.triangles, `${step}: triangles`).toBeLessThanOrEqual(budget.triangles);
  expect(frame.targetBytes, `${step}: target bytes`).toBeLessThanOrEqual(budget.targetBytes);
}

interface Charged {
  charge: number;
  phase: string;
  ticks: number;
}

/**
 * Twelve pokes, 270 ms apart on the egg's clock, as soon as the egg stirs. The world freezes first
 * and the pokes run in one task, each at a clock `setClock` sets after the beacon: a slow page that
 * draws a frame in half a second never lets the 6 s wait run out, nor two pokes' wall gap land
 * inside the quick-crack window (three within 0.5 s).
 */
const chargeFull = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<Charged>((resolve) => {
        const bs = window.__bs as BsHook;
        const canvas = document.getElementById('scene') as HTMLCanvasElement;
        const where = {
          button: 0,
          clientX: innerWidth / 2,
          clientY: innerHeight / 2,
          bubbles: true,
        };
        const look = setInterval(() => {
          const { phase, paced, beaconAt } = bs.state().egg;
          if (phase !== 'stirring' || !paced || beaconAt === null) return;
          clearInterval(look);
          bs.debug?.timeScale(0);
          for (let i = 0; i < 12; i++) {
            bs.debug?.setClock((beaconAt + 100 + i * 270) / 1000);
            canvas.dispatchEvent(new PointerEvent('pointerdown', where));
            dispatchEvent(new PointerEvent('pointerup', where));
          }
          const { egg, audio } = bs.state();
          resolve({ charge: egg.charge, phase: egg.phase, ticks: audio.cues.charge ?? 0 });
        }, 10);
      }),
  );

async function opened(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await openRecorded(page, '&quality=medium', HUB);
  return page;
}

test('renewal notice, charged reveal, a dive with UV hits and the gauge, mate and hatch @slow', async ({
  browser,
  request,
}) => {
  test.setTimeout(420_000);
  const a = await opened(await browser.newContext());

  // 1. A returning identity reads the renewal notice once (M6c T2).
  const idA = (await state(a)).playerId as string;
  // The hub's first `life` must have arrived before staging: sent after it, it would carry the
  // notice to this page and mark it told, and the reloaded page would never hear it.
  await a.waitForFunction(() => window.__bs?.state().renewed !== null);
  const staged = await request.post(`${HUB}/v1/e2e/pre-reset`, { data: { playerId: idA } });
  expect(staged.status(), 'the hub staged the identity as pre-reset').toBe(204);
  await a.reload();
  await a.waitForFunction(() => window.__bs?.ready === true);
  await a.waitForFunction(() => window.__bs?.state().renewed === true, undefined, {
    timeout: 15_000,
  });
  await expect(a.getByTestId('renewed')).toHaveText(NOTICE);
  await a.screenshot({ path: 'test-results/m6c-lifecycle-notice.png' });

  // 2. A genesis with a charged, player-paced reveal (M6c T11): twelve pokes fill the charge, the
  // egg still waits for the player, Enter cracks it, and the card shows the recorded child's tier.
  const pokes = chargeFull(a);
  await clickHatch(a);
  await a.mouse.move(2, 2);
  const after = await pokes;
  expect(after.charge).toBe(1);
  expect(after.ticks, 'one charge tick a poke').toBe(12);
  expect(after.phase, 'pokes never crack it: the egg waits for the player').toBe('stirring');
  expect((await state(a)).egg.still, 'the still scene holds').toBe(true);
  await a.evaluate(() => {
    (window.__bs as BsHook).debug?.timeScale(1);
    dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter' }));
  });
  await waitPlaying(a, { paced: true });
  // The card stays up for 3 s: take its tier in the frame that shows it, not from a later read.
  const shownCard = await a.waitForFunction(
    () => {
      const card = window.__bs?.state().egg.card;
      return card?.shown ? { tier: card.tier } : false;
    },
    undefined,
    { timeout: 15_000 },
  );
  const { tier: cardTier } = (await shownCard.jsonValue()) as { tier: string | null };
  const hatched = await state(a);
  expect(hatched.egg.crackedBy).toBe('player');
  expect(hatched.egg.charge).toBe(1);
  expect(cardTier).toBe(hatched.player?.rarity);
  expect((await info(a)).veil, 'the veil is gone once the shell has burst').toBeLessThan(0.35);
  expect(hatched.egg.phases).toEqual(['waiting', 'stirring', 'cracking', 'revealed']);
  await a.screenshot({ path: 'test-results/m6c-lifecycle-reveal.png' });
  await withinBudget(a, 'hatch');

  const b = await opened(await browser.newContext());
  await clickHatch(b);
  await waitPlaying(b);
  await Promise.all([ripe(a), ripe(b)]);
  const idB = (await state(b)).playerId as string;
  await a.waitForFunction(() => window.__bs?.state().egg.phase === 'revealed', undefined, {
    timeout: 15_000,
  });

  // 3. A dives from the shallows. UV lands as hits on the cadence of one every 15 ticks at most,
  // counted per tick of sim time (M6c T9), and the minimap's gauge marker goes down with the depth
  // (M6c T12).
  expect((await playerOf(a)).stats.uvTolerance).toBeLessThan(1);
  await timeScale(a, 0);
  await a.evaluate(() => (window.__bs as BsHook).debug?.setZone('shallows'));
  await expect.poll(async () => (await state(a)).minimap.hazard).toBe('uv');
  const marker = a.getByTestId('minimap-depth-marker');
  const markerY = async () => {
    const box = await marker.boundingBox();
    if (!box) throw new Error('no depth marker');
    return box.y + box.height / 2;
  };
  const shallowY = await markerY();
  // Counted in the sim's own damage ticks (one UV event a tick), not `state().tick`, which snaps to
  // the pond clock online.
  const start = await a.evaluate(() => {
    const bs = window.__bs as BsHook;
    bs.debug?.timeScale(1);
    return { damage: bs.events().damage ?? 0, hits: bs.render.fx().shake.hits };
  });
  await a
    .waitForFunction(() => (window.__bs as BsHook).render.fx().shake.camera >= 2, null, {
      polling: 'raf',
      timeout: 30_000,
    })
    .catch(() => {
      throw new Error('waited for a UV hit to kick the camera 2 px or more');
    });
  await a
    .waitForFunction(
      (d) => ((window.__bs as BsHook).events().damage ?? 0) >= d + 90,
      start.damage,
      { timeout: 60_000 },
    )
    .catch(() => {
      throw new Error('waited for 90 ticks of UV damage');
    });
  const end = await a.evaluate(() => {
    const bs = window.__bs as BsHook;
    bs.debug?.timeScale(0);
    return {
      damage: bs.events().damage ?? 0,
      hits: bs.render.fx().shake.hits,
      death: bs.state().death,
    };
  });
  expect(end.death, 'the cell survives a few seconds of UV').toBeNull();
  const ticks = end.damage - start.damage;
  const hits = end.hits - start.hits;
  expect(hits, `${hits} hits over ${ticks} damage ticks`).toBeGreaterThan(0);
  expect(hits, 'at most one hit every 15 ticks, the first at once').toBeLessThanOrEqual(
    Math.ceil(ticks / 15) + 1,
  );
  for (const id of ['vignette', 'uv-cue', 'pressure-cue'])
    await expect(a.getByTestId(id)).toHaveCount(0);
  await a.screenshot({ path: 'test-results/m6c-lifecycle-uv.png' });
  await withinBudget(a, 'uv');

  await a.evaluate(() => (window.__bs as BsHook).debug?.setZone('deep'));
  await expect.poll(async () => (await state(a)).minimap.zone).toBe('deep');
  const deepY = await markerY();
  expect(deepY, 'the gauge marker goes down with the dive').toBeGreaterThan(shallowY);
  const metres = Math.round(((await state(a)).minimap.depth ?? 0) * 1000);
  await expect(a.getByTestId('minimap-depth-text')).toHaveText(`${metres} m`);
  await a.evaluate(() => (window.__bs as BsHook).debug?.setZone('twilight'));
  await timeScale(a, 1);
  await withinBudget(a, 'dive');

  // 4. A and B court and mate: the cost lands, and each sees the other's carried egg.
  await Promise.all([topUp(a), topUp(b)]);
  const biomass = (await playerOf(a)).biomass;
  await expect(async () => {
    await goTo(a, idB);
    await expect(a.getByTestId('mate-hint')).toHaveText(/^E: court /, { timeout: 3_000 });
    await a.keyboard.press('e');
    await expect(b.getByTestId('invite')).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 40_000 });
  await b.keyboard.press('e');
  for (const page of [a, b]) {
    await page.waitForFunction(
      () => {
        const egg = window.__bs?.state().egg;
        return egg?.phase === 'revealed' && egg.carried;
      },
      undefined,
      { timeout: 60_000 },
    );
  }
  expect((await playerOf(a)).biomass).toBeLessThan(biomass);
  expect((await cues(a)).mate).toBe(1);
  for (const [page, other] of [
    [a, idB],
    [b, idA],
  ] as const) {
    await page.waitForFunction((id) => window.__bs?.state().egg.peers.includes(id), other, {
      timeout: 10_000,
    });
    expect((await state(page)).egg.shown).toBe(true);
  }
  await a.screenshot({ path: 'test-results/m6c-lifecycle-eggs.png' });
  await withinBudget(a, 'mating');

  // 5. A hatches the child: the paced crack waits for Enter, then the hatch plays.
  const child = (await state(a)).offspring.creature;
  await a.keyboard.press('h');
  await a.keyboard.press('Enter');
  await a.waitForFunction((id) => window.__bs?.state().life.creature === id, child, {
    timeout: 20_000,
  });
  await a.waitForFunction(() => window.__bs?.state().egg.phase === 'revealed', undefined, {
    timeout: 10_000,
  });
  expect((await state(a)).egg.phases.slice(-2)).toEqual(['cracking', 'revealed']);
  expect((await cues(a)).hatch).toBe(1);
  await a.screenshot({ path: 'test-results/m6c-lifecycle-hatch.png' });
  await withinBudget(a, 'hatch of the child');
  await Promise.all([a.context().close(), b.context().close()]);
});
