import { type Browser, expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { hatch, openGame } from './helpers';

// The online session against the local Worker (`wrangler dev`, started by Playwright): real hub
// signaling and real WebRTC between browser contexts, over host candidates only.

const HUB = 'http://localhost:8787';

// One hub serves every test, and it fills the fullest pond first: tests run one at a time so that
// a pond holds only the players of the test that is running.
test.describe.configure({ mode: 'serial' });

const state = (page: Page) => page.evaluate(() => (window.__bs as BsHook).state());

async function player(browser: Browser, query = `?debug=1&hub=${HUB}`): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await openGame(page, query);
  return page;
}

test('three players share a pond, see each other and keep it after dying', async ({ browser }) => {
  const pages = await Promise.all([player(browser), player(browser), player(browser)]);
  try {
    await Promise.all(pages.map((p) => p.waitForFunction(() => window.__bs?.state().playerId)));
    // Hatch one after the other: a hatch waits for its hub welcome, and they land in one pond.
    for (const page of pages) await hatch(page);
    for (const page of pages) {
      await page.waitForFunction(() => window.__bs?.state().remotes.length === 2, undefined, {
        timeout: 5000,
      });
    }
    const states = await Promise.all(pages.map(state));
    const [first] = states;
    for (const s of states) {
      expect(s.pond?.id).toBe(first?.pond?.id);
      expect(s.pond?.seed).toBe(first?.pond?.seed);
      expect(s.pond?.members).toHaveLength(3);
      expect(s.net.text).toBe('Online · 3 in pond');
      expect(s.net.open).toBe(2);
    }
    const [a, b] = pages;
    if (!a || !b) throw new Error('three pages expected');

    // Dying and hatching again keeps the pond and the connections.
    const before = (await state(a)).pond;
    await a.evaluate(() => {
      const bs = window.__bs as BsHook;
      const { x, y } = bs.state().player as { x: number; y: number };
      bs.debug?.spawnPlume(x, y, 120);
      bs.debug?.setEnergy(0);
    });
    await a.waitForFunction(() => window.__bs?.state().screen === 'dead', undefined, {
      timeout: 15_000,
    });
    // B no longer sees A's cell while A is dead.
    await b.waitForFunction(
      (id) => !window.__bs?.state().remotes.some((r) => r.id === id && r.alpha > 0),
      states[0]?.playerId ?? '',
      { timeout: 5000 },
    );
    await a.getByRole('button', { name: 'Hatch again' }).click();
    await a.waitForFunction(() => window.__bs?.state().screen === 'playing');
    const after = await state(a);
    expect(after.pond).toEqual(before);
    expect(after.net.open).toBe(2);
    expect(after.remotes).toHaveLength(2);
  } finally {
    await Promise.all(pages.map((p) => p.context().close()));
  }
});

test('an unreachable hub means a local pond and an offline chip', async ({ browser }) => {
  const page = await player(browser, '?debug=1&hub=http://localhost:1');
  try {
    await expect(page.getByTestId('net-status')).toHaveText('Offline · playing alone');
    await hatch(page);
    const s = await state(page);
    expect(s.player?.alive).toBe(true);
    expect(s.pond).toBeNull();
    expect(s.net.text).toBe('Offline · playing alone');
    // No hub, so no "alone in the pond" hint either.
    await expect(page.getByTestId('alone-hint')).toBeHidden();
  } finally {
    await page.context().close();
  }
});

test('the name is remembered and a bad one is refused', async ({ browser }) => {
  const page = await player(browser);
  try {
    const input = page.getByTestId('name-input');
    await expect(input).toHaveValue(/^Cell\d{4}$/);
    await input.fill('x');
    await page.getByRole('button', { name: 'Hatch', exact: true }).click();
    await expect(page.getByTestId('name-error')).toHaveText('Pick another name');
    expect((await state(page)).screen).toBe('title');
    await input.fill('Ada_1');
    await page.getByRole('button', { name: 'Hatch', exact: true }).click();
    await page.waitForFunction(() => window.__bs?.state().screen === 'playing');
    await page.reload();
    await page.waitForFunction(() => window.__bs?.ready === true);
    await expect(page.getByTestId('name-input')).toHaveValue('Ada_1');
  } finally {
    await page.context().close();
  }
});

test('a lone player is told so after eight seconds @slow', async ({ browser }) => {
  const page = await player(browser, `?hub=${HUB}`);
  try {
    await hatch(page);
    await expect(page.getByTestId('alone-hint')).toBeHidden();
    await expect(page.getByTestId('alone-hint')).toBeVisible({ timeout: 12_000 });
    await expect(page.getByTestId('alone-hint')).toHaveText('Alone in the pond. Share the link.');
    // Someone arrives: the hint clears.
    const other = await player(browser);
    try {
      await hatch(other);
      await expect(page.getByTestId('alone-hint')).toBeHidden({ timeout: 5000 });
    } finally {
      await other.context().close();
    }
  } finally {
    await page.context().close();
  }
});
