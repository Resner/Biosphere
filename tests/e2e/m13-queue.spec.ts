import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, type Page, type TestInfo, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { openRecorded, state, waitPlaying } from './helpers';

// M13 T10: the line in the page. The authority has one seat (`MAX_SESSIONS=1`). A takes it; B's
// title shows the card (why, 1st in line, a wait in words) and Hatch reads as waiting, at 960 px
// and at 390 px wide. B swims as a practice cell from the card, its chip showing the line. A's page
// closes, B hears its seat (the toast, the chip online) and plays on; once its practice cell ends,
// B hatches a recorded creature.

const HUB = 'http://localhost:8838';

test.describe.configure({ mode: 'serial' });

async function attach(testInfo: TestInfo, name: string, page: Page): Promise<void> {
  const png = await page.screenshot();
  mkdirSync('test-results', { recursive: true });
  writeFileSync(`test-results/${name}.png`, png);
  await testInfo.attach(name, { body: png, contentType: 'image/png' });
}

/** The card and the title above it lie wholly inside the viewport. */
async function cardFits(page: Page): Promise<void> {
  const view = page.viewportSize();
  for (const box of [
    await page.getByTestId('queue-card').boundingBox(),
    await page.locator('.title h1').boundingBox(),
  ]) {
    expect(box && view).toBeTruthy();
    if (!box || !view) return;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(view.width);
    expect(box.y + box.height).toBeLessThanOrEqual(view.height);
  }
}

test('a full world queues B with a card, B swims meanwhile, and a freed seat seats it', async ({
  browser,
}, testInfo) => {
  test.setTimeout(120_000);
  const a = await browser.newContext();
  const b = await browser.newContext();
  try {
    const pageA = await a.newPage();
    await openRecorded(pageA, '', HUB);
    await pageA.waitForFunction(() => window.__bs?.state().net.status === 'online');

    // B waits: the card says why, its place and the wait, and Hatch reads as waiting.
    const pageB = await b.newPage();
    await openRecorded(pageB, '', HUB);
    await pageB.waitForFunction(() => window.__bs?.state().queue?.position === 1, undefined, {
      timeout: 15_000,
    });
    const s = await state(pageB);
    expect(s.screen).toBe('title');
    expect(s.queue).toMatchObject({ position: 1, why: 'full' });
    const card = pageB.getByTestId('queue-card');
    await expect(card).toBeVisible();
    await expect(card.locator('.queue-reason')).toHaveText('The water is full');
    await expect(card.locator('.queue-line')).toHaveText(
      /^1st in line · (under a minute|about \d+ min)$/,
    );
    expect(s.net.text).toMatch(/^1st in line · (under a minute|about \d+ min)$/);
    const hatch = pageB.getByTestId('hatch');
    await expect(hatch).toHaveText('Waiting for a place…');
    await expect(hatch).toBeDisabled();
    await expect(pageB.getByTestId('queue-swim')).toBeEnabled();
    await cardFits(pageB);
    await attach(testInfo, 'm13-queue-card-960', pageB);
    await pageB.setViewportSize({ width: 390, height: 844 });
    await expect(card).toBeVisible();
    await cardFits(pageB);
    await attach(testInfo, 'm13-queue-card-390', pageB);
    await pageB.setViewportSize({ width: 960, height: 540 });

    // B swims as a practice cell from the card; its chip shows the line.
    await pageB.getByTestId('queue-swim').click();
    await waitPlaying(pageB);
    expect((await state(pageB)).life.status).toBe('practice');
    await pageB.waitForFunction(() => /^1st in line/.test(window.__bs?.state().net.text ?? ''));

    // A's page closes: B is seated, hears it in a toast, and its chip turns online.
    await a.close();
    await expect(pageB.getByTestId('toast')).toHaveText(
      'A place is free: your next hatch is recorded',
      { timeout: 20_000 },
    );
    await pageB.waitForFunction(() => {
      const st = window.__bs?.state();
      return st?.net.status === 'online' && st.queue === null && /^Online/.test(st.net.text);
    });
    const seated = await state(pageB);
    expect(seated.screen).toBe('playing');
    expect(seated.life.status).toBe('practice');

    // The practice life goes on until it ends; then Hatch is recorded.
    await pageB.evaluate(() => {
      const bs = window.__bs as BsHook;
      bs.debug?.setEnergy(0);
      bs.debug?.timeScale(10);
    });
    await pageB.waitForFunction(() => window.__bs?.state().screen === 'dead', undefined, {
      timeout: 20_000,
    });
    await pageB.evaluate(() => (window.__bs as BsHook).debug?.timeScale(1));
    await expect(pageB.getByTestId('death-queue-card')).toBeHidden();
    const again = pageB.getByTestId('hatch-again');
    await expect(again).toHaveText('Hatch again');
    await again.click();
    await waitPlaying(pageB);
    const life = (await state(pageB)).life;
    expect(life.status).toBe('playing');
    expect(life.creature).toMatch(/^[0-9a-f]{64}$/);
  } finally {
    await a.close().catch(() => {});
    await b.close();
  }
});
