import { expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { clickHatch, hatch, openGame, openRecorded, state, waitPlaying } from './helpers';

// The HUD shell (M6b T9): one menu button, four thin stat bars and the minimap (T10) and nothing
// else on the play screen; the numbers live in the menu, the controls in first-life hints and the menu.

test.describe.configure({ mode: 'serial' });

const STATS = ['health', 'energy', 'size', 'life'] as const;

/** Every visible text on the page that is not one of the event-driven kinds the play screen allows. */
const strayText = (page: Page) =>
  page.evaluate(() => {
    // Toasts (the alone and mate hints are toasts too: each shows only for an event), chat lines,
    // labels over creatures, edge-indicator labels, the first-life hints, the chips, the online
    // counter (owner request) and the zone's name under the minimap's depth arc (M6b T10).
    const allowed =
      '[data-testid="toast"], [data-testid="alone-hint"], [data-testid="mate-hint"], .chat-log, .remote-labels, .edge-indicators, [data-testid="hint"], .chip, [data-testid="net-status"], [data-testid="minimap-zone"]';
    const out: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim() ?? '';
      const parent = node.parentElement;
      if (!text || !parent || parent.closest('svg, script, style')) continue;
      if (!parent.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const box = range.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (box.right <= 0 || box.bottom <= 0 || box.left >= innerWidth || box.top >= innerHeight)
        continue;
      if (parent.closest(allowed)) continue;
      out.push(text);
    }
    return out;
  });

/** The share of the viewport the always-on HUD covers: the menu button, the bars and the minimap with its label. */
const hudCover = (page: Page) =>
  page.evaluate(() => {
    const parts = [
      document.querySelector('[data-testid="hud-menu"]'),
      ...document.querySelectorAll('.hud .stat'),
      document.querySelector('.minimap'),
    ].filter((el): el is HTMLElement => el instanceof HTMLElement && el.checkVisibility());
    const area = parts.reduce((sum, el) => {
      const r = el.getBoundingClientRect();
      return sum + r.width * r.height;
    }, 0);
    return { share: area / (innerWidth * innerHeight), parts: parts.length };
  });

const hudState = async (page: Page) => (await state(page)).hud;

test('the play screen shows one menu button, four bars and the minimap, and nothing else', async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  try {
    await openRecorded(page);
    // The title screen keeps its own buttons and its build label.
    for (const id of ['hatch', 'lineage-open', 'settings-open', 'build-label'])
      await expect(page.getByTestId(id)).toBeVisible();
    await expect(page.getByTestId('hud-menu')).toBeHidden();
    await clickHatch(page);
    await waitPlaying(page);
    await expect(page.getByTestId('build-label')).toBeHidden();
    await page.screenshot({ path: 'test-results/m6b-hud-1280.png' });

    for (const [width, height] of [
      [1280, 720],
      [960, 540],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.mouse.move(width / 2, height / 2);
      const at = `${width}×${height}`;
      // One read of the whole layout: a busy software-rendered page answers each call slowly.
      const look = await page.evaluate((stats) => {
        const box = (el: Element | null) => {
          const r = el?.getBoundingClientRect();
          return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
        };
        const menu = document.querySelector('[data-testid="hud-menu"]') as HTMLElement;
        const size = document.querySelector('[data-testid="hud-bar-size"]') as HTMLElement;
        const track = size.querySelector('.bar')?.getBoundingClientRect();
        const mark = size.querySelector('.tick')?.getBoundingClientRect();
        const bs = (window as unknown as { __bs: BsHook }).__bs;
        return {
          hud: bs.state().hud,
          menu: {
            visible: menu.checkVisibility(),
            label: menu.getAttribute('aria-label'),
            svgs: menu.querySelectorAll('svg').length,
            box: box(menu),
            radius: parseFloat(getComputedStyle(menu).borderTopLeftRadius),
          },
          bars: stats.map((stat) => {
            const el = document.querySelector(`[data-testid="hud-bar-${stat}"]`) as HTMLElement;
            return {
              stat,
              visible: el.checkVisibility(),
              role: el.getAttribute('role'),
              box: box(el),
              now: Number(el.getAttribute('aria-valuenow')),
              title: el.getAttribute('title') ?? '',
              icon: el.querySelector('svg')?.innerHTML ?? '',
            };
          }),
          tick: track && mark ? (mark.left + mark.width / 2 - track.left) / track.width : -1,
          depthBar: document.querySelector('[data-testid="hud-depth"]'),
          minimap: box(document.querySelector('[data-testid="minimap"]')),
          minimapShown: bs.state().minimap.shown,
          // The corner radius in pixels (a percentage is of the box's width).
          radius: (() => {
            const el = document.querySelector('[data-testid="minimap"]') as HTMLElement;
            const r = getComputedStyle(el).borderTopLeftRadius;
            return r.endsWith('%') ? (parseFloat(r) / 100) * el.offsetWidth : parseFloat(r);
          })(),
        };
      }, STATS);
      expect(look.hud.menu, at).toBe(false);
      expect(look.hud.chips, at).toEqual([]);

      // One round menu button in the top-left corner: a 44 px target with a profile glyph.
      expect(look.menu.visible, at).toBe(true);
      expect(look.menu.label).toBe('Menu (Esc)');
      expect(look.menu.svgs).toBe(1);
      const box = look.menu.box;
      if (!box) throw new Error('no menu button');
      expect(box.x, at).toBeLessThanOrEqual(24);
      expect(box.y, at).toBeLessThanOrEqual(24);
      expect(box.width, at).toBeGreaterThanOrEqual(44);
      expect(box.height, at).toBeGreaterThanOrEqual(44);
      expect(look.menu.radius, at).toBeGreaterThanOrEqual(box.width / 2 - 1);

      // Four thin bars in the bottom-left corner, each a meter with its own icon and a tooltip.
      for (const bar of look.bars) {
        const { stat, box: b } = bar;
        expect(bar.visible, `${stat} ${at}`).toBe(true);
        expect(bar.role, stat).toBe('meter');
        if (!b) throw new Error(`no ${stat} bar`);
        expect(b.x + b.width, `${stat} ${at}`).toBeLessThan(width * 0.3);
        expect(b.y, `${stat} ${at}`).toBeGreaterThan(height * 0.6);
        expect(b.height, `${stat} thin ${at}`).toBeLessThanOrEqual(20);
        const drawn = look.hud.bars[stat] as number;
        expect(drawn, stat).toBeGreaterThanOrEqual(0);
        expect(drawn, stat).toBeLessThanOrEqual(1);
        expect(Math.abs(bar.now - drawn * 100), stat).toBeLessThanOrEqual(0.5);
        expect(bar.title, stat).toMatch(/\d/);
      }
      expect(new Set(look.bars.map((b) => b.icon)).size, 'each bar has its own icon').toBe(
        STATS.length,
      );
      // The size bar has a tick at the maturity size, 60% of the adult.
      expect(look.tick).toBeCloseTo(0.6, 1);
      // The minimap replaces the depth bar (T10): round, top right, 12% of the short side and at
      // least 120 px.
      expect(look.depthBar, at).toBeNull();
      expect(look.minimapShown, at).toBe(true);
      const mm = look.minimap;
      if (!mm) throw new Error('no minimap');
      const side = Math.max(120, Math.round(0.12 * Math.min(width, height)));
      expect(mm.width, at).toBeCloseTo(side, 0);
      expect(mm.height, at).toBeCloseTo(side, 0);
      expect(look.radius, at).toBeGreaterThanOrEqual(side / 2 - 1);
      expect(width - (mm.x + mm.width), at).toBeLessThanOrEqual(24);
      expect(mm.y, at).toBeLessThanOrEqual(64);

      const cover = await hudCover(page);
      expect(cover.parts, at).toBe(6);
      expect(
        cover.share,
        `HUD covers ${(cover.share * 100).toFixed(2)}% at ${at}`,
      ).toBeLessThanOrEqual(0.06);
      expect(await strayText(page), at).toEqual([]);
    }

    // Esc opens the menu, with the life in words; Esc closes it.
    await page.keyboard.press('Escape');
    const panel = page.getByTestId('menu');
    await expect(panel).toBeVisible();
    expect((await hudState(page)).menu).toBe(true);
    await expect(page.getByTestId('hud-menu')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('hud-life')).toBeVisible();
    await expect(page.getByTestId('hud-stage')).toHaveText('Young');
    await expect(page.getByTestId('hud-ready')).toBeAttached();
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    expect((await hudState(page)).menu).toBe(false);
  } finally {
    await context.close();
  }
});

test('the menu holds everything the play screen dropped, and steering carries on under it', async ({
  page,
}) => {
  await openGame(page, '?seed=hud-menu');
  await hatch(page);
  const s = await state(page);
  const panel = page.getByTestId('menu');
  await page.keyboard.press('Escape');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('hud-species')).toContainText(s.player?.species ?? '?');
  await expect(page.getByTestId('hud-species')).toContainText(s.player?.rarity ?? '?');
  await expect(page.getByTestId('hud-biomass')).toHaveText(/^\d+$/);
  await expect(page.getByTestId('hud-energy')).toHaveText(/^\d+%$/);
  await expect(page.getByTestId('hud-health')).toHaveText(/^\d+$/);
  await expect(page.getByTestId('hud-growth')).toHaveText(/^Size \d+% of adult/);
  await expect(page.getByTestId('hud-zone')).toHaveText(/^[A-Z][a-z]+$/);
  for (const id of ['menu-lineage', 'menu-settings', 'menu-controls', 'roster-title'])
    await expect(page.getByTestId(id)).toBeVisible();
  await expect(page.getByTestId('menu-build')).toHaveText(process.env.BUILD_LABEL || 'dev');
  // Every key, in the Controls section.
  await page.getByTestId('menu-controls').click();
  const keys = page.getByTestId('controls');
  await expect(keys).toBeVisible();
  for (const key of ['WASD', 'Space', 'Enter', 'G', 'T', 'M', 'E', 'H', 'Esc', 'Middle'])
    await expect(keys).toContainText(key);
  await page.screenshot({ path: 'test-results/m6b-hud-menu.png' });

  // Steering carries on under the menu: the cursor at the right edge swims right.
  const before = (await state(page)).player?.x ?? 0;
  await page.mouse.move(940, 270);
  await expect
    .poll(async () => ((await state(page)).player?.x ?? 0) - before, { timeout: 5000 })
    .toBeGreaterThan(5);
  await page.mouse.move(480, 270);

  // Lineage and Settings open over the menu; Esc closes them first, then the menu.
  await page.getByTestId('menu-lineage').click();
  await expect(page.getByTestId('lineage')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('lineage')).toBeHidden();
  await expect(panel).toBeVisible();
  await page.getByTestId('menu-settings').click();
  await expect(page.getByTestId('settings')).toBeVisible();
  await page.getByTestId('settings-close').click();
  await expect(page.getByTestId('settings')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  expect((await hudState(page)).menu).toBe(false);
  // The button opens and closes it too, and leaves Space to the dash.
  await page.getByTestId('hud-menu').click();
  await expect(panel).toBeVisible();
  await page.getByTestId('hud-menu').click();
  await expect(panel).toBeHidden();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
});

test('first-life hints fade in once per browser, and never on later lives', async ({ browser }) => {
  test.setTimeout(60_000);
  const context = await browser.newContext();
  const page = await context.newPage();
  const hint = page.getByTestId('hint');
  const playFor = async (seconds: number) => {
    const start = (await state(page)).tick;
    await page.waitForFunction(
      (until) => {
        const bs = window.__bs as BsHook;
        bs.debug?.setEnergy(Number.MAX_SAFE_INTEGER);
        return bs.state().tick >= until;
      },
      start + seconds * 30,
      { timeout: 20_000 },
    );
  };
  try {
    await openGame(page, '?debug=1&seed=hints');
    await hatch(page);
    await expect(hint).toBeVisible();
    await expect(hint).toHaveText('Mouse or WASD to swim · Space to dash');
    expect((await hudState(page)).hints).toBe('Mouse or WASD to swim · Space to dash');
    expect(await page.evaluate(() => localStorage.getItem('bs.hints'))).not.toBeNull();
    await page.screenshot({ path: 'test-results/m6b-hud-hint.png' });
    await page.evaluate(() => (window.__bs as BsHook).debug?.timeScale(8));
    await expect(hint).toBeHidden({ timeout: 10_000 });
    expect((await hudState(page)).hints).toBeNull();
    // After 30 s of play, the social keys (caught at full speed, so the 8 s show is seen).
    await page.waitForFunction(
      () => {
        const bs = window.__bs as BsHook;
        bs.debug?.setEnergy(Number.MAX_SAFE_INTEGER);
        if (bs.state().hud.hints === null) return false;
        bs.debug?.timeScale(1);
        return true;
      },
      undefined,
      { timeout: 15_000 },
    );
    await expect(hint).toBeVisible();
    await expect(hint).toHaveText('G wheel · M map · Enter chat');
    await page.evaluate(() => (window.__bs as BsHook).debug?.timeScale(8));
    await expect(hint).toBeHidden({ timeout: 10_000 });

    // A later life, after a reload: no hints at all.
    await openGame(page, '?debug=1&seed=hints-2');
    await hatch(page);
    await expect(hint).toBeHidden();
    expect((await hudState(page)).hints).toBeNull();
    await page.evaluate(() => (window.__bs as BsHook).debug?.timeScale(8));
    await playFor(34);
    await expect(hint).toBeHidden();
    expect((await hudState(page)).hints).toBeNull();
  } finally {
    await context.close();
  }
});

test('chips show beside the bars only while they apply, and the bars follow the creature', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    // An unreachable hub: a practice cell in a local pond, so "Not recorded" and the offline dot.
    await openGame(page, '?debug=1&hub=http://localhost:1&seed=chips');
    await hatch(page);
    await expect(page.getByTestId('practice-badge')).toBeVisible();
    await expect(page.getByTestId('practice-badge')).toHaveText('Not recorded');
    const offline = page.getByTestId('hud-offline');
    await expect(offline).toBeVisible();
    await expect(offline).toHaveAccessibleName(/^Offline/);
    await expect.poll(async () => (await hudState(page)).chips).toEqual(['practice', 'offline']);
    await expect(page.getByTestId('hud-egg')).toBeHidden();
    await expect(page.getByTestId('hud-mate-ready')).toBeHidden();
    // Beside the bars, in the bottom-left corner.
    const bars = await page.getByTestId('hud-bar-health').boundingBox();
    for (const id of ['practice-badge', 'hud-offline']) {
      const chip = await page.getByTestId(id).boundingBox();
      if (!chip || !bars) throw new Error('missing boxes');
      expect(chip.x, id).toBeGreaterThan(bars.x + bars.width);
      expect(chip.y + chip.height, id).toBeGreaterThan(540 * 0.7);
    }
    // A practice cell has no lifespan: no life bar, and none in the menu.
    await expect(page.getByTestId('hud-bar-life')).toBeHidden();
    expect((await hudState(page)).bars.life).toBeNull();
    // Status, with the offline line, in the menu.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('menu-net')).toHaveText('Offline · playing alone');
    await expect(page.getByTestId('hud-life')).toBeHidden();
    await page.keyboard.press('Escape');

    // The bars follow the sim: size toward adult, energy and health.
    await page.evaluate(() => {
      const bs = window.__bs as BsHook;
      bs.debug?.timeScale(0);
      bs.debug?.setBiomass(250);
    });
    const size = page.getByTestId('hud-bar-size');
    await expect(size).toHaveAttribute('aria-valuenow', '62');
    await expect(size).toHaveAttribute('title', /^Size 62% of adult/);
    expect((await hudState(page)).bars.size).toBeCloseTo(250 / 400, 2);
    await page.evaluate(() => (window.__bs as BsHook).debug?.setEnergy(0));
    await expect(page.getByTestId('hud-bar-energy')).toHaveAttribute('aria-valuenow', '0');
    expect((await hudState(page)).bars.energy).toBe(0);
    await expect(page.getByTestId('hud-bar-energy')).toHaveAttribute('data-low', '');
  } finally {
    await context.close();
  }
});
