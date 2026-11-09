import { expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { CONTROLS } from '../../src/game/controls';
import { HELP_SECTIONS } from '../../src/game/help-text';
import { hatch, openGame, openMenu, state } from './helpers';

// How to play (M14 T8): one panel answers "how do I…" with every control. `?` opens it anywhere but
// in chat; on the title it is a centred panel, in play a side panel the creature keeps swimming
// under; the menu's Help opens it at Controls. A practice cell, no hub.

const helpOf = async (page: Page) => (await state(page)).help;
const panel = (page: Page) => page.getByTestId('help');

/** Every section in order, and the controls table with a row for each control. */
async function checkContents(page: Page): Promise<void> {
  const titles = panel(page).locator('h3');
  await expect(titles).toHaveText(HELP_SECTIONS.map((s) => s.title));
  const rows = page.getByTestId('help-control');
  await expect(rows).toHaveCount(CONTROLS.length);
  for (const [i, c] of CONTROLS.entries()) await expect(rows.nth(i)).toContainText(c.action);
  await expect(panel(page).getByRole('link', { name: 'What this proves' })).toHaveAttribute(
    'href',
    /docs\/VERIFY\.md$/,
  );
}

/** No horizontal scroll on the page or inside the panel, and the panel within the screen. */
async function checkFits(page: Page): Promise<void> {
  const fit = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="help"]') as HTMLElement;
    const body = el.querySelector('.help-body') as HTMLElement;
    const r = el.getBoundingClientRect();
    return {
      page: document.documentElement.scrollWidth - innerWidth,
      inside: body.scrollWidth - body.clientWidth,
      left: r.left,
      right: innerWidth - r.right,
      top: r.top,
      bottom: innerHeight - r.bottom,
    };
  });
  expect(fit.page).toBeLessThanOrEqual(0);
  expect(fit.inside).toBeLessThanOrEqual(0);
  for (const side of [fit.left, fit.right, fit.top, fit.bottom])
    expect(side).toBeGreaterThanOrEqual(0);
}

for (const viewport of [
  { width: 960, height: 540 },
  { width: 390, height: 844 },
]) {
  const size = `${viewport.width}`;
  test.describe(`at ${viewport.width} × ${viewport.height}`, () => {
    test.use({ viewport });

    test('on the title, ? and How to play open it centred; Esc closes it and gives focus back', async ({
      page,
    }) => {
      await openGame(page, '?debug=1&seed=help-title');
      expect(await helpOf(page)).toEqual({ open: false, section: null });
      await page.keyboard.press('?');
      await expect(panel(page)).toBeVisible();
      expect(await helpOf(page)).toEqual({ open: true, section: 'play' });
      // Focus moved into the panel, onto its first heading.
      await expect(panel(page).locator('h3').first()).toBeFocused();
      await checkContents(page);
      await checkFits(page);
      // Centred: as far from the left as from the right.
      const box = await panel(page).boundingBox();
      expect(Math.abs((box?.x ?? 0) * 2 + (box?.width ?? 0) - viewport.width)).toBeLessThan(4);
      // The title stays whole under it.
      await expect(page.getByTestId('hatch')).toBeAttached();
      await page.screenshot({ path: `test-results/m14-help-title-${size}.png` });
      await page.keyboard.press('Escape');
      await expect(panel(page)).toBeHidden();
      expect((await helpOf(page)).open).toBe(false);

      // The title's own button opens it; the close button closes it.
      const open = page.getByTestId('help-open');
      await expect(open).toBeVisible();
      await open.click();
      await expect(panel(page)).toBeVisible();
      expect((await helpOf(page)).section).toBe('play');
      await page.getByTestId('help-close').click();
      await expect(panel(page)).toBeHidden();
      // From the keyboard: focus goes into the panel and, on Esc, back where it was.
      await open.focus();
      await page.keyboard.press('?');
      await expect(panel(page).locator('h3').first()).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(panel(page)).toBeHidden();
      await expect(open).toBeFocused();
      await open.blur();
      // The title is whole: Hatch still works.
      await hatch(page);
    });

    test('in play it is a side panel the creature keeps swimming under; the menu opens it at Controls', async ({
      page,
    }) => {
      await openGame(page, '?debug=1&seed=help-play');
      await hatch(page);
      await page.keyboard.press('?');
      await expect(panel(page)).toBeVisible();
      expect(await helpOf(page)).toEqual({ open: true, section: 'play' });
      await checkContents(page);
      await checkFits(page);
      // The creature swims to food with the panel open.
      for (let i = 0; i < 2; i++) {
        const reached = await page.evaluate(async () => {
          const bs = window.__bs as BsHook;
          const food = bs.debug?.nearestFood();
          if (!food) throw new Error('no food near the player');
          return bs.debug?.steerTo(food);
        });
        expect(reached, 'steered to food under the help panel').toBe(true);
      }
      expect((await state(page)).screen).toBe('playing');
      await expect(panel(page)).toBeVisible();
      // The mouse still steers, even over the panel.
      const before = (await state(page)).player?.y ?? 0;
      await page.mouse.move(viewport.width / 2, 4);
      await expect
        .poll(async () => ((await state(page)).player?.y ?? 0) - before, {
          timeout: 10_000,
          message: 'the cursor at the top swims the creature up',
        })
        .toBeGreaterThan(5);
      await page.mouse.move(viewport.width / 2, viewport.height / 2);
      await page.evaluate(() => window.__bs?.debug?.timeScale(0));
      await page.screenshot({ path: `test-results/m14-help-play-${size}.png` });
      await page.evaluate(() => window.__bs?.debug?.timeScale(1));
      await page.keyboard.press('Escape');
      await expect(panel(page)).toBeHidden();
      // Esc closed the panel, not the menu under it: the menu stays shut.
      expect((await state(page)).hud.menu).toBe(false);

      // The menu's Help opens it at Controls.
      await openMenu(page);
      await expect(page.getByTestId('menu-help')).toBeVisible();
      await page.getByTestId('menu-help').click();
      await expect(panel(page)).toBeVisible();
      expect(await helpOf(page)).toEqual({ open: true, section: 'controls' });
      await expect(page.getByTestId('help-controls')).toBeInViewport();
      await page.screenshot({ path: `test-results/m14-help-controls-${size}.png` });
      await page.keyboard.press('Escape');
      await expect(panel(page)).toBeHidden();
      await expect(page.getByTestId('menu')).toBeVisible();
    });
  });
}

test('? is a letter in chat, not the help', async ({ page }) => {
  await openGame(page, '?debug=1&seed=help-chat');
  await hatch(page);
  await page.keyboard.press('Enter');
  const input = page.getByTestId('chat-input');
  await expect(input).toBeFocused();
  await page.keyboard.type('why?');
  await expect(input).toHaveValue('why?');
  await expect(panel(page)).toBeHidden();
  expect((await helpOf(page)).open).toBe(false);
  await page.keyboard.press('Escape');
});
