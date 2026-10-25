import { type Browser, expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { hatch, openGame } from './helpers';

// Chat, emotes, pings and mute between two real browser contexts through the local hub.

// Its own hub (see playwright.config.ts), so the online spec's ponds stay as that test counts them.
const HUB = 'http://localhost:8788';

test.describe.configure({ mode: 'serial' });

const state = (page: Page) => page.evaluate(() => (window.__bs as BsHook).state());

async function joined(browser: Browser): Promise<[Page, Page]> {
  const pages: Page[] = [];
  for (let i = 0; i < 2; i++) {
    const page = await (await browser.newContext()).newPage();
    await openGame(page, `?hub=${HUB}`);
    await page.waitForFunction(() => window.__bs?.state().playerId);
    await hatch(page);
    pages.push(page);
  }
  for (const page of pages) {
    await page.waitForFunction(() => window.__bs?.state().net.open === 1, undefined, {
      timeout: 10_000,
    });
  }
  return pages as [Page, Page];
}

async function say(page: Page, text: string): Promise<void> {
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('chat-input')).toBeVisible();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('chat-input')).toBeHidden();
}

const chatTexts = (page: Page) =>
  page.evaluate(() => (window.__bs as BsHook).state().social.chat.map((l) => l.text));

test('chat is filtered, typing does not steer, mute hides a sender, and cues cross the pond', async ({
  browser,
}) => {
  const [a, b] = await joined(browser);
  try {
    const aId = (await state(a)).playerId as string;
    // The hub's pond is the whole world: the player spawns near its centre, not in a corner.
    const spawn = (await state(a)).player;
    expect(Math.abs((spawn?.x ?? 0) - 4096)).toBeLessThan(1500);

    // Typing spaces into the chat input does not dash.
    await a.keyboard.press('Enter');
    await a.keyboard.type('a b  c');
    await a.keyboard.press('Escape');
    await expect(a.getByTestId('chat-input')).toBeHidden();
    expect((await state(a)).social.chat).toEqual([]);
    const events = await a.evaluate(() => (window.__bs as BsHook).events());
    expect(events.dash ?? 0).toBe(0);

    await say(a, 'hello pond');
    await b.waitForFunction(() => window.__bs?.state().social.chat.length === 1, undefined, {
      timeout: 2000,
    });
    expect(await chatTexts(b)).toEqual(['hello pond']);
    await expect(b.getByTestId('chat-log')).toContainText('hello pond');

    // Profanity comes out filtered, on the sender's side already.
    await say(a, 'you fuck');
    await b.waitForFunction(() => window.__bs?.state().social.chat.length === 2, undefined, {
      timeout: 2000,
    });
    expect((await chatTexts(b))[1]).toBe('you ****');

    // An emote and a ping reach B, and B sees the ping at A's world position.
    await a.keyboard.press('t');
    await a.keyboard.press('3');
    await b.waitForFunction(
      () => window.__bs?.state().social.emotes.some((e) => e.emote === 2),
      undefined,
      {
        timeout: 2000,
      },
    );
    const { width, height } = a.viewportSize() ?? { width: 960, height: 540 };
    await a.mouse.move(width / 2 + 100, height / 2);
    await a.keyboard.press('g');
    await b.waitForFunction(() => window.__bs?.state().social.pings.length === 1, undefined, {
      timeout: 2000,
    });
    const own = (await state(a)).social.pings[0];
    const seen = (await state(b)).social.pings[0];
    expect(seen).toEqual(own);
    expect(seen?.kind).toBe(0);
    await expect(b.locator('.ping')).toHaveCount(1);

    // B mutes A by clicking A's name in the roster: the next message never shows.
    await b.getByTestId('roster').getByRole('button').click();
    expect((await state(b)).social.muted).toEqual([aId]);
    await expect(b.getByTestId('roster').getByRole('button')).toContainText('muted');
    await say(a, 'still there?');
    await a.waitForTimeout(1000);
    // Muting also cleared A's earlier lines, and the new message never arrived.
    expect(await chatTexts(b)).toEqual([]);

    // The mute survives a reload.
    await b.reload();
    await b.waitForFunction(() => window.__bs?.ready === true);
    expect((await state(b)).social.muted).toEqual([aId]);
  } finally {
    await Promise.all([a, b].map((p) => p.context().close()));
  }
});
