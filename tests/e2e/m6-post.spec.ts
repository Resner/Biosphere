import { expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { PRESETS, type PresetName } from '../../src/render/presets';
import { hatch, openGame } from './helpers';

// The post chain (M6 T2), judged on decoded screenshots and `render.info()`, never on pixel-exact
// baselines. The sim is frozen (`timeScale(0)`) and the preset switched in the same page, so low
// and medium frame the same food in the same place. The DOM HUD is hidden for each shot: it is
// never post-processed, and it would cover the corners.

const bs = (page: Page) => page.evaluate(() => (window.__bs as BsHook).render.info());

// Independent of the code: what the M6 spec lists for each preset.
const PASSES: Record<PresetName, string[]> = {
  low: [],
  medium: ['scene', 'bloom', 'grade', 'vignette'],
  high: ['scene', 'bloom', 'grade', 'vignette', 'grain', 'chromatic'],
};
const BLOOM_LEVELS: Record<PresetName, number> = { low: 0, medium: 4, high: 5 };

async function waitForFrames(page: Page, frames = 3): Promise<void> {
  const before = Number(await page.locator('#scene').getAttribute('data-frames'));
  await page.waitForFunction(
    (target) => Number(document.querySelector('#scene')?.getAttribute('data-frames')) >= target,
    before + frames,
  );
}

async function choose(page: Page, quality: PresetName): Promise<void> {
  await page.keyboard.press('Escape');
  await page.getByTestId('lineage-settings').click();
  await page.getByTestId(`quality-${quality}`).check();
  await page.getByTestId('settings-close').click();
  await page.getByTestId('lineage-close').click();
  await waitForFrames(page);
}

async function play(page: Page, preset: PresetName): Promise<void> {
  await openGame(page, `?debug=1&seed=post&quality=${preset}`);
  await hatch(page);
  await waitForFrames(page);
}

const freeze = (page: Page, scale: number) =>
  page.evaluate((s) => (window.__bs as BsHook).debug?.timeScale(s), scale);

/**
 * Freezes the world and moves the player so that the nearest globule (a bright green sphere) is
 * drawn `dx` CSS pixels right of the screen centre. Returns where it is drawn and its radius.
 */
async function placeGlobule(page: Page, dx: number): Promise<{ x: number; y: number; r: number }> {
  await freeze(page, 0);
  const food = await page.evaluate((offset) => {
    const hook = window.__bs as BsHook;
    const item = hook.debug?.nearestFood('globule');
    if (!item) throw new Error('no globule in the field');
    hook.debug?.teleport(item.x - offset / hook.render.info().pxPerWu, item.y);
    return item;
  }, dx);
  await waitForFrames(page);
  return page.evaluate((item) => {
    const hook = window.__bs as BsHook;
    const { pxPerWu } = hook.render.info();
    const { camX, camY } = hook.render.fx();
    return {
      x: innerWidth / 2 + (item.x - camX) * pxPerWu,
      y: innerHeight / 2 - (item.y - camY) * pxPerWu,
      r: item.radius * pxPerWu,
    };
  }, food);
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

type Probe =
  | { kind: 'patch'; x: number; y: number; half: number }
  | { kind: 'ring'; x: number; y: number; r0: number; r1: number }
  | { kind: 'centroid'; x: number; y: number; half: number }
  | { kind: 'edge'; x: number; y: number; max: number };

/**
 * Luminance (0..255) of square patches and rings; the red and blue centroids (x, in pixels) of what
 * stands above the window's border around a point; and the drawn edge of a round item: the first
 * radius whose 1 px ring falls below halfway between the item's centre and the ring at `max`.
 */
function measure(page: Page, png: Buffer, probes: Probe[]): Promise<number[][]> {
  return page.evaluate(
    async ({ base64, probes }) => {
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
      const at = (x: number, y: number, c: number) => data[(y * width + x) * 4 + c] ?? 0;
      const luma = (x: number, y: number) =>
        0.2126 * at(x, y, 0) + 0.7152 * at(x, y, 1) + 0.0722 * at(x, y, 2);
      const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height;
      return probes.map((p) => {
        const ring = (x0: number, y0: number, r0: number, r1: number) => {
          let sum = 0;
          let n = 0;
          for (let y = Math.floor(y0 - r1); y <= Math.ceil(y0 + r1); y++) {
            for (let x = Math.floor(x0 - r1); x <= Math.ceil(x0 + r1); x++) {
              const d = Math.hypot(x + 0.5 - x0, y + 0.5 - y0);
              if (!inside(x, y) || d < r0 || d > r1) continue;
              sum += luma(x, y);
              n++;
            }
          }
          return sum / n;
        };
        if (p.kind === 'edge') {
          const half = (ring(p.x, p.y, 0, 1.5) + ring(p.x, p.y, p.max, p.max + 1)) / 2;
          let r = 1;
          while (r < p.max && ring(p.x, p.y, r, r + 1) > half) r++;
          return [r];
        }
        if (p.kind === 'ring') return [ring(p.x, p.y, p.r0, p.r1)];
        if (p.kind === 'patch') {
          let sum = 0;
          let n = 0;
          for (let y = Math.floor(p.y - p.half); y < Math.ceil(p.y + p.half); y++) {
            for (let x = Math.floor(p.x - p.half); x < Math.ceil(p.x + p.half); x++) {
              if (!inside(x, y)) continue;
              sum += luma(x, y);
              n++;
            }
          }
          return [sum / n];
        }
        const x0 = Math.round(p.x - p.half);
        const y0 = Math.round(p.y - p.half);
        const size = Math.round(2 * p.half);
        return [0, 2].map((c) => {
          let border = 0;
          let n = 0;
          for (let i = 0; i <= size; i++) {
            for (const [x, y] of [
              [x0 + i, y0],
              [x0 + i, y0 + size],
              [x0, y0 + i],
              [x0 + size, y0 + i],
            ] as const) {
              border += at(x, y, c);
              n++;
            }
          }
          border /= n;
          let weight = 0;
          let moment = 0;
          for (let y = y0; y <= y0 + size; y++) {
            for (let x = x0; x <= x0 + size; x++) {
              // Above the grain, so that noise does not pull both centroids to the middle.
              const w = Math.max(0, at(x, y, c) - border - 8);
              weight += w;
              moment += w * (x + 0.5);
            }
          }
          return moment / weight;
        });
      });
    },
    { base64: png.toString('base64'), probes },
  );
}

test('each preset runs its passes within its budget, and low renders with no target', async ({
  page,
}) => {
  for (const preset of ['low', 'medium', 'high'] as const) {
    await play(page, preset);
    const info = await bs(page);
    expect(info.preset).toBe(preset);
    expect(info.passes).toEqual(PASSES[preset]);
    expect(info.calls).toBeLessThanOrEqual(PRESETS[preset].budget.calls);
    expect(info.triangles).toBeLessThanOrEqual(PRESETS[preset].budget.triangles);
    if (preset === 'low') {
      expect(info.targets).toBe(0);
      expect(info.targetBytes).toBe(0);
    } else {
      // The scene target and one per bloom level.
      expect(info.targets).toBe(1 + BLOOM_LEVELS[preset]);
      expect(info.targetBytes).toBeGreaterThan(0);
    }
  }
});

test('the counters add up every pass, and targets are freed on a preset round trip', async ({
  page,
}) => {
  await play(page, 'medium');
  await freeze(page, 0);
  await waitForFrames(page);
  const medium = await bs(page);
  await choose(page, 'low');
  const low = await bs(page);
  // Bloom draws a prefilter, its downs and ups, then the composite: two per level.
  expect(medium.calls).toBeGreaterThanOrEqual(low.calls + 2 * BLOOM_LEVELS.medium);
  expect(low.memory.textures).toBe(medium.memory.textures - (1 + BLOOM_LEVELS.medium));

  await choose(page, 'medium');
  const back = await bs(page);
  expect(back.memory.textures).toBe(medium.memory.textures);
  expect(back.targetBytes).toBe(medium.targetBytes);
});

test('medium darkens the corners and makes bright food glow', async ({ page }) => {
  await play(page, 'low');
  const item = await placeGlobule(page, 140);
  const { width, height } = page.viewportSize() ?? { width: 960, height: 540 };
  const lowShot = await shot(page);
  // The halo is measured from the sphere's drawn edge, inside its sprite's radius.
  const [[edge = 0] = []] = await measure(page, lowShot, [
    { kind: 'edge', x: item.x, y: item.y, max: item.r * 2 },
  ]);
  const probes: Probe[] = [
    { kind: 'patch', x: width / 2, y: height / 2, half: 30 },
    ...[
      [20, 20],
      [width - 20, 20],
      [20, height - 20],
      [width - 20, height - 20],
    ].map(([x, y]): Probe => ({ kind: 'patch', x: x ?? 0, y: y ?? 0, half: 20 })),
    { kind: 'ring', x: item.x, y: item.y, r0: edge + 3, r1: edge + 6 },
    // Open water farther out: whatever the grade does to the whole frame cancels.
    { kind: 'ring', x: item.x, y: item.y, r0: edge + 30, r1: edge + 40 },
  ];
  const read = async (png: Buffer) => {
    const [centre = [0], ...rest] = await measure(page, png, probes);
    const corners = rest.slice(0, 4).map(([v]) => v ?? 0);
    const [halo = [0], open = [0]] = rest.slice(4);
    return {
      centre: centre[0] ?? 0,
      corners: corners.reduce((a, b) => a + b, 0) / 4,
      glow: (halo[0] ?? 0) - (open[0] ?? 0),
    };
  };
  const low = await read(lowShot);
  await choose(page, 'medium');
  const medium = await read(await shot(page));
  console.log(JSON.stringify({ item, edge, low, medium }));

  expect(edge).toBeGreaterThan(2);
  expect(medium.corners).toBeLessThanOrEqual(0.9 * medium.centre);
  // The vignette, not just the scene: medium's corners sit lower against the centre than low's.
  expect(medium.corners / medium.centre).toBeLessThan(low.corners / low.centre);
  expect(medium.glow - low.glow).toBeGreaterThanOrEqual(8);
});

test('high splits red and blue towards the frame edge', async ({ page }) => {
  await play(page, 'low');
  const { width } = page.viewportSize() ?? { width: 960, height: 540 };
  const item = await placeGlobule(page, Math.round(width * 0.42));
  const probe: Probe[] = [{ kind: 'centroid', x: item.x, y: item.y, half: item.r + 6 }];
  const split = async () => {
    const [[red = 0, blue = 0] = []] = await measure(page, await shot(page), probe);
    return blue - red;
  };
  const low = await split();
  await choose(page, 'high');
  const high = await split();
  console.log(JSON.stringify({ item, low, high }));
  // Red is sampled further out, so it is drawn nearer the centre than blue; low shows the item's
  // own colour layout.
  expect(high).toBeGreaterThanOrEqual(1);
  expect(high - low).toBeGreaterThanOrEqual(1);
});

test('without a float colour buffer the chain falls back to 8-bit targets', async ({ page }) => {
  await play(page, 'medium');
  const float = await bs(page);
  await page.addInitScript(() => {
    const proto = WebGL2RenderingContext.prototype as unknown as {
      getExtension(this: WebGL2RenderingContext, name: string): unknown;
    };
    const get = proto.getExtension;
    proto.getExtension = function (name) {
      if (name === 'EXT_color_buffer_float' || name === 'EXT_color_buffer_half_float') return null;
      return get.call(this, name);
    };
  });
  await play(page, 'medium');
  const bytes = await bs(page);
  expect(bytes.passes).toEqual(PASSES.medium);
  expect(bytes.targets).toBe(float.targets);
  expect(bytes.targetBytes).toBe(float.targetBytes / 2);
  const [[centre = 0] = []] = await measure(page, await shot(page), [
    { kind: 'patch', x: 480, y: 270, half: 30 },
  ]);
  expect(centre).toBeGreaterThan(10);
});
