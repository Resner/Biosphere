import { expect, type Locator, type Page, test } from '@playwright/test';
import { decodeGenome, genomeToBase64url } from '../../src/genome/codec';
import { GENOME_BYTES, LOCI, MODULE_PARAMS } from '../../src/genome/karyotype';
import { starterGenome } from '../../src/genome/starter';
import { cellRect, coreRadius } from '../../src/lab/grid';
import type { LabHook } from '../../src/lab/hook';
import { labGenomes, specimenOf } from '../../src/lab/specimens';
import { ARCHETYPES, buildBytes } from '../archetypes';

// The Creature Lab (M3 T13): a grid of 24 creatures from a seed, an inspector, and the look checks
// that the creature shader could not run in unit tests. Visual claims are properties of decoded
// screenshots (one connected body, a lit silhouette against the water), never pixel baselines.

const SEED = 'lab-e2e';
const QUERY = `?seed=${SEED}&debug=1`;
const WATER = [0x04, 0x09, 0x0b] as const;
const lab = <T>(page: Page, run: (hook: LabHook) => T) =>
  page.evaluate(`(${run.toString()})(window.__lab)`) as Promise<T>;

async function openLab(page: Page, query = QUERY): Promise<void> {
  await page.goto(`./lab.html${query}`);
  await page.waitForFunction(() => window.__lab?.ready === true);
  // A running Lab renders 24 creatures every frame in software GL. The specs read single frames,
  // and the CI runner is shared with the multi-browser pond specs, so stop the loop.
  await page.evaluate(() => window.__lab?.debug?.pause());
}

const stage = (page: Page): Locator => page.getByTestId('lab-canvas');

interface CellStats {
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
async function measureCells(page: Page, cells: number[]): Promise<CellStats[]> {
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

const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const waterLuma = (0.2126 * WATER[0] + 0.7152 * WATER[1] + 0.0722 * WATER[2]) / 255;

test('the title screen links to the Lab and the Lab links back', async ({ page }) => {
  await page.goto('./');
  await page.getByTestId('lab-link').click();
  await expect(page).toHaveURL(/lab\.html/);
  await page.waitForFunction(() => window.__lab?.ready === true);
  await page.getByTestId('lab-back').click();
  await expect(page.getByTestId('hatch')).toBeVisible();
});

test('the Lab shows 24 different creatures within the render budget, offline', async ({
  page,
  baseURL,
}) => {
  const problems: string[] = [];
  const foreign: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(m.text());
  });
  page.on('pageerror', (e) => problems.push(e.message));
  const origin = new URL(baseURL as string).origin;
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (url.protocol.startsWith('http') && url.origin !== origin) foreign.push(r.url());
  });
  await openLab(page);

  const state = await lab(page, (l) => l.state());
  expect(state.seed).toBe(SEED);
  expect(state.mode).toBe('genesis');
  expect(state.creatures).toHaveLength(24);
  expect(new Set(state.creatures.map((c) => c.hash)).size).toBe(24);
  expect(state.creatures.every((c) => c.valid && c.vertices > 0)).toBe(true);
  // The same seed gives the same creatures as the Node-side pure function.
  const expected = labGenomes(SEED, 'genesis').map((g) => specimenOf(g).creature.hash);
  expect(state.creatures.map((c) => c.hash)).toEqual(expected);

  const info = await lab(page, (l) => l.renderInfo());
  expect(info.calls).toBeLessThanOrEqual(40);
  expect(info.triangles).toBeLessThan(150_000);
  expect(info.triangles).toBeGreaterThan(0);
  // One shader program serves every creature (and nothing else is drawn).
  expect(info.programs).toBe(1);

  const stats = await measureCells(page, range(24));
  expect(stats.every((s) => s.lit > 50)).toBe(true);
  expect(problems).toEqual([]);
  expect(foreign).toEqual([]);
});

test('hovering and clicking a creature fills the inspector', async ({ page }) => {
  await openLab(page);
  await expect(page.getByTestId('inspect-name')).toHaveText(/Click a creature/);
  const box = (await stage(page).boundingBox()) as {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  const at = (i: number) => {
    const r = cellRect(i, box.width, box.height);
    return { x: box.x + r.x + r.w / 2, y: box.y + r.y + r.h / 2 };
  };

  await page.mouse.move(at(3).x, at(3).y);
  expect(await lab(page, (l) => l.state().hovered)).toBe(3);

  await page.mouse.click(at(5).x, at(5).y);
  const state = await lab(page, (l) => l.state());
  expect(state.selected).toBe(5);
  const creature = state.creatures[5];
  await expect(page.getByTestId('inspect-name')).toHaveText(creature?.species ?? 'x');
  const lines = await page.getByTestId('inspect-lines').locator('li').allTextContents();
  expect(lines).toHaveLength(6);
  await expect(page.getByTestId('inspect-facts')).toContainText(creature?.hash.slice(0, 12) ?? 'x');
  await expect(page.getByTestId('inspect-facts')).toContainText(String(creature?.vertices));
  await expect(page.getByTestId('inspect-facts')).toContainText(creature?.rarity ?? 'x', {
    ignoreCase: true,
  });

  await lab(page, (l) => l.select(0));
  expect(await lab(page, (l) => l.state().selected)).toBe(0);
});

test('wild mode shows 24 valid bodies and the toggle switches back', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(m.text());
  });
  await openLab(page);
  await page.getByTestId('mode-wild').click();
  const wild = await lab(page, (l) => l.state());
  expect(wild.mode).toBe('wild');
  expect(wild.creatures).toHaveLength(24);
  expect(new Set(wild.creatures.map((c) => c.hash)).size).toBe(24);
  expect(wild.creatures.every((c) => c.valid)).toBe(true);
  expect((await lab(page, (l) => l.renderInfo())).calls).toBeLessThanOrEqual(40);
  const stats = await measureCells(page, range(24));
  expect(stats.every((s) => s.lit > 50)).toBe(true);

  await lab(page, (l) => l.setMode('genesis'));
  expect((await lab(page, (l) => l.state())).mode).toBe('genesis');
  expect(problems).toEqual([]);
});

test('creatures read against the water, and different hues look different', async ({ page }) => {
  await openLab(page);
  const stats = await measureCells(page, range(24));
  const specimens = labGenomes(SEED, 'genesis').map((g) => specimenOf(g));
  for (const [i, s] of stats.entries()) {
    expect(s.luma - waterLuma, `creature ${i} against the water`).toBeGreaterThanOrEqual(0.12);
  }
  // Every pair with clearly different hues (a sixth of the wheel apart; albinos have no hue of
  // their own) differs in mean colour. Bins would pit 0.166 against 0.168 at an edge.
  const hueOf = (i: number) => {
    const c = (specimens[i] as ReturnType<typeof specimenOf>).creature.traits.colour;
    return c.albino === 'normal' ? c.hue : null;
  };
  let closest = Number.POSITIVE_INFINITY;
  let pairs = 0;
  for (let a = 0; a < 24; a++) {
    for (let b = a + 1; b < 24; b++) {
      const ha = hueOf(a);
      const hb = hueOf(b);
      if (ha === null || hb === null) continue;
      const apart = Math.abs(ha - hb);
      if (Math.min(apart, 1 - apart) < 1 / 6) continue;
      pairs++;
      const [ra, ga, ba] = (stats[a] as CellStats).rgb;
      const [rb, gb, bb] = (stats[b] as CellStats).rgb;
      closest = Math.min(closest, Math.hypot(ra - rb, ga - gb, ba - bb));
    }
  }
  expect(pairs).toBeGreaterThan(50);
  expect(closest).toBeGreaterThan(0.08);
});

const MODULE_IDS = LOCI.filter((l) => l.kind === 'module').map((l) => l.id);
const allModules = (value: number) => {
  const params = Object.fromEntries(MODULE_PARAMS.map((p) => [p, value]));
  return Object.fromEntries(MODULE_IDS.map((id) => [id, params]));
};
const SAMPLES = [
  ...Object.values(ARCHETYPES),
  decodeGenome(new Uint8Array(GENOME_BYTES)),
  decodeGenome(new Uint8Array(GENOME_BYTES).fill(0xff)),
  decodeGenome(buildBytes(allModules(0))),
  decodeGenome(buildBytes(allModules(255))),
  decodeGenome(buildBytes(allModules(255), { segDrive1: 255, segDrive2: 255 })),
  decodeGenome(Uint8Array.from({ length: GENOME_BYTES }, (_, i) => (i % 2 ? 0xff : 0))),
];

test('every sample body is one connected shape at four gait phases', async ({ page }) => {
  await openLab(page);
  expect(SAMPLES).toHaveLength(12);
  const ok = await page.evaluate(
    (texts) => window.__lab?.debug?.showGenomes(texts),
    SAMPLES.map(genomeToBase64url),
  );
  expect(ok).toBe(true);
  for (let phase = 0; phase < 4; phase++) {
    const stats = await measureCells(page, range(12));
    for (const [i, s] of stats.entries()) {
      expect(s.lit, `sample ${i} phase ${phase} is drawn`).toBeGreaterThan(50);
      expect(s.connected, `sample ${i} phase ${phase} is one body`).toBeGreaterThanOrEqual(0.98);
    }
    await lab(page, (l) => l.debug?.advance(0.17));
  }
});

test('the starter cell has a whip that touches its wall', async ({ page }) => {
  await openLab(page);
  await page.evaluate(
    (text) => window.__lab?.debug?.showGenomes([text]),
    genomeToBase64url(starterGenome()),
  );
  const box = (await stage(page).boundingBox()) as { width: number; height: number };
  const cell = cellRect(0, box.width, box.height);
  const core = coreRadius(cell.w, cell.h);
  for (let phase = 0; phase < 4; phase++) {
    const [s] = await measureCells(page, [0]);
    expect(s?.connected ?? 0).toBeGreaterThanOrEqual(0.98);
    // The whip pair trails past the cell wall (one core radius from the centre).
    expect(s?.left ?? 0).toBeGreaterThan(core * 1.15);
    expect(s?.right ?? 0).toBeLessThan(core * 1.3);
    await lab(page, (l) => l.debug?.advance(0.17));
  }
});
