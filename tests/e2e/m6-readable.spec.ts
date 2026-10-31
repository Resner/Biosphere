import { expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { hatch, openGame, openMenu } from './helpers';

// Readability (M6 T21): the canvas and the HUD are crisp, and creatures a tier bigger or smaller
// than the player carry an outline that differs in shape and pulse, not only in colour.

async function waitForFrames(page: Page, frames = 3): Promise<void> {
  const before = Number(await page.locator('#scene').getAttribute('data-frames'));
  await page.waitForFunction(
    (target) => Number(document.querySelector('#scene')?.getAttribute('data-frames')) >= target,
    before + frames,
  );
}

const freeze = (page: Page, scale: number) =>
  page.evaluate((s) => (window.__bs as BsHook).debug?.timeScale(s), scale);

/** A still water for a ring measurement: no marine snow or shader clock drifting across the ring. */
const stillWater = (page: Page) => page.evaluate(() => (window.__bs as BsHook).debug?.resetWater());

/** Places scripted remotes `dx` CSS pixels right of the player (still), and waits until all are in. */
async function placeRemotes(
  page: Page,
  remotes: { id: string; name: string; biomass: number; dx: number; dy?: number }[],
): Promise<void> {
  await page.evaluate((list) => {
    const hook = window.__bs as BsHook;
    const player = hook.state().player;
    if (!player) throw new Error('not playing');
    const { pxPerWu } = hook.render.info();
    hook.debug?.setRemotes(
      list.map((r) => ({
        id: r.id,
        name: r.name,
        biomass: r.biomass,
        x: player.x + r.dx / pxPerWu,
        y: player.y + (r.dy ?? 0) / pxPerWu,
      })),
    );
  }, remotes);
  await page.waitForFunction((n) => {
    const s = (window.__bs as BsHook).state();
    return s.remotes.length === n && s.remotes.every((r) => r.alpha === 1);
  }, remotes.length);
  await waitForFrames(page);
}

test.describe('crispness', () => {
  // The suite default is the low preset (playwright.config.ts); this checks high on a 2x screen,
  // in a smaller window, because software GL pays for every device pixel of the high preset.
  test.use({
    storageState: { cookies: [], origins: [] },
    deviceScaleFactor: 2,
    viewport: { width: 640, height: 400 },
  });

  test('the canvas draws at device pixels and HUD text sits on whole pixels', async ({ page }) => {
    test.setTimeout(45_000);
    await openGame(page, '?debug=1&seed=crisp&quality=high');
    await hatch(page);
    // Names of many widths, so centred labels land on odd widths too.
    await placeRemotes(page, [
      { id: 'peer-a', name: 'Ab', biomass: 100, dx: -200, dy: 100 },
      { id: 'peer-b', name: 'Xylophone', biomass: 100, dx: 0, dy: 130 },
      { id: 'peer-c', name: 'Wide name here', biomass: 100, dx: 200, dy: 100 },
    ]);

    const canvas = await page.evaluate(() => {
      const el = document.querySelector('#scene') as HTMLCanvasElement;
      const rect = el.getBoundingClientRect();
      return {
        width: el.width,
        height: el.height,
        cssWidth: rect.width,
        cssHeight: rect.height,
        transform: getComputedStyle(el).transform,
        pixelRatio: (window.__bs as BsHook).render.info().pixelRatio,
        dpr: devicePixelRatio,
      };
    });
    expect(canvas.dpr).toBe(2);
    expect(canvas.pixelRatio).toBe(2);
    expect(canvas.width).toBe(canvas.cssWidth * canvas.pixelRatio);
    expect(canvas.height).toBe(canvas.cssHeight * canvas.pixelRatio);
    expect(canvas.transform).toBe('none');

    // Every visible element holding text: no transform on it or above it moves it off whole pixels
    // or scales it.
    const offenders = await page.evaluate(() => {
      const bad: string[] = [];
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
        const own = Array.from(el.childNodes).some(
          (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '',
        );
        if (!own || el.getClientRects().length === 0) continue;
        for (let at: Element | null = el; at && at !== document.body; at = at.parentElement) {
          const t = getComputedStyle(at).transform;
          if (t === 'none') continue;
          const m = new DOMMatrixReadOnly(t);
          const whole = Number.isInteger(m.e) && Number.isInteger(m.f);
          const plain = m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.is2D;
          if (!whole || !plain) bad.push(`${el.className || el.tagName}: ${t}`);
        }
      }
      return bad;
    });
    expect(offenders).toEqual([]);

    // Icons are vector: no raster image or CSS image anywhere in the page.
    const raster = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('body *'))
        .filter(
          (el) =>
            el instanceof HTMLImageElement || getComputedStyle(el).backgroundImage.includes('url('),
        )
        .map((el) => el.className || el.tagName),
    );
    expect(raster).toEqual([]);

    // HUD text edges are sharp: the 10-90% rise of full-contrast edges is at most 2 device pixels.
    await openMenu(page);
    const png = await page.getByTestId('hud-species').screenshot();
    const rises = await page.evaluate(async (base64) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const c = document.createElement('canvas');
      c.width = image.width;
      c.height = image.height;
      const ctx = c.getContext('2d') as CanvasRenderingContext2D;
      ctx.drawImage(image, 0, 0);
      const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
      const luma = (x: number, y: number) => {
        const i = (y * width + x) * 4;
        return 0.2126 * (data[i] ?? 0) + 0.7152 * (data[i + 1] ?? 0) + 0.0722 * (data[i + 2] ?? 0);
      };
      let lo = 255;
      let hi = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          lo = Math.min(lo, luma(x, y));
          hi = Math.max(hi, luma(x, y));
        }
      }
      const out: number[] = [];
      // Monotonic runs along each row, both ways, that span most of the text's contrast.
      for (let y = 0; y < height; y++) {
        const row = Array.from({ length: width }, (_, x) => luma(x, y));
        for (const line of [row, [...row].reverse()]) {
          let start = 0;
          for (let x = 1; x <= line.length; x++) {
            if (x < line.length && (line[x] as number) > (line[x - 1] as number)) continue;
            const a = line[start] as number;
            const b = line[x - 1] as number;
            if (b - a >= 0.6 * (hi - lo)) {
              const at = (level: number) => {
                for (let k = start + 1; k < x; k++) {
                  const v = line[k] as number;
                  if (v >= level) {
                    const p = line[k - 1] as number;
                    return k - 1 + (level - p) / (v - p);
                  }
                }
                return x - 1;
              };
              out.push(at(a + 0.9 * (b - a)) - at(a + 0.1 * (b - a)));
            }
            start = x;
          }
        }
      }
      return out;
    }, png.toString('base64'));
    expect(rises.length).toBeGreaterThan(20);
    const sorted = [...rises].sort((a, b) => a - b);
    expect(sorted[Math.floor(sorted.length / 2)]).toBeLessThanOrEqual(2);
  });
});

/** Luminance (0..255) sampled every degree along a circle in a PNG of the page at 1x. */
async function ringProfile(
  page: Page,
  png: Buffer,
  ring: { x: number; y: number; radius: number },
): Promise<number[]> {
  return page.evaluate(
    async ({ base64, ring }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const c = document.createElement('canvas');
      c.width = image.width;
      c.height = image.height;
      const ctx = c.getContext('2d') as CanvasRenderingContext2D;
      ctx.drawImage(image, 0, 0);
      const { data, width } = ctx.getImageData(0, 0, c.width, c.height);
      const out: number[] = [];
      for (let deg = 0; deg < 360; deg++) {
        const t = (deg * Math.PI) / 180;
        // The brightest pixel across the line's width, so a 2 px line is never missed.
        let best = 0;
        for (const dr of [-1.5, -0.75, 0, 0.75, 1.5]) {
          const x = Math.round(ring.x + (ring.radius + dr) * Math.cos(t));
          const y = Math.round(ring.y - (ring.radius + dr) * Math.sin(t));
          const i = (y * width + x) * 4;
          const l =
            0.2126 * (data[i] ?? 0) + 0.7152 * (data[i + 1] ?? 0) + 0.0722 * (data[i + 2] ?? 0);
          best = Math.max(best, l);
        }
        out.push(best);
      }
      return out;
    },
    { base64: png.toString('base64'), ring },
  );
}

/**
 * The bright runs along a circular profile: how many, and their mean length in samples. `max` and
 * `min` are the 95th and 5th percentiles, so a food pellet or a tail crossing the ring does not
 * stretch the range.
 */
function runs(profile: number[]): { count: number; mean: number; max: number; min: number } {
  const sorted = [...profile].sort((a, b) => a - b);
  const max = sorted[Math.floor(0.95 * (sorted.length - 1))] as number;
  const min = sorted[Math.floor(0.05 * (sorted.length - 1))] as number;
  const mid = (max + min) / 2;
  const lit = profile.map((v) => v > mid);
  // Start counting at an unlit sample so a run across 0 degrees counts once.
  const first = lit.indexOf(false);
  let count = 0;
  let total = 0;
  let inRun = false;
  for (let k = 0; k < lit.length; k++) {
    const on = lit[(first + k) % lit.length] as boolean;
    if (on) total++;
    if (on && !inRun) count++;
    inRun = on;
  }
  return { count, mean: count ? total / count : 0, max, min };
}

async function shoot(page: Page): Promise<Buffer> {
  // Only the canvas: names and the HUD would cross the outlines.
  await page.addStyleTag({ content: 'body > :not(#scene) { visibility: hidden !important; }' });
  return page.screenshot();
}

test('a bigger creature gets a pulsing broken ring, a smaller one a faint dot ring, a comparable one none', async ({
  page,
}) => {
  test.setTimeout(45_000);
  await openGame(page, '?debug=1&seed=outline');
  await hatch(page);
  // The starter hatchling is tier 0 (radius under 32): 1,100 biomass is tier 1, 200 is tier 0.
  await placeRemotes(page, [
    { id: 'peer-big', name: 'Big', biomass: 1100, dx: 250 },
    { id: 'peer-same', name: 'Same', biomass: 200, dx: -250 },
  ]);

  const outlines = () => page.evaluate(() => (window.__bs as BsHook).render.outlines());
  const first = await outlines();
  expect(first.map((o) => [o.id, o.kind])).toEqual([['peer-big', 'bigger']]);
  expect((await page.evaluate(() => (window.__bs as BsHook).render.info())).outlines).toEqual({
    bigger: 1,
    smaller: 0,
  });
  // The ring pulses over time (the sim runs), so it is not told apart by colour alone.
  const pulses = new Set<number>();
  for (let i = 0; i < 6; i++) {
    pulses.add(Math.round(((await outlines())[0]?.pulse ?? 0) * 100));
    await page.waitForTimeout(120);
  }
  expect(pulses.size).toBeGreaterThanOrEqual(3);

  await freeze(page, 0);
  await stillWater(page);
  await waitForFrames(page);
  const [big] = await outlines();
  if (!big) throw new Error('no outline');
  const shot = await shoot(page);
  const bigRuns = runs(await ringProfile(page, shot, big));
  // A broken ring: separate dashes, clearly brighter than the water between them.
  expect(bigRuns.count).toBeGreaterThanOrEqual(6);
  expect(bigRuns.max - bigRuns.min).toBeGreaterThanOrEqual(40);

  // Grow the player to tier 1: the 200 one becomes smaller, the 1,100 one comparable.
  await page.reload();
  await page.waitForFunction(() => window.__bs?.ready === true);
  await hatch(page);
  await page.evaluate(() => (window.__bs as BsHook).debug?.setBiomass(1100));
  // Wait for the zoom to settle on the new size.
  let last = 0;
  await expect
    .poll(async () => {
      const h = await page.evaluate(() => (window.__bs as BsHook).render.fx().halfHeight);
      const still = Math.abs(h - last) < 0.01 * h;
      last = h;
      return still;
    })
    .toBe(true);
  await placeRemotes(page, [
    { id: 'peer-small', name: 'Small', biomass: 200, dx: 250 },
    { id: 'peer-same', name: 'Same', biomass: 1100, dx: -250 },
  ]);
  const second = await outlines();
  expect(second.map((o) => [o.id, o.kind])).toEqual([['peer-small', 'smaller']]);
  // The dot ring holds still: no pulse.
  expect(second[0]?.pulse).toBe(0);

  await freeze(page, 0);
  await stillWater(page);
  await waitForFrames(page);
  const [small] = await outlines();
  if (!small) throw new Error('no outline');
  const smallRuns = runs(await ringProfile(page, await shoot(page), small));
  // Dots: more and shorter marks than the dashes, and fainter.
  expect(smallRuns.count).toBeGreaterThanOrEqual(10);
  const degreesPerDash = bigRuns.mean;
  const pxPerDash = (degreesPerDash * Math.PI * big.radius) / 180;
  const pxPerDot = (smallRuns.mean * Math.PI * small.radius) / 180;
  expect(pxPerDot * 2).toBeLessThan(pxPerDash);
  expect(smallRuns.max - smallRuns.min).toBeGreaterThanOrEqual(12);
  expect(smallRuns.max - smallRuns.min).toBeLessThan(bigRuns.max - bigRuns.min);
});
