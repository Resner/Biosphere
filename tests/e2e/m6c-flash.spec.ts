import { expect, test } from '@playwright/test';
import type { BsDebug, BsHook } from '../../src/game/debug';
import { CROWD } from '../../tools/budget-scene.mjs';
import { CROWD_VIEWPORT, openCrowdGame, stageCrowd } from './crowd';

// No flash at a level-of-detail swap (M6c T8): the owner saw bodies "bug out / flash for a second"
// in Firefox. 24 bodies sit round the player on the medium preset while the camera zooms out across
// the low-detail threshold (12 px of core radius) and back in across the high one (16 px). Every
// frame of the sweep is read back in the page, right after the game drew it, and no body may lose
// more than 20% of its pixels against the mean of the frames before and after it. It runs in
// Chromium and, in `E2E full`, in Firefox.

test.use({
  storageState: { cookies: [], origins: [] },
  viewport: CROWD_VIEWPORT,
  deviceScaleFactor: 1,
});

/** Frames read: half zooming out, half zooming back in. */
const FRAMES = 240;
/** The bodies' core radii on screen at the start, CSS pixels: every one crosses both thresholds. */
const START_PX = [19, 21, 23, 25];
/**
 * The player's biomass grows this many times over the zoom out (the view widens about 2.2×), from
 * `PLAYER_BIOMASS`, and stays in size tier 1: a tier change would put size outlines round the bodies.
 */
const GROWTH = 14;
/** A frame may lose at most this share of a body's pixels against its neighbours. */
const MAX_LOSS = 0.2;
/** Fewer body pixels than this are too few to judge. */
const MIN_PIXELS = 30;

interface Sweep {
  /** Per frame, each body's bright pixels (null where it is not judged) and core radius on screen. */
  pixels: Record<string, number | null>[];
  radii: Record<string, number>[];
}

test('no body loses a fifth of its pixels in any frame while the zoom crosses the LOD thresholds @slow', async ({
  page,
}) => {
  // Software GL draws a medium frame of 25 bodies in about a second; 240 frames are read.
  test.setTimeout(600_000);
  await openCrowdGame(page, 'medium');
  await stageCrowd(page, START_PX);

  const sweep: Sweep = await page.evaluate(
    ({ frames, growth }) => {
      /** A body pixel stands this far above the dark water (luminance, 0-255). */
      const BRIGHT = 60;
      /** Bodies are judged within this many core radii of their centre (their parts reach past it). */
      const REACH = 2.2;
      /**
       * Smaller bodies are not judged: a few pixels across, a slim one's rim lands on more or fewer
       * pixel centres as the zoom moves it, whatever the level of detail.
       */
      const minRadius = 9;
      const { state, render } = window.__bs as BsHook;
      const debug = (window.__bs as BsHook).debug as BsDebug;
      const canvas = document.querySelector('#scene') as HTMLCanvasElement;
      const copy = document.createElement('canvas');
      const g = copy.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
      const start = state();
      const at = start.player as { x: number; y: number; biomass: number };
      const step = growth ** (2 / frames);
      const out: Sweep = { pixels: [], radii: [] };
      type Circle = { id: string; x: number; y: number; r: number };

      /** Reads the frame the game just drew: the canvas is still whole until the browser presents it. */
      const read = (): void => {
        const [w, h] = [canvas.clientWidth, canvas.clientHeight];
        copy.width = w;
        copy.height = h;
        g.drawImage(canvas, 0, 0, w, h);
        const rgba = g.getImageData(0, 0, w, h).data;
        const fx = render.fx();
        const { pxPerWu } = render.info();
        const now = state();
        const place = (id: string, x: number, y: number, r: number): Circle => ({
          id,
          x: w / 2 + (x - fx.camX) * pxPerWu,
          y: h / 2 - (y - fx.camY) * pxPerWu,
          r: r * pxPerWu,
        });
        const me = now.player as { x: number; y: number; radius: number };
        const remotes = now.remotes.map((r) => place(r.id, r.x, r.y, r.radius));
        const all = [place('player', me.x, me.y, me.radius), ...remotes];
        const pixels: Record<string, number | null> = {};
        const radii: Record<string, number> = {};
        for (const c of remotes) {
          radii[c.id] = c.r;
          const reach = c.r * REACH;
          const judged =
            c.r >= minRadius &&
            c.x - reach >= 0 &&
            c.y - reach >= 0 &&
            c.x + reach <= w &&
            c.y + reach <= h &&
            all.every(
              (o) => o.id === c.id || Math.hypot(o.x - c.x, o.y - c.y) > reach + o.r * REACH,
            );
          if (!judged) {
            pixels[c.id] = null;
            continue;
          }
          let n = 0;
          for (let y = Math.floor(c.y - reach); y < c.y + reach; y++) {
            for (let x = Math.floor(c.x - reach); x < c.x + reach; x++) {
              if (Math.hypot(x + 0.5 - c.x, y + 0.5 - c.y) > reach) continue;
              const i = (y * w + x) * 4;
              const l =
                0.2126 * (rgba[i] as number) +
                0.7152 * (rgba[i + 1] as number) +
                0.0722 * (rgba[i + 2] as number);
              if (l >= BRIGHT) n++;
            }
          }
          pixels[c.id] = n;
        }
        out.pixels.push(pixels);
        out.radii.push(radii);
      };

      /**
       * Each frame: the game draws (its animation loop runs first in a frame, since it asked for the
       * frame before this loop did), this callback reads what it drew and sets the next zoom. The
       * camera snaps to the new size (`freezeAt`), so a frame's zoom does not depend on how long a
       * slow runner took to draw the one before.
       */
      return new Promise<Sweep>((resolve) => {
        let f = -1;
        const zoom = (k: number): void => {
          const outward = k < frames / 2 ? k : frames - 1 - k;
          debug.setBiomass(at.biomass * step ** outward);
          debug.freezeAt(start.tick, at.x, at.y);
        };
        const frame = (): void => {
          if (f >= 0) read();
          f++;
          if (f >= frames) {
            resolve(out);
            return;
          }
          zoom(f);
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      });
    },
    { frames: FRAMES, growth: GROWTH },
  );

  // The sweep crossed both thresholds for every body: below 12 px going out, above 16 coming back.
  const ids = Object.keys(sweep.radii[0] as Record<string, number>);
  expect(ids.length).toBe(CROWD);
  for (const id of ids) {
    const r = sweep.radii.map((m) => m[id] as number);
    expect(Math.min(...r), id).toBeLessThan(12);
    expect(r[0], id).toBeGreaterThan(16);
    expect(r[FRAMES - 1], id).toBeGreaterThan(16);
  }

  const losses: { id: string; frame: number; loss: number }[] = [];
  let checks = 0;
  for (let f = 1; f + 1 < FRAMES; f++) {
    for (const id of ids) {
      const [before, now, after] = [f - 1, f, f + 1].map((k) => sweep.pixels[k]?.[id] ?? null);
      if (before == null || now == null || after == null) continue;
      if (Math.min(before, after) < MIN_PIXELS) continue;
      checks++;
      const loss = 1 - now / ((before + after) / 2);
      if (loss > MAX_LOSS) losses.push({ id, frame: f, loss: Number(loss.toFixed(3)) });
    }
  }
  console.log(`${checks} body-frames judged over ${FRAMES} frames`);
  // Most bodies are judged on most frames, so a check over few would pass on nothing.
  expect(checks).toBeGreaterThan(FRAMES * 6);
  expect(losses).toEqual([]);
});
