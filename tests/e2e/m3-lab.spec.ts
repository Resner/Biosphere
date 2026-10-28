import { expect, test } from '@playwright/test';
import { decodeGenome, genomeToBase64url } from '../../src/genome/codec';
import { GENOME_BYTES, LOCI, MODULE_PARAMS } from '../../src/genome/karyotype';
import { starterGenome } from '../../src/genome/starter';
import { cellRect, stageCoreRadius } from '../../src/lab/grid';
import { labGenomes, specimenOf } from '../../src/lab/specimens';
import { ARCHETYPES, buildBytes } from '../archetypes';
import {
  type CellStats,
  LAB_POST,
  lab,
  measureCells,
  openLab,
  QUERY,
  range,
  SEED,
  stage,
  WATER,
} from './lab-helpers';

// The Creature Lab (M3 T13): a grid of 24 creatures from a seed, an inspector, and the look checks
// that the creature shader could not run in unit tests. Visual claims are properties of decoded
// screenshots (one connected body, a lit silhouette against the water), never pixel baselines.

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
  expect(info.calls).toBeLessThanOrEqual(40 + LAB_POST.calls);
  expect(info.triangles).toBeLessThan(150_000);
  expect(info.triangles).toBeGreaterThan(0);
  // One shader program serves every creature (and nothing else is drawn but the post chain).
  expect(info.programs).toBe(1 + LAB_POST.programs);

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
  // The silhouette class (M6 T8) names the body's shape.
  expect(creature?.silhouette).toMatch(/^[a-z-]+$/);
  await expect(page.getByTestId('inspect-facts')).toContainText(
    `Silhouette${creature?.silhouette}`,
  );
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
  expect((await lab(page, (l) => l.renderInfo())).calls).toBeLessThanOrEqual(40 + LAB_POST.calls);
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
  // their own) differs in the mean colour of its pigment. Bins would pit 0.166 against 0.168 at an
  // edge. Since M6 T12 the shell is nearly clear and the organs carry the hue, so the colour is
  // measured where it is: the most colourful tenth of the creature's pixels.
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
      const [ra, ga, ba] = (stats[a] as CellStats).pigment;
      const [rb, gb, bb] = (stats[b] as CellStats).pigment;
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
  // The six M3 archetypes, the three of development v2 (M6 T7), the two of fine parts (M6 T8) and
  // six extremes.
  expect(SAMPLES).toHaveLength(17);
  const ok = await page.evaluate(
    (texts) => window.__lab?.debug?.showGenomes(texts),
    SAMPLES.map(genomeToBase64url),
  );
  expect(ok).toBe(true);
  for (let phase = 0; phase < 4; phase++) {
    const stats = await measureCells(page, range(SAMPLES.length));
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
  const core = stageCoreRadius(box.width, box.height);
  for (let phase = 0; phase < 4; phase++) {
    const [s] = await measureCells(page, [0]);
    expect(s?.connected ?? 0).toBeGreaterThanOrEqual(0.98);
    // The whip pair trails past the cell wall (one core radius from the centre).
    expect(s?.left ?? 0).toBeGreaterThan(core * 1.15);
    expect(s?.right ?? 0).toBeLessThan(core * 1.3);
    await lab(page, (l) => l.debug?.advance(0.17));
  }
});
