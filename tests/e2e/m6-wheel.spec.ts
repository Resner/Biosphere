import { type Browser, expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { hatch, M6_WHEEL_HUB, openGame, playerOf, state } from './helpers';

// The quick social wheel (M6 T24, #89): G opens a ring of 4 pings and 6 emotes at the cursor; a
// number, a release over an item or a click sends one on purpose, and Esc or a release in the
// centre after a hold sends nothing. The middle button still sends a quick look ping.

test.describe.configure({ mode: 'serial' });

async function joinTwo(browser: Browser): Promise<[Page, Page]> {
  const pages: Page[] = [];
  for (let i = 0; i < 2; i++) {
    const page = await (await browser.newContext()).newPage();
    await openGame(page, `?debug=1&hub=${M6_WHEEL_HUB}`);
    await page.waitForFunction(() => window.__bs?.state().playerId);
    // One after the other: a hatch waits for its hub welcome, and both land in one pond.
    await hatch(page);
    pages.push(page);
  }
  for (const page of pages) {
    await page.waitForFunction(() => window.__bs?.state().remotes.length === 1, undefined, {
      timeout: 10_000,
    });
  }
  return pages as [Page, Page];
}

/** The world point under a screen point, from the camera as drawn. */
async function worldUnder(page: Page, px: number, py: number): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ([px, py]) => {
      const { camX, camY, halfHeight } = (window.__bs as BsHook).render.fx();
      const pxPerWu = window.innerHeight / (2 * halfHeight);
      return {
        x: camX + (px - window.innerWidth / 2) / pxPerWu,
        y: camY - (py - window.innerHeight / 2) / pxPerWu,
      };
    },
    [px, py] as const,
  );
}

/** Ping and emote cues heard so far (each one shown counts, the player's own too). */
const heard = async (page: Page) => {
  const { cues } = (await state(page)).audio;
  return { ping: cues.ping ?? 0, emote: cues.emote ?? 0 };
};

test('G opens the wheel at the cursor; a number, a release or the middle button sends, Esc cancels, movement carries on', async ({
  page,
}) => {
  test.setTimeout(45_000);
  await openGame(page, '?debug=1');
  await hatch(page);
  const { width, height } = page.viewportSize() ?? { width: 960, height: 540 };
  // Frozen, so the camera holds still while the cursor's world point is read.
  await page.evaluate(() => (window.__bs as BsHook).debug?.timeScale(0));
  await page.waitForTimeout(300);

  // A tap of G opens the wheel at the cursor and leaves it open, with targets of at least 44 px.
  expect((await state(page)).wheel).toMatchObject({ open: false, items: [] });
  const cursor = { x: width / 2 + 150, y: height / 2 - 60 };
  await page.mouse.move(cursor.x, cursor.y);
  const expected = await worldUnder(page, cursor.x, cursor.y);
  await page.keyboard.press('g');
  const open = (await state(page)).wheel;
  expect(open.open).toBe(true);
  expect(open.centre).toEqual(cursor);
  expect(open.items.map((i) => `${i.key} ${i.name}`)).toEqual([
    '1 look',
    '2 danger',
    '3 food',
    '4 mate',
    '5 wave',
    '6 happy',
    '7 love',
    '8 angry',
    '9 scared',
    '0 question',
  ]);
  await expect(page.getByTestId('wheel')).toBeVisible();
  const items = page.getByTestId('wheel-item');
  await expect(items).toHaveCount(10);
  for (const box of await Promise.all((await items.all()).map((item) => item.boundingBox()))) {
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({ path: 'test-results/m6-wheel-open.png' });

  // 3 is the food ping, at the cursor's world position.
  await page.keyboard.press('3');
  expect((await state(page)).wheel.open).toBe(false);
  const [ping] = (await state(page)).social.pings;
  expect(ping?.kind).toBe(2);
  expect(Math.hypot((ping?.x ?? 0) - expected.x, (ping?.y ?? 0) - expected.y)).toBeLessThan(2);

  // Holding G and releasing over "happy" shows it over the player's creature.
  await page.keyboard.down('g');
  const happy = (await state(page)).wheel.items.find((i) => i.name === 'happy');
  await page.mouse.move(happy?.x ?? 0, happy?.y ?? 0, { steps: 4 });
  await expect(
    page.locator('[data-testid="wheel-item"][data-name="happy"][data-lit="true"]'),
  ).toBeVisible();
  await page.keyboard.up('g');
  expect((await state(page)).wheel.open).toBe(false);
  expect((await state(page)).social.emotes.map((e) => e.emote)).toEqual([1]);
  const emote = page.locator('.emote[data-emote="1"]');
  await expect(emote).toBeVisible();
  const box = await emote.boundingBox();
  // The camera is on the creature: the emote sits above the screen's centre.
  expect(Math.abs((box?.x ?? 0) + (box?.width ?? 0) / 2 - width / 2)).toBeLessThan(30);
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThan(height / 2);

  // Esc closes it without sending, and so does releasing in the centre after a hold; neither
  // opens the menu behind it.
  const before = await heard(page);
  await page.mouse.move(cursor.x, cursor.y);
  await page.keyboard.press('g');
  expect((await state(page)).wheel.open).toBe(true);
  await page.keyboard.press('Escape');
  expect((await state(page)).wheel.open).toBe(false);
  await expect(page.getByTestId('lineage')).toBeHidden();
  await page.keyboard.down('g');
  await page.waitForTimeout(400);
  await page.keyboard.up('g');
  expect((await state(page)).wheel.open).toBe(false);
  expect(await heard(page)).toEqual(before);

  // The middle button still sends a quick look ping.
  await page.waitForTimeout(1000);
  await page.mouse.click(cursor.x, cursor.y, { button: 'middle' });
  // (The food ping has run out its 4 s by now.)
  expect((await state(page)).social.pings.map((p) => p.kind).at(-1)).toBe(0);
  expect((await heard(page)).ping).toBe(before.ping + 1);

  // The wheel never stops you (#183): swimming right at full throttle, a second with the wheel
  // open covers about what a second with it closed does, and the heading holds while the cursor
  // moves over the items.
  await page.evaluate(() => (window.__bs as BsHook).debug?.timeScale(1));
  const travel = async () => {
    const from = await playerOf(page);
    await page.waitForTimeout(1000);
    const to = await playerOf(page);
    return {
      dist: Math.hypot(to.x - from.x, to.y - from.y),
      heading: Math.atan2(to.y - from.y, to.x - from.x),
    };
  };
  await page.mouse.move(width - 10, height / 2);
  await page.waitForTimeout(1500);
  const closed = await travel();
  expect(closed.dist).toBeGreaterThan(10);
  await page.keyboard.press('g');
  expect((await state(page)).wheel.open).toBe(true);
  const sweep = (async () => {
    const path: [number, number][] = [
      [width / 2, 40],
      [40, height / 2],
      [width / 2, height - 40],
    ];
    for (const [x, y] of path) {
      await page.mouse.move(x, y);
      await page.waitForTimeout(250);
    }
  })();
  const during = await travel();
  await sweep;
  expect(during.dist).toBeGreaterThanOrEqual(closed.dist * 0.8);
  let turn = Math.abs(during.heading - closed.heading);
  if (turn > Math.PI) turn = 2 * Math.PI - turn;
  expect(turn).toBeLessThan((5 * Math.PI) / 180);
  // Cancelling with Esc changes nothing about it.
  await page.keyboard.press('Escape');
  expect((await state(page)).wheel.open).toBe(false);
  await page.mouse.move(width - 10, height / 2);
  const after = await travel();
  expect(after.dist).toBeGreaterThanOrEqual(closed.dist * 0.8);
});

test('B sees the ping A picks at its cursor and the emote over A, and nothing A cancels @slow', async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const [a, b] = await joinTwo(browser);
  try {
    const idA = (await state(a)).playerId as string;
    const { width, height } = a.viewportSize() ?? { width: 960, height: 540 };
    // B beside A, so A's emote is on B's screen; A frozen, so its camera holds still.
    const pa = await playerOf(a);
    await b.evaluate(([x, y]) => (window.__bs as BsHook).debug?.teleport(x, y), [
      pa.x + 40,
      pa.y,
    ] as const);
    await a.evaluate(() => (window.__bs as BsHook).debug?.timeScale(0));
    await a.waitForTimeout(500);

    // A tap of G opens the wheel at the cursor; it stays open, with targets of at least 44 px.
    expect((await state(a)).wheel.open).toBe(false);
    const cursor = { x: width / 2 + 150, y: height / 2 - 60 };
    await a.mouse.move(cursor.x, cursor.y);
    const expected = await worldUnder(a, cursor.x, cursor.y);
    await a.keyboard.press('g');
    const open = (await state(a)).wheel;
    expect(open.open).toBe(true);
    expect(open.items.map((i) => i.name)).toEqual([
      'look',
      'danger',
      'food',
      'mate',
      'wave',
      'happy',
      'love',
      'angry',
      'scared',
      'question',
    ]);
    await expect(a.getByTestId('wheel')).toBeVisible();
    const items = a.getByTestId('wheel-item');
    await expect(items).toHaveCount(10);
    for (const box of await Promise.all((await items.all()).map((item) => item.boundingBox()))) {
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    await a.screenshot({ path: 'test-results/m6-wheel-open.png' });

    // 3 is the food ping: B sees it where A's cursor pointed.
    await a.keyboard.press('3');
    expect((await state(a)).wheel.open).toBe(false);
    await expect
      .poll(async () => (await state(b)).social.pings.filter((p) => p.from === idA).length, {
        timeout: 5_000,
      })
      .toBe(1);
    const ping = (await state(b)).social.pings.find((p) => p.from === idA);
    expect(ping?.kind).toBe(2);
    expect(Math.hypot((ping?.x ?? 0) - expected.x, (ping?.y ?? 0) - expected.y)).toBeLessThan(2);

    // Holding G and releasing over "happy" shows the emote over A on B's screen.
    await a.keyboard.down('g');
    const happy = (await state(a)).wheel.items.find((i) => i.name === 'happy');
    expect(happy).toBeDefined();
    await a.mouse.move(happy?.x ?? 0, happy?.y ?? 0, { steps: 4 });
    await expect(
      a.locator('[data-testid="wheel-item"][data-name="happy"][data-lit="true"]'),
    ).toBeVisible();
    await a.keyboard.up('g');
    expect((await state(a)).wheel.open).toBe(false);
    await expect
      .poll(async () => (await state(b)).social.emotes.find((e) => e.from === idA)?.emote, {
        timeout: 5_000,
      })
      .toBe(1);
    const emote = b.locator('.emote[data-emote="1"]');
    await expect(emote).toBeVisible();
    const [box, onB] = await Promise.all([
      emote.boundingBox(),
      b.evaluate((id) => {
        const hook = window.__bs as BsHook;
        const { camX, camY, halfHeight } = hook.render.fx();
        const r = hook.state().remotes.find((v) => v.id === id);
        const pxPerWu = window.innerHeight / (2 * halfHeight);
        return r
          ? {
              x: window.innerWidth / 2 + (r.x - camX) * pxPerWu,
              y: window.innerHeight / 2 - (r.y - camY) * pxPerWu,
            }
          : null;
      }, idA),
    ]);
    expect(box).not.toBeNull();
    expect(onB).not.toBeNull();
    if (box && onB) {
      expect(Math.abs(box.x + box.width / 2 - onB.x)).toBeLessThan(30);
      expect(box.y + box.height).toBeLessThan(onB.y);
    }

    // Esc closes it without sending, and so does releasing in the centre after a hold; neither
    // opens the menu behind it. (The emote's 1 s rate limit has long passed, so it hides nothing.)
    const [before, own] = await Promise.all([heard(b), heard(a)]);
    await a.mouse.move(cursor.x, cursor.y);
    await a.keyboard.press('g');
    expect((await state(a)).wheel.open).toBe(true);
    await a.keyboard.press('Escape');
    expect((await state(a)).wheel.open).toBe(false);
    await expect(a.getByTestId('lineage')).toBeHidden();
    await a.keyboard.down('g');
    await a.waitForTimeout(400);
    await a.keyboard.up('g');
    expect((await state(a)).wheel.open).toBe(false);
    await a.waitForTimeout(800);
    expect(await Promise.all([heard(b), heard(a)])).toEqual([before, own]);

    // The middle button still sends a quick look ping.
    await a.mouse.click(cursor.x, cursor.y, { button: 'middle' });
    await expect
      .poll(
        async () =>
          (await state(b)).social.pings.filter((p) => p.from === idA && p.kind === 0).length,
        { timeout: 5_000 },
      )
      .toBe(1);
  } finally {
    await Promise.all([a, b].map((p) => p.context().close()));
  }
});
