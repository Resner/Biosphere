import { expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { hatch, openGame, state } from './helpers';

// The map in the world (M11 T18), offline at the default 262,144 wu: a square of 8,192 wu around a
// starter, charted from its own depth window, with a linked player as a dot, players known but
// not linked as hollow marks fading with age, and the spawn centre while it is in the square. Shots
// at the spawn and 100,000 wu away.

const SIZE = 262_144;
const CENTRE = { x: SIZE / 2, y: SIZE / 2 } as const;

/** Freezes the player at (x, y) with a linked player and two sightings around it. */
async function stage(page: Page, x: number, y: number): Promise<void> {
  await page.evaluate(
    ({ x, y }) => {
      const d = (window.__bs as BsHook).debug;
      d?.freezeAt(0, x, y);
      d?.setRemotes([{ id: 'linked', name: 'Lin', x: x + 1500, y: y + 800 }]);
      d?.setKnown([
        { id: 'heard', name: 'Her', x: x - 2400, y: y - 1100, age: 0 },
        { id: 'old', name: 'Old', x: x + 900, y: y - 2700, age: 25_000 },
      ]);
    },
    { x, y },
  );
}

/** Waits until the map's chart covers its square and every mark is up. */
async function charted(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const { map } = await state(page);
        return map.open && map.chart && map.players === 2 && map.known === 2;
      },
      { timeout: 30_000, message: 'the map charted around the player with every mark' },
    )
    .toBe(true);
}

/** The share of the map canvas's pixels that are not the darkness beyond the world. */
function chartedShare(page: Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="map-zones"]');
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return 0;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let lit = 0;
    for (let i = 0; i < data.length; i += 4) {
      // The darkness beyond is #020608; the abyss is the darkest water and still bluer.
      const off =
        Math.abs((data[i] as number) - 2) +
        Math.abs((data[i + 1] as number) - 6) +
        Math.abs((data[i + 2] as number) - 8);
      if (off > 4) lit++;
    }
    return lit / (data.length / 4);
  });
}

test('the map charts a square around the player with dots, hollow sightings and the spawn', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await openGame(page, '?debug=1');
  await hatch(page);
  await stage(page, CENTRE.x + 300, CENTRE.y - 200);
  await page.keyboard.press('m');
  await expect(page.getByTestId('pond-map')).toBeVisible();
  await expect(page.getByTestId('pond-map').locator('h2')).toHaveText('Map');
  await charted(page);

  const at = await state(page);
  expect(at.map.side).toBe(8192);
  expect(at.map.spawn).toBe(true);
  expect(at.map.edge).toBe(false);
  const dot = (id: string) => page.locator(`[data-testid="map-dot"][data-id="${id}"]`);
  await expect(dot('linked')).toHaveAttribute('data-mark', 'player');
  await expect(dot('heard')).toHaveAttribute('data-mark', 'known');
  await expect(dot('heard')).toContainText('Her');
  await expect(dot('heard').locator('.map-hollow')).toHaveCount(1);
  await expect(dot('linked').locator('.map-hollow')).toHaveCount(0);
  // The older sighting is fainter.
  const opacity = (id: string) => dot(id).evaluate((el) => Number(getComputedStyle(el).opacity));
  expect(await opacity('old')).toBeLessThan(await opacity('heard'));
  // A linked player north-east of the player sits up and right of the centre.
  const frame = await page.getByTestId('map-frame').boundingBox();
  const linked = await dot('linked').locator('svg').boundingBox();
  expect(frame && linked).toBeTruthy();
  if (frame && linked) {
    const u = (linked.x + linked.width / 2 - frame.x) / frame.width;
    const v = (linked.y + linked.height / 2 - frame.y) / frame.height;
    expect(Math.abs(u - (0.5 + 1500 / 8192))).toBeLessThanOrEqual(0.02);
    expect(Math.abs(v - (0.5 - 800 / 8192))).toBeLessThanOrEqual(0.02);
  }
  expect(await chartedShare(page)).toBeGreaterThan(0.95);
  await page.screenshot({ path: 'test-results/m11-map-spawn.png' });

  // 100,000 wu east of the spawn: a new chart, no spawn and no edge in the square.
  await stage(page, CENTRE.x + 100_000, CENTRE.y);
  await charted(page);
  const far = await state(page);
  expect(far.map.spawn).toBe(false);
  expect(far.map.edge).toBe(false);
  expect(await chartedShare(page)).toBeGreaterThan(0.95);
  await page.screenshot({ path: 'test-results/m11-map-far.png' });

  // Near the world's east edge, the edge is drawn and the darkness beyond it fills the rest.
  await stage(page, SIZE - 1500, CENTRE.y);
  await charted(page);
  expect((await state(page)).map.edge).toBe(true);
  const beyond = await chartedShare(page);
  expect(beyond).toBeLessThan(0.85);
  expect(beyond).toBeGreaterThan(0.5);
  await page.screenshot({ path: 'test-results/m11-map-edge.png' });
});
