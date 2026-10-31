import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { GENESIS_FORMS } from '../../src/genome/genesis-v6';
import { PRESETS } from '../../src/render/presets';
import {
  clickHatch,
  goTo,
  M6_LIFECYCLE_HUB as HUB,
  openRecorded,
  playerOf,
  ripe,
  state,
  topUp,
  waitPlaying,
} from './helpers';

// The whole M6 line in one scenario (@slow, release gate) at `?quality=medium`, on an authority
// with short lives and maturity in seconds. A hatches under the egg reveal, grows, visits the
// shallows (UV) and the abyss (pressure), finds B by its edge indicator and the pond map, pings
// and emotes through the wheel, mates with B, sees both carried eggs, promotes the child and then
// loses it to the pressure of the abyss. Every step checks the medium preset's budgets.

test.use({ storageState: { cookies: [], origins: [] } });

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

async function hatched(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await openRecorded(page, '&quality=medium', HUB);
  await clickHatch(page);
  return page;
}

test('hatch, grow, zones, find, wheel, mate, promote and a death in the abyss @slow', async ({
  browser,
}) => {
  test.setTimeout(420_000);
  const a = await hatched(await browser.newContext());

  // 1. The egg reveal plays, and the body is a genesis form.
  await a.waitForFunction(() => window.__bs?.state().egg.phase === 'waiting');
  await waitPlaying(a);
  await a.waitForFunction(() => window.__bs?.state().egg.phase === 'revealed', undefined, {
    timeout: 10_000,
  });
  expect((await state(a)).egg.phases).toEqual(['waiting', 'cracking', 'revealed']);
  expect((await cues(a)).reveal).toBe(1);
  const forms = new Set<string>(GENESIS_FORMS.map((f) => f.silhouette));
  const me = await playerOf(a);
  expect([...forms], `silhouette ${me.silhouette}`).toContain(me.silhouette);
  await withinBudget(a, 'hatch');

  const b = await hatched(await browser.newContext());
  await waitPlaying(b);
  await Promise.all([ripe(a), ripe(b)]);
  const idA = (await state(a)).playerId as string;
  const idB = (await state(b)).playerId as string;

  // 2. Growing moves the meter, and each tenth plays the size cue.
  const line = a.getByTestId('hud-growth');
  const percent = async () => Number(/(\d+)%/.exec((await line.textContent()) ?? '')?.[1]);
  // Play at 30x has grown A already; start the climb from a small size.
  await a.evaluate(() => (window.__bs as BsHook).debug?.setBiomass(120));
  await expect.poll(percent).toBeLessThan(100);
  const small = await percent();
  const grown = (await cues(a)).grow ?? 0;
  await a.evaluate(() => (window.__bs as BsHook).debug?.setBiomass(250));
  await expect.poll(percent).toBeGreaterThan(small);
  await expect.poll(async () => (await cues(a)).grow ?? 0).toBeGreaterThan(grown);
  await withinBudget(a, 'growth');

  // 3. The shallows burn with UV, the abyss crushes; each has its cue and its sound. The world
  // stands still while the player is moved, and runs just long enough for one hit. The cue is the
  // minimap's hazard icon and a shake of the body and the camera, with no overlay (M6b T10).
  expect((await playerOf(a)).stats.uvTolerance).toBeLessThan(1);
  expect((await playerOf(a)).stats.pressureTolerance).toBeLessThan(1);
  expect((await state(a)).zone).toBe('twilight');
  await timeScale(a, 0);
  for (const [zone, cue, sound, warning] of [
    ['shallows', 'uv', 'uv', 'UV burns'],
    ['abyss', 'pressure', 'pressure', 'Pressure crushes'],
  ] as const) {
    const hits = (await a.evaluate(() => (window.__bs as BsHook).events())).damage ?? 0;
    await a.evaluate((z) => (window.__bs as BsHook).debug?.setZone(z), zone);
    await expect(a.locator(`[data-testid="minimap-hazard"][data-hazard="${cue}"]`)).toBeVisible();
    await expect(a.getByTestId(`${cue}-cue`)).toHaveCount(0);
    await expect(a.getByTestId('hud-zone-warning')).toHaveText(warning);
    await timeScale(a, 1);
    await expect.poll(async () => (await cues(a))[sound] ?? 0).toBeGreaterThan(0);
    await a.waitForFunction((kind) => {
      const { shake, vignette } = (window.__bs as BsHook).render.fx();
      return shake.kind === kind && shake.body > 0 && shake.camera > 0 && vignette === 0;
    }, cue);
    await timeScale(a, 0);
    expect(
      (await a.evaluate(() => (window.__bs as BsHook).events())).damage ?? 0,
      `${zone} hit`,
    ).toBeGreaterThan(hits);
    expect((await state(a)).zone).toBe(zone);
    await a.screenshot({ path: `test-results/m6-lifecycle-${zone}.png` });
    await withinBudget(a, zone);
  }
  await a.evaluate(() => (window.__bs as BsHook).debug?.setZone('twilight'));
  await timeScale(a, 1);

  // 4. B is far away: A finds it by the edge indicator, then by the pond map.
  const view = await a.evaluate(() => (window.__bs as BsHook).render.fx().halfHeight);
  const pa = await playerOf(a);
  await b.evaluate(([x, y]) => (window.__bs as BsHook).debug?.teleport(x, y), [
    pa.x + view * 8,
    pa.y + view * 2,
  ] as const);
  await expect
    .poll(
      async () => (await state(a)).indicators.some((i) => i.kind === 'player' && i.id === idB),
      {
        timeout: 15_000,
      },
    )
    .toBe(true);
  await expect(
    a.locator(`[data-testid="edge-indicator"][data-kind="player"][data-id="${idB}"]`),
  ).toBeVisible();
  await a.keyboard.press('m');
  await expect(a.locator(`[data-testid="map-dot"][data-id="${idB}"] svg`)).toBeVisible();
  await expect(a.locator(`[data-testid="map-dot"][data-id="${idA}"] svg`)).toBeVisible();
  await a.screenshot({ path: 'test-results/m6-lifecycle-map.png' });
  await a.keyboard.press('m');
  await withinBudget(a, 'find');

  // 5. A pings and emotes through the wheel; B receives both.
  await goTo(a, idB);
  const heard = await cues(a);
  const heardB = await cues(b);
  // G is held while the number picks: at the medium preset in software a frame can outlast the
  // wheel's 250 ms tap window, so a press and release would count as a cancelling hold.
  for (const key of ['1', '6']) {
    await a.keyboard.down('g');
    await a.keyboard.press(key);
    await a.keyboard.up('g');
  }
  // The cues outlast the marks (a ping 4 s, an emote 2 s), which a slow frame can miss.
  await expect.poll(async () => (await cues(b)).ping ?? 0).toBeGreaterThan(heardB.ping ?? 0);
  await expect.poll(async () => (await cues(b)).emote ?? 0).toBeGreaterThan(heardB.emote ?? 0);
  expect((await cues(a)).ping ?? 0).toBeGreaterThan(heard.ping ?? 0);
  expect((await cues(a)).emote ?? 0).toBeGreaterThan(heard.emote ?? 0);
  await withinBudget(a, 'wheel');

  // 6. A and B court and mate: the cost lands, and each sees the other's carried egg.
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
    expect((await info(page)).eggs).toBe(2);
  }
  await a.screenshot({ path: 'test-results/m6-lifecycle-eggs.png' });
  await withinBudget(a, 'mating');

  // 7. A promotes the child: the hatch sequence plays. The child then dies of pressure.
  const child = (await state(a)).offspring.creature;
  await a.keyboard.press('h');
  await a.waitForFunction((id) => window.__bs?.state().life.creature === id, child, {
    timeout: 20_000,
  });
  await a.waitForFunction(() => window.__bs?.state().egg.phase === 'revealed', undefined, {
    timeout: 5_000,
  });
  expect((await state(a)).egg.phases.slice(-2)).toEqual(['cracking', 'revealed']);
  expect((await cues(a)).hatch).toBe(1);
  await withinBudget(a, 'promotion');

  expect((await playerOf(a)).stats.pressureTolerance).toBeLessThan(1);
  await a.evaluate(() => (window.__bs as BsHook).debug?.setZone('abyss'));
  await a.waitForFunction(
    () => {
      const bs = window.__bs as BsHook;
      if (bs.state().screen === 'dead') return true;
      bs.debug?.setEnergy(Number.MAX_SAFE_INTEGER);
      bs.debug?.timeScale(30);
      return false;
    },
    undefined,
    { timeout: 90_000 },
  );
  await timeScale(a, 1);
  expect((await state(a)).death?.cause).toBe('pressure');
  await expect(a.getByTestId('death-cause')).toHaveText('Crushed');
  expect((await cues(a)).death).toBe(1);
  await a.screenshot({ path: 'test-results/m6-lifecycle-death.png' });
  await withinBudget(a, 'death');
  await Promise.all([a.context().close(), b.context().close()]);
});
