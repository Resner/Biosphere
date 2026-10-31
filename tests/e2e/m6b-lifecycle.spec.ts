import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { starterGenome } from '../../src/genome/starter';
import { buildCreature } from '../../src/genome/stats';
import { PRESETS } from '../../src/render/presets';
import { RULES } from '../../src/sim/rules';
import {
  atEgg,
  clickHatch,
  goTo,
  M6B_LIFECYCLE_HUB as HUB,
  openRecorded,
  playerOf,
  state,
  waitPlaying,
} from './helpers';

// The M6b line in one scenario (@slow, release gate) at `?quality=medium`: the egg rests and
// reveals with nothing over it, the play screen is only the menu button, four bars and the
// minimap, the top speed stays in the band, the wheel keeps the movement and reaches the other
// player's minimap, the hazards shake instead of painting, and after a death in the abyss Hatch
// again plays the reveal. The look checks (clipping, colour in the organs) run in the `post`
// project (`m6b-clip` and `m6b-look`). Every step checks the medium preset's budgets.

test.use({ storageState: { cookies: [], origins: [] } });

const info = (page: Page) => page.evaluate(() => (window.__bs as BsHook).render.info());
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

/** Records the egg's phase and angle on every frame until `window.__eggStop`. */
const watchEgg = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as {
      __eggLog: { phase: string; angle: number }[];
      __eggStop: boolean;
    };
    w.__eggLog = [];
    w.__eggStop = false;
    const look = () => {
      const { egg } = (window.__bs as BsHook).state();
      w.__eggLog.push({ phase: egg.phase, angle: egg.angle });
      if (!w.__eggStop) requestAnimationFrame(look);
    };
    look();
  });

const eggLog = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as {
      __eggLog: { phase: string; angle: number }[];
      __eggStop: boolean;
    };
    w.__eggStop = true;
    return w.__eggLog;
  });

async function opened(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await openRecorded(page, '&quality=medium', HUB);
  return page;
}

test('egg, minimal HUD, speed band, wheel, hazards, death and Hatch again @slow', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const a = await opened(await browser.newContext());
  const { width, height } = a.viewportSize() ?? { width: 960, height: 540 };

  // 1. The egg rests with no wiggle until the beacon, then stirs, cracks and reveals; nothing
  // covers it, and the result card names the rarity.
  await watchEgg(a);
  await clickHatch(a);
  await a.mouse.move(2, 2);
  await a.waitForFunction(() => window.__bs?.state().egg.phase === 'waiting');
  const covered = await atEgg(a);
  expect(covered?.hits).toEqual(Array(5).fill('canvas#scene'));
  await waitPlaying(a);
  await a.waitForFunction(() => window.__bs?.state().egg.phase === 'revealed', undefined, {
    timeout: 15_000,
  });
  const log = await eggLog(a);
  const waiting = log.filter((e) => e.phase === 'waiting');
  expect(waiting.length).toBeGreaterThan(0);
  for (const e of waiting) expect(Math.abs(e.angle)).toBeLessThanOrEqual(0.01);
  expect((await state(a)).egg.phases).toEqual(['waiting', 'stirring', 'cracking', 'revealed']);
  await a.waitForFunction(() => window.__bs?.state().egg.card.shown, undefined, { timeout: 8_000 });
  expect((await state(a)).egg.card.tier).toBeTruthy();
  await expect(a.getByTestId('reveal-rarity')).toBeVisible();
  await withinBudget(a, 'reveal');

  const b = await opened(await browser.newContext());
  await clickHatch(b);
  await waitPlaying(b);
  const idA = (await state(a)).playerId as string;
  await expect(a.getByTestId('reveal-card')).toBeHidden({ timeout: 8_000 });

  // 2. The play screen: the menu button, the four bars and the minimap; the numbers sit in the menu.
  await expect(a.getByTestId('hud-menu')).toBeVisible();
  for (const stat of ['health', 'energy', 'size', 'life'])
    await expect(a.getByTestId(`hud-bar-${stat}`)).toBeVisible();
  await expect(a.getByTestId('minimap')).toBeVisible();
  for (const id of ['vignette', 'uv-cue', 'pressure-cue', 'hud-depth'])
    await expect(a.getByTestId(id)).toHaveCount(0);
  expect((await state(a)).hud.menu).toBe(false);
  await expect(a.getByTestId('hud-biomass')).toBeHidden();
  await a.keyboard.press('Escape');
  expect((await state(a)).hud.menu).toBe(true);
  await expect(a.getByTestId('hud-biomass')).toBeVisible();
  await a.keyboard.press('Escape');
  expect((await state(a)).hud.menu).toBe(false);
  await a.screenshot({ path: 'test-results/m6b-lifecycle-play.png' });
  await withinBudget(a, 'play');

  // 3. Full throttle stays in the speed band: 0.6 to 1.6 times the starter's top speed at the
  // same biomass (DESIGN §4, ADR 0036), with a little slack for the sampling.
  await a.evaluate(() => (window.__bs as BsHook).debug?.setZone('twilight'));
  await a.mouse.move(width - 10, height / 2);
  await a.waitForTimeout(2500);
  const fastest = await a.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let top = 0;
        const end = performance.now() + 2000;
        const look = () => {
          top = Math.max(top, (window.__bs as BsHook).state().player?.speed ?? 0);
          if (performance.now() < end) requestAnimationFrame(look);
          else resolve(top);
        };
        look();
      }),
  );
  const me = await playerOf(a);
  const m = RULES.movement;
  const phys = buildCreature(starterGenome()).phys;
  const starterTop =
    (m.thrust * phys.thrust * (me.biomass / RULES.starter.biomass) ** m.thrustExp) /
    (m.drag * phys.drag);
  expect(fastest, 'swimming at full throttle').toBeGreaterThan(0.6 * starterTop * 0.9);
  expect(fastest, 'not way too fast').toBeLessThanOrEqual(
    RULES.stats.speedBand.max * starterTop * 1.05,
  );

  // 4. The wheel, held open for a second mid-swim, keeps at least 80% of the pace; a ping from
  // it reaches the other player's minimap.
  const travel = async () => {
    const from = await playerOf(a);
    await a.waitForTimeout(1000);
    const to = await playerOf(a);
    return Math.hypot(to.x - from.x, to.y - from.y);
  };
  const closed = await travel();
  expect(closed).toBeGreaterThan(10);
  await a.keyboard.press('g');
  expect((await state(a)).wheel.open).toBe(true);
  const sweep = (async () => {
    for (const [x, y] of [
      [width / 2, 40],
      [40, height / 2],
      [width / 2, height - 40],
    ] as const) {
      await a.mouse.move(x, y);
      await a.waitForTimeout(250);
    }
  })();
  const during = await travel();
  await sweep;
  expect(during).toBeGreaterThanOrEqual(closed * 0.8);
  await a.keyboard.press('Escape');
  expect((await state(a)).wheel.open).toBe(false);

  await goTo(b, idA);
  await a.mouse.move(width / 2, height / 2);
  await a.keyboard.down('g');
  await a.keyboard.press('1');
  await a.keyboard.up('g');
  await expect
    .poll(async () => (await state(b)).minimap.pings.some((p) => p.id === idA), {
      timeout: 8_000,
      intervals: [50],
    })
    .toBe(true);
  await withinBudget(a, 'wheel');

  // 5. The hazards: UV in the shallows and pressure in the abyss shake the body and the camera,
  // the minimap shows the hazard icon, and no overlay or vignette appears. The world stands still
  // while the player is moved, and runs just long enough for one hit.
  await timeScale(a, 0);
  for (const [zone, hazard] of [
    ['shallows', 'uv'],
    ['abyss', 'pressure'],
  ] as const) {
    const hits = (await a.evaluate(() => (window.__bs as BsHook).events())).damage ?? 0;
    await a.evaluate((z) => (window.__bs as BsHook).debug?.setZone(z), zone);
    await expect(
      a.locator(`[data-testid="minimap-hazard"][data-hazard="${hazard}"]`),
    ).toBeVisible();
    await expect(a.getByTestId(`${hazard}-cue`)).toHaveCount(0);
    await timeScale(a, 1);
    await a.waitForFunction((kind) => {
      const { shake, vignette } = (window.__bs as BsHook).render.fx();
      return shake.kind === kind && shake.body > 0 && shake.camera > 0 && vignette === 0;
    }, hazard);
    await timeScale(a, 0);
    expect(
      (await a.evaluate(() => (window.__bs as BsHook).events())).damage ?? 0,
      `${zone} hit`,
    ).toBeGreaterThan(hits);
    for (const id of ['vignette', 'uv-cue', 'pressure-cue'])
      await expect(a.getByTestId(id)).toHaveCount(0);
    await a.screenshot({ path: `test-results/m6b-lifecycle-${zone}.png` });
    await withinBudget(a, zone);
  }

  // 6. Pressure kills; the death screen names it, and Hatch again plays the reveal with nothing
  // over the egg.
  expect(me.stats.pressureTolerance).toBeLessThan(1);
  await a.waitForFunction(
    () => {
      const bs = window.__bs as BsHook;
      if (bs.state().screen === 'dead') return true;
      bs.debug?.setEnergy(Number.MAX_SAFE_INTEGER);
      bs.debug?.timeScale(30);
      return false;
    },
    undefined,
    { timeout: 120_000 },
  );
  await timeScale(a, 1);
  expect((await state(a)).death?.cause).toBe('pressure');
  await expect(a.getByTestId('death-cause')).toHaveText('Crushed');
  await withinBudget(a, 'death');
  await a.getByTestId('hatch-again').click();
  await a.mouse.move(2, 2);
  await a.waitForFunction(() => window.__bs?.state().egg.phase === 'waiting');
  const again = await atEgg(a);
  expect(again?.hits).toEqual(Array(5).fill('canvas#scene'));
  await expect(a.getByTestId('hatch-again')).toBeHidden();
  await expect(a.getByTestId('death-cause')).toBeHidden();
  await waitPlaying(a);
  await a.waitForFunction(() => window.__bs?.state().egg.phase === 'revealed', undefined, {
    timeout: 15_000,
  });
  await withinBudget(a, 'hatch again');
  await Promise.all([a.context().close(), b.context().close()]);
});
