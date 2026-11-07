import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, type Page, type TestInfo, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { PRESETS } from '../../src/render/presets';
import { wellInside, ZONES } from '../../src/render/zones';
import { type Zone, zoneAt } from '../../src/sim/bathymetry';
import { createWorld } from '../../src/sim/world';
import { hatch, openGame, state } from './helpers';

// The world at full size (M11 T11): the offline world of 262,144 wu (`?world=`), drawn from a
// floating origin with depth windows, at its centre and out at (250,000, 250,000). No hub. The
// water must keep its zone's colour (against the same zones in a pond of 8,192 wu), a still
// creature must hold still on screen, the medium preset must keep its budgets, and nothing sent to
// the GPU (`?gpu=watch`) may lie further than 16,384 wu from zero.

const SIZE = 262_144;
const FAR = { x: 250_000, y: 250_000 } as const;
const CENTRE = { x: SIZE / 2, y: SIZE / 2 } as const;
/** The look is judged on the medium preset, which also has budgets to keep. */
const QUALITY = 'medium';

/** The first seed whose far point lies well inside a zone, so its water is that zone's alone. */
const FAR_WORLD = (() => {
  for (let i = 0; i < 64; i++) {
    const seed = `m11-world-${i}`;
    const seed32 = createWorld({ seed, size: SIZE }).seed32;
    const zone = zoneAt(seed32, FAR.x, FAR.y, SIZE);
    if (wellInside(seed32, SIZE, FAR.x, FAR.y, zone)) return { seed, zone };
  }
  throw new Error('no seed puts the far point well inside a zone');
})();

test.use({ storageState: { cookies: [], origins: [] } });

async function waitForFrames(page: Page, frames = 3): Promise<void> {
  const before = Number(await page.locator('#scene').getAttribute('data-frames'));
  await page.waitForFunction(
    (target) => Number(document.querySelector('#scene')?.getAttribute('data-frames')) >= target,
    before + frames,
    { timeout: 60_000 },
  );
}

/** Freezes the world with the player still at (x, y) and the shaders' clock at 100 s. */
async function stillAt(page: Page, x: number, y: number): Promise<void> {
  await page.evaluate(
    ({ x, y }) => {
      const debug = (window.__bs as BsHook).debug;
      debug?.freezeAt(0, x, y);
      debug?.resetWater();
      debug?.setClock(100);
    },
    { x, y },
  );
  await waitForFrames(page);
}

/** A screenshot of the canvas alone. */
async function shot(page: Page): Promise<Buffer> {
  const style = await page.addStyleTag({
    content: 'body > :not(#scene) { visibility: hidden !important; }',
  });
  await waitForFrames(page, 2);
  const png = await page.locator('#scene').screenshot();
  await style.evaluate((node) => (node as HTMLStyleElement).remove());
  return png;
}

/**
 * The water's luminance (0..255) around the player in a PNG: the mean of the darkest 80% of the
 * pixels from 3 body radii out (not the body, food or specks), as `m6-zones` measures it.
 */
function water(page: Page, png: Buffer): Promise<number> {
  return page.evaluate(
    async ({ base64 }) => {
      const hook = window.__bs as BsHook;
      const player = hook.state().player;
      if (!player) throw new Error('no player');
      const { pxPerWu, centre } = hook.render.info();
      if (!centre) throw new Error('no drawn centre');
      const r0 = player.radius * pxPerWu * 3;
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('2D canvas unavailable');
      context.drawImage(image, 0, 0);
      const { data, width, height } = context.getImageData(0, 0, image.width, image.height);
      const values: number[] = [];
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (Math.hypot(x - centre.x, y - centre.y) < r0) continue;
          const i = (y * width + x) * 4;
          values.push(
            0.2126 * (data[i] ?? 0) + 0.7152 * (data[i + 1] ?? 0) + 0.0722 * (data[i + 2] ?? 0),
          );
        }
      }
      values.sort((a, b) => a - b);
      const kept = values.slice(0, Math.max(1, Math.floor(values.length * 0.8)));
      return kept.reduce((a, b) => a + b, 0) / kept.length;
    },
    { base64: png.toString('base64') },
  );
}

/** The zone whose reference water is nearest a measured luminance. */
function nearestZone(measured: number, reference: Record<Zone, number>): Zone {
  let best: Zone = 'twilight';
  for (const zone of ZONES) {
    if (Math.abs(reference[zone] - measured) < Math.abs(reference[best] - measured)) best = zone;
  }
  return best;
}

/** The player's drawn centre (`render.info().centre`) on each of the next `frames` frames. */
function centres(page: Page, frames: number): Promise<{ x: number; y: number }[]> {
  return page.evaluate(
    (frames) =>
      new Promise<{ x: number; y: number }[]>((resolve) => {
        const out: { x: number; y: number }[] = [];
        const step = () => {
          const centre = (window.__bs as BsHook).render.info().centre;
          if (centre) out.push(centre);
          if (out.length >= frames) resolve(out);
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
    frames,
  );
}

/** Attaches a shot to the report and keeps it as `test-results/<name>.png`. */
async function attach(testInfo: TestInfo, name: string, png: Buffer): Promise<void> {
  mkdirSync('test-results', { recursive: true });
  writeFileSync(`test-results/${name}.png`, png);
  await testInfo.attach(name, { body: png, contentType: 'image/png' });
}

/** Opens the 262,144 wu offline world on the medium preset with the GPU watched, and hatches at its centre. */
async function openWorld(page: Page): Promise<void> {
  await openGame(
    page,
    `?debug=1&world=${SIZE}&seed=${FAR_WORLD.seed}&quality=${QUALITY}&gpu=watch`,
  );
  await hatch(page);
  const start = await state(page);
  expect(start.player?.x).toBeCloseTo(CENTRE.x, -3);
  expect(start.player?.y).toBeCloseTo(CENTRE.y, -3);
}

test("the water keeps its zone's colour at the centre and the far corner of a 262,144 wu world @slow", async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(240_000);
  // The same zones in a pond of 8,192 wu: what each zone's water looks like.
  const pond = await browser.newPage({ viewport: page.viewportSize() });
  await openGame(pond, `?debug=1&seed=zones&quality=${QUALITY}`);
  await hatch(pond);
  const reference = {} as Record<Zone, number>;
  for (const zone of ZONES) {
    const at = await pond.evaluate((z) => (window.__bs as BsHook).debug?.setZone(z), zone);
    if (!at) throw new Error('no debug hook');
    await stillAt(pond, at.x, at.y);
    reference[zone] = await water(pond, await shot(pond));
  }
  await pond.close();
  for (let i = 1; i < ZONES.length; i++) {
    expect(
      reference[ZONES[i] as Zone],
      `the pond's zones darken: ${JSON.stringify(reference)}`,
    ).toBeLessThan(reference[ZONES[i - 1] as Zone]);
  }

  await openWorld(page);
  for (const [name, at] of [
    ['centre', CENTRE],
    ['far', FAR],
  ] as const) {
    await stillAt(page, at.x, at.y);
    const s = await state(page);
    expect(s.player?.x, name).toBeCloseTo(at.x, 0);
    expect(s.zone, name).toBe(name === 'far' ? FAR_WORLD.zone : 'twilight');
    const png = await shot(page);
    await attach(testInfo, `m11-world-${name}`, png);
    const measured = await water(page, png);
    expect(
      nearestZone(measured, reference),
      `${name}: water ${measured.toFixed(1)} against ${JSON.stringify(reference)}`,
    ).toBe(s.zone);
  }
});

test('a still creature holds still at the far corner, within the medium budgets, and the GPU sees only small numbers', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openWorld(page);
  const budget = PRESETS[QUALITY].budget;
  for (const [name, at] of [
    ['centre', CENTRE],
    ['far', FAR],
  ] as const) {
    await stillAt(page, at.x, at.y);
    // A still creature stays still on screen.
    const drawn = await centres(page, 30);
    const xs = drawn.map((c) => c.x);
    const ys = drawn.map((c) => c.y);
    expect(Math.max(...xs) - Math.min(...xs), `${name}: x`).toBeLessThanOrEqual(0.05);
    expect(Math.max(...ys) - Math.min(...ys), `${name}: y`).toBeLessThanOrEqual(0.05);

    const info = await page.evaluate(() => (window.__bs as BsHook).render.info());
    expect(info.preset).toBe(QUALITY);
    expect(info.calls, name).toBeLessThanOrEqual(budget.calls);
    expect(info.triangles, name).toBeLessThanOrEqual(budget.triangles);
    expect(info.targetBytes, name).toBeLessThanOrEqual(budget.targetBytes);
  }

  // The world's corners and edges too: nothing sent to the GPU strays far from zero.
  for (const [x, y] of [
    [600, 600],
    [SIZE - 600, SIZE - 600],
    [600, SIZE - 600],
    [CENTRE.x, 600],
    [SIZE - 600, CENTRE.y],
  ] as const) {
    await stillAt(page, x, y);
    const info = await page.evaluate(() => (window.__bs as BsHook).render.info());
    expect(Math.abs(x - info.origin.x)).toBeLessThanOrEqual(4096);
    expect(Math.abs(y - info.origin.y)).toBeLessThanOrEqual(4096);
  }
  const gpu = await page.evaluate(() => (window.__bs as BsHook).render.gpu());
  if (!gpu) throw new Error('the GPU is not watched');
  console.log(`m11-world: largest float sent ${gpu.max} by ${gpu.name}, ${gpu.uploads} uploads`);
  expect(gpu.uploads).toBeGreaterThan(1000);
  expect(gpu.max, `the largest float sent, by ${gpu.name}`).toBeLessThanOrEqual(16_384);
});
