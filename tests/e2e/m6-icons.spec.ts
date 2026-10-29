import { expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { hatch, openGame } from './helpers';

// Production icons (M6 T25, #89): every ping and emote is drawn with its own SVG icon, titled for
// screen readers and with no text glyph, wherever it shows: the wheel, over a creature, the ping
// mark, the edge indicator, the pond map and chat's T shortcut. The icon sheet at 20 and 40 px is
// saved for the PR (judged by eye) and its shapes are checked to differ.

const PINGS = ['look', 'danger', 'food', 'mate'];
const EMOTES = ['wave', 'happy', 'love', 'angry', 'scared', 'question'];
const TITLES = Object.fromEntries(
  [...PINGS, ...EMOTES].map((name) => [name, name[0]?.toUpperCase() + name.slice(1)]),
);
/** The text glyphs the icons replaced. */
const OLD_GLYPHS = /[≋☺♥✖◎▲◆]/;

/**
 * What every visible element matching `selector` draws, one line each, sorted and without repeats:
 * the name of each SVG in it with its role, its title and whether it is at least 12 px wide, then
 * the text it shows outside its SVGs (an icon's <title> is never drawn).
 */
const drawn = (page: Page, selector: string) =>
  page.evaluate((selector) => {
    const lines = new Set<string>();
    for (const el of Array.from(document.querySelectorAll(selector))) {
      if (el.getClientRects().length === 0) continue;
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let text = '';
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.parentElement?.closest('svg')) text += n.textContent ?? '';
      }
      const icons = Array.from(el.querySelectorAll('svg'), (svg) =>
        [
          svg.getAttribute('data-icon'),
          svg.getAttribute('role'),
          svg.querySelector(':scope > title')?.textContent,
          svg.getBoundingClientRect().width >= 12 ? 'drawn' : 'tiny',
        ].join(' '),
      );
      lines.add(`${icons.join(' + ')} | ${text.trim()}`);
    }
    return [...lines].sort();
  }, selector);

/** The line `drawn` gives for an element showing only the icon `name`, and `text` beside it. */
const only = (name: string, text = '') => `${name} img ${TITLES[name]} drawn | ${text}`;

/** Polls until the elements matching `selector` draw exactly `lines` (in any order). */
const expectDrawn = (page: Page, selector: string, lines: string[]) =>
  expect.poll(() => drawn(page, selector), { timeout: 5_000 }).toEqual([...lines].sort());

/** The player's position, the scale and the view's half size in world units. */
async function around(page: Page) {
  return page.evaluate(() => {
    const hook = window.__bs as BsHook;
    const player = hook.state().player;
    if (!player) throw new Error('not playing');
    const { pxPerWu } = hook.render.info();
    return {
      x: player.x,
      y: player.y,
      pxPerWu,
      halfW: window.innerWidth / 2 / pxPerWu,
      halfH: window.innerHeight / 2 / pxPerWu,
    };
  });
}

test('every ping and emote is an SVG icon with a title, never a text glyph', async ({ page }) => {
  test.setTimeout(45_000);
  await openGame(page, '?debug=1&seed=icons');
  await hatch(page);
  await page.evaluate(() => (window.__bs as BsHook).debug?.timeScale(0));
  const { width, height } = page.viewportSize() ?? { width: 960, height: 540 };

  // The wheel: each item shows its icon, then only its name and key as text.
  await page.mouse.move(width / 2, height / 2);
  await page.keyboard.press('g');
  await expectDrawn(
    page,
    '[data-testid="wheel-item"]',
    [...PINGS, ...EMOTES].map((name, i) => only(name, `${name}${(i + 1) % 10}`)),
  );
  await page.screenshot({ path: 'test-results/m6-icons-wheel.png' });
  await page.keyboard.press('Escape');

  // Chat's shortcut: T shows the six emotes on 1–6, and 1 waves over the player's creature.
  await page.keyboard.press('t');
  await expectDrawn(
    page,
    '[data-testid="emote-choice"]',
    EMOTES.map((name, i) => only(name, String(i + 1))),
  );
  await page.screenshot({ path: 'test-results/m6-icons-chat.png' });
  await page.keyboard.press('1');
  await expect(page.getByTestId('emote-strip')).toBeHidden();
  await expectDrawn(page, '.emote', [only('wave')]);

  // Six peers on screen, each with one emote over its creature (the player's own wave, if still
  // up, draws the same line as peer 0's).
  const me = await around(page);
  const peers = EMOTES.map((_, i) => ({
    id: `peer-${i}`,
    name: `Peer ${i}`,
    x: me.x + ((i % 3) - 1) * (220 / me.pxPerWu),
    y: me.y + (i < 3 ? 150 : -120) / me.pxPerWu,
  }));
  await page.evaluate((list) => (window.__bs as BsHook).debug?.setRemotes(list), peers);
  await page.waitForFunction(() => window.__bs?.state().remotes.length === 6);
  await page.evaluate(() => {
    for (let i = 0; i < 6; i++)
      (window.__bs as BsHook).debug?.deliver(`peer-${i}`, { t: 'emote', id: i });
  });
  await expectDrawn(
    page,
    '.emote',
    EMOTES.map((name) => only(name)),
  );
  await page.screenshot({ path: 'test-results/m6-icons-emotes.png' });

  // Each ping kind as a mark on screen, from peers 0–3 (a ping shows for 4 s).
  const pingAt = (spots: { kind: number; x: number; y: number }[]) =>
    page.evaluate((list) => {
      for (const { kind, x, y } of list)
        (window.__bs as BsHook).debug?.deliver(`peer-${kind}`, { t: 'ping', kind, x, y });
    }, spots);
  await pingAt(
    PINGS.map((_, kind) => ({
      kind,
      x: me.x + ((kind - 1.5) * 110) / me.pxPerWu,
      y: me.y - 60 / me.pxPerWu,
    })),
  );
  await expectDrawn(
    page,
    '.ping',
    PINGS.map((name) => only(name)),
  );
  await page.screenshot({ path: 'test-results/m6-icons-pings.png' });

  // And each off screen but near, on the edge, after the peers' limit of a ping a second.
  await page.waitForTimeout(1100);
  const off: [number, number][] = [
    [-1.5 * me.halfW, 0],
    [1.5 * me.halfW, 0],
    [0, 1.6 * me.halfH],
    [0, -1.6 * me.halfH],
  ];
  await pingAt(off.map(([dx, dy], kind) => ({ kind, x: me.x + dx, y: me.y + dy })));
  await expectDrawn(
    page,
    '[data-testid="edge-indicator"][data-kind="ping"] .edge-glyph',
    PINGS.map((name) => only(name)),
  );
  await page.screenshot({ path: 'test-results/m6-icons-edges.png' });

  // The pond map marks each ping with its icon.
  await page.keyboard.press('m');
  await expect(page.getByTestId('pond-map')).toBeVisible();
  await expectDrawn(
    page,
    '[data-testid="map-ping"]',
    PINGS.map((name) => only(name)),
  );
  await page.screenshot({ path: 'test-results/m6-icons-map.png' });

  // No old glyph is left anywhere on the page.
  expect(await page.locator('body').textContent()).not.toMatch(OLD_GLYPHS);
});

test('the icon sheet at 20 and 40 px: every icon a distinct shape', async ({ page }) => {
  await openGame(page, '?debug=1');
  await hatch(page);
  await page.keyboard.press('g');
  const icons = await page
    .locator('[data-testid="wheel-item"] svg.icon')
    .evaluateAll((all) => all.map((svg) => svg.outerHTML));
  expect(icons).toHaveLength(10);
  // The sheet carries the icons' glow from the game's CSS.
  const style = await page.evaluate(() => {
    const icon = document.querySelector('[data-testid="wheel-item"] svg.icon') as SVGElement;
    return getComputedStyle(icon).filter;
  });
  const cell = (svg: string, size: number) =>
    `<div style="width:${size}px;height:${size}px">${svg}</div>`;
  await page.setContent(
    `<!doctype html><body style="margin:0;padding:12px;background:#04090b;color:#e3f4f0;font:11px system-ui">
    <style>svg{display:block;width:100%;height:100%;overflow:visible;filter:${style}}
    .row{display:flex;gap:16px;align-items:center;margin-bottom:12px}
    .row>div:first-child{width:40px}</style>
    <div class="row"><div>20 px</div>${icons.map((svg) => cell(svg, 20)).join('')}</div>
    <div class="row"><div>40 px</div>${icons.map((svg) => cell(svg, 40)).join('')}</div>
    </body>`,
  );
  await page.setViewportSize({ width: 620, height: 120 });
  await page.screenshot({ path: 'test-results/m6-icons-sheet.png' });

  // Drawn alone at 20 px, no two icons share more than 60% of their lit pixels (the three faces
  // differ in outline as well as features: round, bristling, shivering).
  const overlap = await page.evaluate(async (list) => {
    const masks: boolean[][] = [];
    for (const markup of list) {
      const svg = markup.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" color="#fff" ');
      const image = new Image(20, 20);
      image.src = `data:image/svg+xml,${encodeURIComponent(svg)}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = 20;
      canvas.height = 20;
      const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
      ctx.drawImage(image, 0, 0, 20, 20);
      const { data } = ctx.getImageData(0, 0, 20, 20);
      masks.push(Array.from({ length: 400 }, (_, i) => (data[i * 4 + 3] as number) > 96));
    }
    let worst = 0;
    for (let a = 0; a < masks.length; a++) {
      for (let b = a + 1; b < masks.length; b++) {
        let both = 0;
        let either = 0;
        for (let i = 0; i < 400; i++) {
          if (masks[a]?.[i] && masks[b]?.[i]) both++;
          if (masks[a]?.[i] || masks[b]?.[i]) either++;
        }
        worst = Math.max(worst, both / either);
      }
    }
    return worst;
  }, icons);
  expect(overlap).toBeLessThan(0.6);
});
