import { expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { hatch, openGame, state } from './helpers';

// The minimap, smooth (M6c T12): the player's arrow is its own CSS-rotated layer, turned on every
// frame, while the map under it draws at most 30 times a second. The depth is a slim gauge left of
// the map, zone bands from the surface down with a "◂" marker and the depth in metres, so no round
// mark on the map can be mistaken for a player or a ping.

const DEG = 180 / Math.PI;
/** The gap between two bearings in degrees, 0..180. */
const turn = (a: number, b: number) => Math.abs(((((a - b) % 360) + 540) % 360) - 180);

/** The drawn heading in degrees, as the minimap last took it. */
const heading = (page: Page) =>
  page.evaluate(() => ((window.__bs as BsHook).state().minimap.heading * 180) / Math.PI);

test('the arrow follows a turn frame by frame, and the map draws at most 31 times a second', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await openGame(page, '?debug=1&seed=m6c-minimap');
  await hatch(page);
  await expect(page.getByTestId('minimap-arrow')).toBeVisible();

  // At most 31 draws a second: count the zone picture's draws on the minimap's canvas for 2 s.
  const draws = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const canvas = document.querySelector('[data-testid="minimap-canvas"]');
        const proto = CanvasRenderingContext2D.prototype;
        const original = proto.drawImage;
        let n = 0;
        proto.drawImage = function (this: CanvasRenderingContext2D, ...args: unknown[]) {
          if (this.canvas === canvas) n++;
          return (original as (...a: unknown[]) => void).apply(this, args);
        } as typeof original;
        setTimeout(() => {
          proto.drawImage = original;
          resolve(n);
        }, 2000);
      }),
  );
  expect(draws).toBeGreaterThan(0);
  expect(draws).toBeLessThanOrEqual(62);

  // Face east, then turn to the west, slowed so the turn spans many frames on any runner.
  await page.keyboard.down('d');
  await expect
    .poll(async () => turn(await heading(page), 0), {
      timeout: 10_000,
      message: 'the cell faces east',
    })
    .toBeLessThan(3);
  await page.evaluate(() => {
    (window.__bs as BsHook).debug?.timeScale(0.25);
    const rec = { samples: [] as { css: string; heading: number }[], stop: false };
    const arrow = document.querySelector('[data-testid="minimap-arrow"]') as HTMLElement;
    const record = () => {
      if (rec.stop) return;
      // The element and the hook in the same frame: one render writes both.
      rec.samples.push({
        css: getComputedStyle(arrow).transform,
        heading: (window.__bs as BsHook).state().minimap.heading,
      });
      requestAnimationFrame(record);
    };
    (window as unknown as { __arrow: typeof rec }).__arrow = rec;
    requestAnimationFrame(record);
  });
  await page.keyboard.up('d');
  await page.keyboard.down('a');
  await expect
    .poll(async () => turn(await heading(page), 180), {
      timeout: 30_000,
      message: 'the cell turns to face west',
    })
    .toBeLessThan(3);
  await page.keyboard.up('a');
  const samples = await page.evaluate(() => {
    const rec = (
      window as unknown as {
        __arrow: { samples: { css: string; heading: number }[]; stop: boolean };
      }
    ).__arrow;
    rec.stop = true;
    return rec.samples;
  });
  expect(samples.length).toBeGreaterThan(5);
  const angles: number[] = [];
  for (const [i, sample] of samples.entries()) {
    // matrix(cos, sin, -sin, cos, 0, 0): CSS turns clockwise, y down; the heading counter-clockwise.
    const m = /^matrix\(([^,]+), ([^,]+),/.exec(sample.css);
    expect(m, `frame ${i}: ${sample.css}`).not.toBeNull();
    const drawn = -Math.atan2(Number(m?.[2]), Number(m?.[1])) * DEG;
    expect(turn(drawn, sample.heading * DEG), `frame ${i}`).toBeLessThan(1);
    angles.push(drawn);
  }
  // It swept through the turn: from about east to about west, through the angles between.
  expect(turn(angles[0] as number, 0)).toBeLessThan(10);
  expect(turn(angles[angles.length - 1] as number, 180)).toBeLessThan(10);
  const between = new Set(
    angles.filter((a) => turn(a, 0) > 20 && turn(a, 180) > 20).map((a) => Math.round(a)),
  );
  expect(between.size, 'distinct arrow angles mid-turn').toBeGreaterThanOrEqual(3);
  await page.getByTestId('minimap').screenshot({ path: 'test-results/m6c-minimap-arrow.png' });
});

test('the depth gauge marks the depth left of the map, and the map draws no round mark of its own', async ({
  page,
}) => {
  await openGame(page, '?debug=1&seed=m6c-minimap');
  await hatch(page);
  await page.evaluate(() => (window.__bs as BsHook).debug?.timeScale(0));
  const gauge = page.getByTestId('minimap-depth');
  await expect(gauge).toBeVisible();
  await expect(gauge).toHaveAttribute('title', 'Depth');

  // Alone, with no pings: nothing round is painted on the map, only its clip and its rim.
  expect((await state(page)).minimap.marks).toEqual({ players: 0, pings: 0 });
  const small = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const canvas = document.querySelector('[data-testid="minimap-canvas"]');
        const proto = CanvasRenderingContext2D.prototype;
        const original = proto.arc;
        const side = (canvas as HTMLElement).clientWidth;
        let n = 0;
        proto.arc = function (
          this: CanvasRenderingContext2D,
          ...args: Parameters<typeof original>
        ) {
          if (this.canvas === canvas && args[2] < side / 4) n++;
          return original.apply(this, args);
        };
        setTimeout(() => {
          proto.arc = original;
          resolve(n);
        }, 500);
      }),
  );
  expect(small, 'small round marks on the map').toBe(0);

  const disc = await page.getByTestId('minimap').boundingBox();
  if (!disc) throw new Error('no minimap');
  const marker = page.getByTestId('minimap-depth-marker');
  const hazard = page.getByTestId('minimap-hazard');
  let last = -Infinity;
  for (const [zone, shown] of [
    ['shallows', 'uv'],
    ['twilight', null],
    ['deep', null],
    ['abyss', 'pressure'],
  ] as const) {
    await page.evaluate((z) => (window.__bs as BsHook).debug?.setZone(z), zone);
    await expect.poll(async () => (await state(page)).minimap.zone).toBe(zone);
    const s = await state(page);
    const metres = Math.round((s.minimap.depth ?? 0) * 1000);
    await expect(page.getByTestId('minimap-depth-text')).toHaveText(`${metres} m`);
    const box = await marker.boundingBox();
    const gaugeBox = await gauge.boundingBox();
    if (!box || !gaugeBox) throw new Error('no depth marker');
    // Left of the map, inside the gauge's height, and lower for each deeper zone.
    expect(gaugeBox.x + gaugeBox.width, zone).toBeLessThanOrEqual(disc.x + 1);
    const y = box.y + box.height / 2;
    expect(y, zone).toBeGreaterThan(last);
    expect(y, zone).toBeGreaterThanOrEqual(gaugeBox.y - 1);
    expect(y, zone).toBeLessThanOrEqual(gaugeBox.y + gaugeBox.height + 1);
    last = y;
    await expect(marker).toContainText('◂');
    // The hazard icon sits beside the gauge, off the map.
    if (shown) {
      await expect(hazard).toHaveAttribute('data-hazard', shown);
      const icon = await hazard.boundingBox();
      if (!icon) throw new Error('no hazard icon');
      expect(icon.x + icon.width, zone).toBeLessThanOrEqual(disc.x + 1);
    } else {
      await expect(hazard).toBeHidden();
    }
    // The gauge, the hazard icon and the map with its label.
    await page.screenshot({
      path: `test-results/m6c-minimap-${zone}.png`,
      clip: {
        x: gaugeBox.x - 8,
        y: disc.y - 8,
        width: disc.x + disc.width - gaugeBox.x + 16,
        height: disc.height + 44,
      },
    });
  }
  expect((await state(page)).minimap.marks).toEqual({ players: 0, pings: 0 });
});
