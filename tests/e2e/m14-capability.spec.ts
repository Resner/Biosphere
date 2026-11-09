import { expect, type Page, test } from '@playwright/test';
import { NOTES, PLAIN_WORDS } from '../../src/game/capability';
import { watchErrors } from './engines';
import { clickHatch, openRecorded, state, waitPlaying } from './helpers';

// The capability screen (M14 T6): a browser that lacks what the game needs is told what to do. The
// missing parts are taken away before the page's own scripts run. Without RTCPeerConnection the
// creature is still recorded and plays alone; without IndexedDB the game plays practice cells; without
// WebGL2 the page is plain words, with no canvas and nothing thrown.

const HUB = 'http://localhost:8845';

test.describe.configure({ mode: 'serial' });

test('without RTCPeerConnection the note shows and a recorded creature plays alone', async ({
  page,
}) => {
  await page.addInitScript(() => {
    for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection']) {
      delete (window as unknown as Record<string, unknown>)[name];
    }
  });
  const errors = watchErrors(page, 'capability');
  await openRecorded(page, '', HUB);
  const note = page.getByTestId('capability-note');
  await expect(note).toBeVisible();
  await expect(note).toHaveText(NOTES.rtc);
  await page.screenshot({ path: 'test-results/m14-capability-note.png' });
  const before = await state(page);
  expect(before.capabilities).toMatchObject({ rtc: false, webgl2: true, ws: true, idb: true });
  expect(before.unsupported).toBeNull();

  await clickHatch(page);
  await waitPlaying(page);
  const s = await state(page);
  expect(s.life, 'a recorded creature, not a practice cell').toMatchObject({
    status: 'playing',
    practice: false,
  });
  expect(s.life.creature).toMatch(/^[0-9a-f]{64}$/);
  // It plays: the sim runs on.
  await page.waitForFunction((t) => (window.__bs?.state().tick ?? 0) > t + 30, s.tick, {
    timeout: 30_000,
  });
  // A page that can't link offers no referee duty.
  expect((await state(page)).witness.avail).toBe(false);
  expect(errors).toEqual([]);
});

test('without IndexedDB the practice cell plays with its note', async ({ page }) => {
  await page.addInitScript(() => {
    for (let o: object | null = window; o; o = Object.getPrototypeOf(o)) {
      if (Object.hasOwn(o, 'indexedDB')) delete (o as Record<string, unknown>).indexedDB;
    }
  });
  const errors = watchErrors(page, 'capability');
  await page.goto(`./?debug=1&hub=${HUB}`);
  await page.waitForFunction(() => window.__bs?.ready === true);
  const note = page.getByTestId('capability-note');
  await expect(note).toBeVisible();
  await expect(note).toHaveText(NOTES.idb);
  expect((await state(page)).capabilities.idb).toBe(false);

  await clickHatch(page);
  await page.waitForFunction(() => window.__bs?.state().screen === 'playing', undefined, {
    timeout: 15_000,
  });
  const s = await state(page);
  expect(s.life).toMatchObject({ status: 'practice', practice: true });
  expect(s.net.status, 'it never reaches the hub').toBe('none');
  await expect(page.getByTestId('practice-badge')).toBeVisible();
  await page.waitForFunction((t) => (window.__bs?.state().tick ?? 0) > t + 30, s.tick, {
    timeout: 30_000,
  });
  expect(errors).toEqual([]);
});

test('without WebGL2 the game and the lab are plain pages that say what to do', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      kind: string,
      ...rest: unknown[]
    ) {
      if (kind === 'webgl2') return null;
      return (getContext as (...a: unknown[]) => unknown).call(this, kind, ...rest);
    } as typeof getContext;
  });
  const errors = watchErrors(page, 'capability');
  const words = PLAIN_WORDS.webgl2;

  await page.goto('./?genome=starter');
  await page.waitForFunction(() => window.__bs?.ready === true);
  const plain = page.getByTestId('unsupported');
  await expect(plain).toBeVisible();
  await expect(plain.getByRole('heading', { level: 1 })).toHaveText(words.title);
  for (const line of words.lines) await expect(plain).toContainText(line);
  await expect(page.locator('canvas')).toHaveCount(0);
  const s = await page.evaluate(() => window.__bs?.state());
  expect(s?.unsupported).toBe('webgl2');
  expect(s?.capabilities.webgl2).toBe(false);
  await page.screenshot({ path: 'test-results/m14-capability-webgl2.png' });

  await page.goto('./lab.html');
  await expect(page.getByTestId('unsupported')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(words.title);
  await expect(page.locator('canvas')).toHaveCount(0);
  expect(errors).toEqual([]);
});
