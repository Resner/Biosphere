import type { Locator, Page } from '@playwright/test';
import { cellRect } from '../../src/lab/grid';
import type { LabHook } from '../../src/lab/hook';

// Shared by the Creature Lab specs (M3 T13, T14): opening the page, calling the hook, and measuring
// decoded screenshots of the stage cell by cell.

export const SEED = 'lab-e2e';
export const QUERY = `?seed=${SEED}&debug=1`;
export const WATER = [0x04, 0x09, 0x0b] as const;
/**
 * What the post chain adds to every Lab frame (M6 T2, high preset): the prefilter, down, up and
 * composite programs, and the draws of a 5-level bloom (1 + 4 + 4) plus the composite. Neither
 * grows with the number of creatures, so the creature budgets stay as they were.
 */
export const LAB_POST = { programs: 4, calls: 10 } as const;
export const lab = <T>(page: Page, run: (hook: LabHook) => T) =>
  page.evaluate(`(${run.toString()})(window.__lab)`) as Promise<T>;

export async function openLab(page: Page, query = QUERY): Promise<void> {
  await page.goto(`./lab.html${query}`);
  await page.waitForFunction(() => window.__lab?.ready === true);
  // A running Lab renders 24 creatures every frame in software GL. The specs read single frames,
  // and the CI runner is shared with the multi-browser pond specs, so stop the loop.
  await page.evaluate(() => window.__lab?.debug?.pause());
}

export const stage = (page: Page): Locator => page.getByTestId('lab-canvas');

export interface CellStats {
  /** Pixels that differ from the water. */
  lit: number;
  /** Furthest lit pixel to the left and right of the cell centre, in pixels. */
  left: number;
  right: number;
  /** Share of the lit pixels in the largest 8-connected component. */
  connected: number;
  /** Mean luminance and colour (0..1) of the lit pixels. */
  luma: number;
  rgb: [number, number, number];
}

/** Decodes a screenshot of the stage inside the page and measures the lit pixels of each cell. */
export async function measureCells(page: Page, cells: number[]): Promise<CellStats[]> {
  const png = await stage(page).screenshot();
  const box = await stage(page).boundingBox();
  if (!box) throw new Error('no stage');
  const rects = cells.map((i) => cellRect(i, box.width, box.height));
  return page.evaluate(
    async ({ base64, rects, water }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const scratch = document.createElement('canvas');
      scratch.width = image.width;
      scratch.height = image.height;
      const context = scratch.getContext('2d');
      if (!context) throw new Error('2D canvas unavailable');
      context.drawImage(image, 0, 0);
      const { data } = context.getImageData(0, 0, image.width, image.height);
      const out = [];
      for (const r of rects) {
        const x0 = Math.floor(r.x);
        const y0 = Math.floor(r.y);
        const w = Math.floor(r.x + r.w) - x0;
        const h = Math.floor(r.y + r.h) - y0;
        const mask = new Uint8Array(w * h);
        let lit = 0;
        let left = 0;
        let right = 0;
        let sumR = 0;
        let sumG = 0;
        let sumB = 0;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const i = ((y0 + y) * image.width + x0 + x) * 4;
            const d =
              Math.abs((data[i] ?? 0) - (water[0] ?? 0)) +
              Math.abs((data[i + 1] ?? 0) - (water[1] ?? 0)) +
              Math.abs((data[i + 2] ?? 0) - (water[2] ?? 0));
            if (d > 24) {
              mask[y * w + x] = 1;
              lit++;
              left = Math.max(left, w / 2 - x);
              right = Math.max(right, x - w / 2);
              sumR += data[i] ?? 0;
              sumG += data[i + 1] ?? 0;
              sumB += data[i + 2] ?? 0;
            }
          }
        }
        // Largest 8-connected component by a flood fill with an explicit stack.
        let best = 0;
        const stack: number[] = [];
        for (let s = 0; s < mask.length; s++) {
          if (mask[s] !== 1) continue;
          let size = 0;
          mask[s] = 2;
          stack.push(s);
          while (stack.length > 0) {
            const p = stack.pop() as number;
            size++;
            const px = p % w;
            const py = (p - px) / w;
            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                const nx = px + dx;
                const ny = py + dy;
                if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                const n = ny * w + nx;
                if (mask[n] === 1) {
                  mask[n] = 2;
                  stack.push(n);
                }
              }
            }
          }
          best = Math.max(best, size);
        }
        const mean = [sumR, sumG, sumB].map((v) => (lit > 0 ? v / lit / 255 : 0)) as [
          number,
          number,
          number,
        ];
        out.push({
          lit,
          left,
          right,
          connected: lit > 0 ? best / lit : 0,
          luma: 0.2126 * mean[0] + 0.7152 * mean[1] + 0.0722 * mean[2],
          rgb: mean,
        });
      }
      return out;
    },
    { base64: png.toString('base64'), rects, water: [...WATER] },
  );
}

export const range = (n: number) => Array.from({ length: n }, (_, i) => i);
