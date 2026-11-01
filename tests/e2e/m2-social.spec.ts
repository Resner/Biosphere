import { type Browser, expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { chatTexts, hatch, openGame, openMenu, say, state } from './helpers';

// Chat, emotes, pings and mute between two real browser contexts through the local hub.

// Its own hub (see playwright.config.ts), so the online spec's ponds stay as that test counts them.
const HUB = 'http://localhost:8788';

test.describe.configure({ mode: 'serial' });

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

test('chat is filtered, typing does not steer, mute hides a sender, and cues cross the pond @slow', async ({
  browser,
}) => {
  // Two software-GL browsers hatch and chat: a busy runner needs more than the default 30 s (the
  // online and pond specs get 60 s too).
  test.setTimeout(60_000);
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
    // G opens the wheel at the cursor (M6 T24) and 1 picks the look ping.
    await a.keyboard.press('g');
    await a.keyboard.press('1');
    await b.waitForFunction(() => window.__bs?.state().social.pings.length === 1, undefined, {
      timeout: 2000,
    });
    const own = (await state(a)).social.pings[0];
    const seen = (await state(b)).social.pings[0];
    expect(seen).toEqual(own);
    expect(seen?.kind).toBe(0);
    // A peer's ping and emote have their sounds (M6 T23).
    expect((await state(b)).audio.cues).toMatchObject({ ping: 1, emote: 1, chat: 2 });
    await expect(b.locator('.ping')).toHaveCount(1);

    // B mutes A by clicking A's name in the roster (in the menu): the next message never shows.
    await openMenu(b);
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
