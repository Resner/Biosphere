import { expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { hatch, openGame, playerOf } from './helpers';

// The macro look is judged by properties of decoded screenshots and renderer budgets, never by
// pixel-exact baselines: software rendering differs between browser versions.

async function play(page: Page): Promise<void> {
  await openGame(page, '?debug=1&seed=look');
  await hatch(page);
}

async function waitForFrames(page: Page, frames = 4): Promise<void> {
  const before = Number(await page.locator('#scene').getAttribute('data-frames'));
  await page.waitForFunction(
    (target) => Number(document.querySelector('#scene')?.getAttribute('data-frames')) >= target,
    before + frames,
  );
}

/** Decodes a canvas screenshot inside the page and measures it. */
async function measure(
  page: Page,
  query: { radiusPx: number; patch?: { cx: number; cy: number; half: number } },
): Promise<{
  luma: Record<string, number>;
  patch: [number, number, number] | null;
}> {
  const png = await page.locator('#scene').screenshot();
  return page.evaluate(
    async ({ base64, radiusPx, patch }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const scratch = document.createElement('canvas');
      scratch.width = image.width;
      scratch.height = image.height;
      const context = scratch.getContext('2d');
      if (!context) throw new Error('2D canvas unavailable');
      context.drawImage(image, 0, 0);
      const { width, height } = image;
      const { data } = context.getImageData(0, 0, width, height);
      const luma = (i: number) =>
        0.2126 * (data[i] ?? 0) + 0.7152 * (data[i + 1] ?? 0) + 0.0722 * (data[i + 2] ?? 0);

      const cx = width / 2;
      const cy = height / 2;
      let ringSum = 0;
      let ringCount = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / radiusPx;
          if (d >= 0.9 && d <= 1.1) {
            ringSum += luma((y * width + x) * 4);
            ringCount++;
          }
        }
      }
      const cornerSize = 40;
      let cornerSum = 0;
      let cornerCount = 0;
      for (const ox of [0, width - cornerSize]) {
        for (const oy of [0, height - cornerSize]) {
          for (let y = oy; y < oy + cornerSize; y++) {
            for (let x = ox; x < ox + cornerSize; x++) {
              cornerSum += luma((y * width + x) * 4);
              cornerCount++;
            }
          }
        }
      }

      let rgb: [number, number, number] | null = null;
      if (patch) {
        const sum = [0, 0, 0];
        let n = 0;
        const x0 = Math.max(0, Math.round(patch.cx - patch.half));
        const x1 = Math.min(width, Math.round(patch.cx + patch.half));
        const y0 = Math.max(0, Math.round(patch.cy - patch.half));
        const y1 = Math.min(height, Math.round(patch.cy + patch.half));
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const i = (y * width + x) * 4;
            sum[0] = (sum[0] ?? 0) + (data[i] ?? 0);
            sum[1] = (sum[1] ?? 0) + (data[i + 1] ?? 0);
            sum[2] = (sum[2] ?? 0) + (data[i + 2] ?? 0);
            n++;
          }
        }
        rgb = [(sum[0] ?? 0) / n, (sum[1] ?? 0) / n, (sum[2] ?? 0) / n];
      }
      return {
        luma: { ring: ringSum / ringCount, corners: cornerSum / cornerCount },
        patch: rgb,
      };
    },
    { base64: png.toString('base64'), radiusPx: query.radiusPx, patch: query.patch ?? null },
  );
}

test.describe('macro look', () => {
  test('plays for 3 s without console errors or WebGL warnings', async ({ page }) => {
    const problems: string[] = [];
    page.on('console', (message) => {
      if (message.type() !== 'error' && message.type() !== 'warning') return;
      // Software GL (SwiftShader) reports its own readback cost for every presented frame; it is a
      // driver performance hint, not a WebGL warning raised by the page.
      if (/GL Driver Message \(OpenGL, Performance/.test(message.text())) return;
      problems.push(`${message.type()}: ${message.text()}`);
    });
    page.on('pageerror', (error) => problems.push(error.message));

    await play(page);
    await page.mouse.move(700, 200);
    await page.waitForTimeout(3000);
    expect(problems).toEqual([]);
    expect(await page.evaluate(() => (window.__bs as BsHook).state().screen)).toBe('playing');
  });

  test('the membrane rim glows against the water', async ({ page }) => {
    await play(page);
    await waitForFrames(page);
    const player = await playerOf(page);
    const { pxPerWu } = await page.evaluate(() => (window.__bs as BsHook).render.info());

    const { luma } = await measure(page, { radiusPx: player.radius * pxPerWu });
    expect(luma.ring).toBeGreaterThan(2 * (luma.corners ?? 0));
    expect(luma.corners).toBeGreaterThan(0);
  });

  test('stays inside the draw budget and draws every visible food item', async ({ page }) => {
    await play(page);
    await waitForFrames(page);
    // One evaluate, so both numbers describe the same tick.
    const { info, visibleFood } = await page.evaluate(() => {
      const bs = window.__bs as BsHook;
      return { info: bs.render.info(), visibleFood: bs.state().visibleFood };
    });
    expect(info.calls).toBeGreaterThan(0);
    expect(info.calls).toBeLessThanOrEqual(40);
    expect(info.triangles).toBeLessThanOrEqual(60_000);
    expect(info.foodInstances).toBe(visibleFood);
  });

  test('a toxic plume tints the water it covers', async ({ page }) => {
    await play(page);
    await waitForFrames(page);
    const player = await playerOf(page);
    const { pxPerWu } = await page.evaluate(() => (window.__bs as BsHook).render.info());
    const size = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
    const patch = { cx: size.w / 2 + 40 * pxPerWu, cy: size.h / 2, half: 12 };
    const query = { radiusPx: player.radius * pxPerWu, patch };

    const before = (await measure(page, query)).patch;
    await page.evaluate(({ x, y }) => window.__bs?.debug?.spawnPlume(x + 40, y), {
      x: player.x,
      y: player.y,
    });
    await waitForFrames(page);
    const after = (await measure(page, query)).patch;

    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    const shift = Math.hypot(
      ...(before ?? [0, 0, 0]).map((v, i) => v - ((after ?? [0, 0, 0])[i] ?? 0)),
    );
    expect(shift).toBeGreaterThan(12);
  });
});
