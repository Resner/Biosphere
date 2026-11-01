import { readdirSync, readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { decodeGenome, encodeGenome, genomeToBase64url } from '../../src/genome/codec';
import { HAPLOTYPE_BYTES, LOCI } from '../../src/genome/karyotype';
import { starterGenome } from '../../src/genome/starter';
import { parseSpecimen } from '../../src/lab/gallery';
import type { Zone } from '../../src/sim/bathymetry';
import { foodNear } from '../../src/sim/food';
import { TICK_HZ } from '../../src/sim/rules';
import { createWorld } from '../../src/sim/world';
import { hatch, openGame } from './helpers';
import { decodePng, type Image } from './look-metrics';

// Calmer shallows (M6b T8): the shallows' caustics, god rays and caustics over bodies calm down,
// while every zone keeps its colours and fog. Measured on the medium preset, on decoded screenshots
// of the canvas alone, each zone at the same place and the same shader clock on every run (a hardy
// cell neither burns nor is crushed):
// - `change`: the mean absolute difference (0..255 over RGB) between two frames 2 s of sim apart;
// - `spread`: the luminance standard deviation of the 200×200 open-water patches (`spreadOf`);
// - `luma`: the water's mean luminance;
// - `caustic` and `rays`: `render.info()`.
// The player's body and the food (which bobs and glows by itself) are left out of every measure.

test.describe.configure({ timeout: 240_000 });
test.use({ storageState: { cookies: [], origins: [] } });

const SEED = 'zones';
const PATCH = 200;
/**
 * The shaders' clock (seconds) at each first frame: typical moments, not the pattern's start. The
 * light changes faster at some moments of its pattern than at others, so the shallows, whose
 * targets are fractions of main's, are measured at all three; the other zones at the first.
 */
const CLOCKS = [100, 137, 171] as const;

/** The starter cell with some loci set to the same byte on both haplotypes. */
function starterWith(bytes: Record<string, number>): string {
  const raw = encodeGenome(starterGenome());
  for (const [id, value] of Object.entries(bytes)) {
    const locus = LOCI.find((l) => 'id' in l && l.id === id) as { offset: number } | undefined;
    if (!locus) throw new Error(`no locus ${id}`);
    for (let hap = 0; hap < 2; hap++) raw[hap * HAPLOTYPE_BYTES + locus.offset] = value;
  }
  return genomeToBase64url(decodeGenome(raw));
}

const HARDY = starterWith({ uvTolerance: 255, pressureTolerance: 255 });
/** The same pond in Node, to know where its food is drawn. */
const world = createWorld({ seed: SEED });
/** Each zone is measured at the nearest point well inside it to the pond's centre. */
const HOME = { x: world.size / 2, y: world.size / 2 };

interface Disc {
  x: number;
  y: number;
  r: number;
}

interface Measures {
  change: number;
  spread: number;
  luma: number;
  caustic: number;
  rays: number;
}

/**
 * The same measures on main before T8 (8c0ef37, median of three runs). The shallows' targets are
 * fractions of these; the other zones stay within `HOLD` of them.
 */
const MAIN: Readonly<Record<Zone, Measures>> = {
  shallows: { change: 4.9, spread: 10.18, luma: 33.83, caustic: 1.4, rays: 1 },
  twilight: { change: 1.987, spread: 3.431, luma: 15.41, caustic: 0.2877, rays: 0.2302 },
  deep: { change: 1.01, spread: 1.901, luma: 6.811, caustic: 0, rays: 0 },
  abyss: { change: 0.549, spread: 0.8015, luma: 3.5, caustic: 0, rays: 0 },
};
/** How far the twilight, deep and abyss measures may move from main's. */
const HOLD = 0.05;

const info = (page: Page) => page.evaluate(() => (window.__bs as BsHook).render.info());

async function waitForFrames(page: Page, frames = 3): Promise<void> {
  const before = Number(await page.locator('#scene').getAttribute('data-frames'));
  await page.waitForFunction(
    (target) => Number(document.querySelector('#scene')?.getAttribute('data-frames')) >= target,
    before + frames,
  );
}

/**
 * Holds the world, moves the player from `HOME` to the nearest point well inside a zone, settles
 * the snow and sets the shaders' clock: every run measures the same frame.
 */
async function goToZone(page: Page, zone: Zone, clock: number = CLOCKS[0]): Promise<void> {
  await page.evaluate(
    ({ zone, home, clock }) => {
      const debug = (window.__bs as BsHook).debug;
      debug?.timeScale(0);
      debug?.teleport(home.x, home.y);
      debug?.setZone(zone);
      debug?.resetWater();
      debug?.setClock(clock);
    },
    { zone, home: HOME, clock },
  );
  await waitForFrames(page);
  expect((await page.evaluate(() => (window.__bs as BsHook).state())).zone).toBe(zone);
}

/** A screenshot of the canvas alone, decoded. */
async function shot(page: Page): Promise<Image> {
  const style = await page.addStyleTag({
    content: 'body > :not(#scene) { visibility: hidden !important; }',
  });
  await waitForFrames(page, 2);
  const png = await page.locator('#scene').screenshot();
  await style.evaluate((node) => (node as HTMLStyleElement).remove());
  return decodePng(page, png);
}

/** Screen discs (CSS pixels) over the player's body and the food in view, glow and bobbing included. */
async function skipDiscs(page: Page): Promise<Disc[]> {
  const view = await page.evaluate(() => {
    const hook = window.__bs as BsHook;
    const { camX, camY } = hook.render.fx();
    const player = hook.state().player;
    return {
      tick: hook.state().tick,
      camX,
      camY,
      player: player ? { x: player.x, y: player.y, radius: player.radius } : null,
      pxPerWu: hook.render.info().pxPerWu,
      w: innerWidth,
      h: innerHeight,
    };
  });
  world.tick = view.tick;
  const reach = Math.hypot(view.w, view.h) / 2 / view.pxPerWu;
  const at = (x: number, y: number, r: number): Disc => ({
    x: view.w / 2 + (x - view.camX) * view.pxPerWu,
    y: view.h / 2 - (y - view.camY) * view.pxPerWu,
    r: r * view.pxPerWu,
  });
  const discs = foodNear(world, view.camX, view.camY, reach).map((item) =>
    at(item.x, item.y, 3 * item.radius + 3),
  );
  if (view.player) discs.push(at(view.player.x, view.player.y, 3 * view.player.radius));
  return discs;
}

/** 1 where a pixel lies inside any disc. */
function maskOf(width: number, height: number, discs: Disc[]): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (const d of discs) {
    for (let y = Math.max(0, Math.floor(d.y - d.r)); y < Math.min(height, d.y + d.r); y++) {
      for (let x = Math.max(0, Math.floor(d.x - d.r)); x < Math.min(width, d.x + d.r); x++) {
        if (Math.hypot(x + 0.5 - d.x, y + 0.5 - d.y) < d.r) mask[y * width + x] = 1;
      }
    }
  }
  return mask;
}

const lumaAt = (rgba: Image['rgba'], p: number): number =>
  0.2126 * (rgba[p * 4] ?? 0) + 0.7152 * (rgba[p * 4 + 1] ?? 0) + 0.0722 * (rgba[p * 4 + 2] ?? 0);

/** A patch counts while at most this share of it lies under the discs. */
const OPEN = 0.5;
/** The brightest share of a patch's pixels left out of its spread: the marine snow's specks. */
const SPECKS = 0.01;

/**
 * The luminance standard deviation of the open-water 200×200 patches that tile the frame (inset
 * from its vignetted edges), averaged. Pixels under the discs and each patch's brightest specks are
 * left out, so the measure is the water's own texture, not where the snow happened to be.
 */
function spreadOf(image: Image, mask: Uint8Array): number {
  const { width, height, rgba } = image;
  const inset = 40;
  const spreads: number[] = [];
  for (let y = inset; y + PATCH <= height - inset; y += PATCH) {
    for (let x = inset; x + PATCH <= width - inset; x += PATCH) {
      const values: number[] = [];
      for (let j = y; j < y + PATCH; j++) {
        for (let i = x; i < x + PATCH; i++) {
          if (!mask[j * width + i]) values.push(lumaAt(rgba, j * width + i));
        }
      }
      if (values.length < (1 - OPEN) * PATCH * PATCH) continue;
      values.sort((a, b) => a - b);
      const kept = values.slice(0, Math.floor(values.length * (1 - SPECKS)));
      const mean = kept.reduce((a, b) => a + b, 0) / kept.length;
      const variance = kept.reduce((a, b) => a + (b - mean) ** 2, 0) / kept.length;
      spreads.push(Math.sqrt(variance));
    }
  }
  expect(spreads.length, 'open-water patches in view').toBeGreaterThan(0);
  return spreads.reduce((a, b) => a + b, 0) / spreads.length;
}

/**
 * The zone's measures at one moment: the first frame held still, then a second after 2 s of the
 * world running. Luminance and spread come from the first frame, which is the same on every run.
 */
async function measureAt(page: Page, zone: Zone, clock: number): Promise<Measures> {
  await goToZone(page, zone, clock);
  const held = await skipDiscs(page);
  const first = await shot(page);
  const { caustic, rays } = await info(page);
  // The world runs for 2 s of sim (the snow drifts with the ticks, however slowly the runner draws)
  // and stops on the frame it gets there; the second frame's clock is exact.
  await page.evaluate(
    ({ clock, ticks }) =>
      new Promise<void>((resolve) => {
        const hook = window.__bs as BsHook;
        const target = hook.state().tick + ticks;
        hook.debug?.timeScale(1);
        const check = () => {
          if (hook.state().tick < target) {
            requestAnimationFrame(check);
            return;
          }
          hook.debug?.timeScale(0);
          hook.debug?.setClock(clock + 2);
          resolve();
        };
        requestAnimationFrame(check);
      }),
    { clock, ticks: 2 * TICK_HZ },
  );
  const moved = [...held, ...(await skipDiscs(page))];
  const second = await shot(page);
  const { width, height } = first;
  const still = maskOf(width, height, held);
  const both = maskOf(width, height, moved);
  let diff = 0;
  let n = 0;
  let sum = 0;
  let m = 0;
  for (let p = 0; p < width * height; p++) {
    if (!still[p]) {
      sum += lumaAt(first.rgba, p);
      m++;
    }
    if (both[p]) continue;
    for (let c = 0; c < 3; c++) {
      diff += Math.abs((first.rgba[p * 4 + c] ?? 0) - (second.rgba[p * 4 + c] ?? 0));
    }
    n++;
  }
  return {
    change: diff / (3 * n),
    spread: spreadOf(first, still),
    luma: sum / m,
    caustic,
    rays,
  };
}

/** The zone's measures, averaged over `clocks`. */
async function measure(page: Page, zone: Zone, clocks: readonly number[]): Promise<Measures> {
  const all: Measures[] = [];
  for (const clock of clocks) all.push(await measureAt(page, zone, clock));
  const mean = (key: keyof Measures) => all.reduce((a, b) => a + b[key], 0) / all.length;
  const measures = {
    change: mean('change'),
    spread: mean('spread'),
    luma: mean('luma'),
    // Constant through a zone.
    caustic: all[0]?.caustic ?? 0,
    rays: all[0]?.rays ?? 0,
  };
  console.log(`${zone}: ${JSON.stringify(measures)}`);
  return measures;
}

/** Opens the game at medium and hatches. */
async function play(page: Page, genome = HARDY): Promise<void> {
  await openGame(page, `?debug=1&seed=${SEED}&genome=${genome}&quality=medium`);
  await hatch(page);
  expect((await info(page)).preset).toBe('medium');
}

const within = (value: number, main: number, label: string) => {
  expect(value, `${label}: ${value} vs main ${main}`).toBeGreaterThanOrEqual(main * (1 - HOLD));
  expect(value, `${label}: ${value} vs main ${main}`).toBeLessThanOrEqual(main * (1 + HOLD));
};

test('the shallows are calmer, and the zones still read apart @slow', async ({ page }) => {
  await play(page);
  const m = {} as Record<Zone, Measures>;
  for (const zone of ['shallows', 'twilight', 'deep', 'abyss'] as const) {
    m[zone] = await measure(page, zone, zone === 'shallows' ? CLOCKS : CLOCKS.slice(0, 1));
  }
  const { shallows, twilight, deep, abyss } = m;
  // The shallows calm down.
  expect(shallows.change, 'shallows change').toBeLessThanOrEqual(0.5 * MAIN.shallows.change);
  expect(shallows.spread, 'shallows spread').toBeLessThanOrEqual(0.6 * MAIN.shallows.spread);
  expect(shallows.caustic, 'caustics over bodies').toBeLessThanOrEqual(0.4);
  expect(shallows.rays, 'god rays').toBeLessThanOrEqual(0.5);
  expect(shallows.caustic).toBeGreaterThan(0);
  expect(shallows.rays).toBeGreaterThan(0);
  // The zones still read apart: the water darkens with depth, and the shallows still move most.
  expect(shallows.luma).toBeGreaterThan(twilight.luma);
  expect(twilight.luma).toBeGreaterThan(deep.luma);
  expect(deep.luma).toBeGreaterThan(abyss.luma);
  expect(shallows.change, 'shallows vs abyss change').toBeGreaterThanOrEqual(1.5 * abyss.change);
  // The deeper zones keep main's look.
  for (const zone of ['twilight', 'deep', 'abyss'] as const) {
    const now = m[zone];
    const main = MAIN[zone];
    for (const key of ['change', 'spread', 'luma'] as const) {
      within(now[key], main[key], `${zone} ${key}`);
    }
    expect(now.caustic, `${zone} caustic`).toBeCloseTo(main.caustic, 2);
    expect(now.rays, `${zone} rays`).toBeCloseTo(main.rays, 2);
  }
});

const DIR = new URL('../fixtures/gallery/', import.meta.url);

/** A gallery specimen's genome, as the game takes it. */
function specimen(prefix: string): string {
  const file = readdirSync(DIR)
    .filter((f) => f.endsWith('.hex'))
    .sort()
    .find((f) => f.startsWith(prefix));
  const parsed = file && parseSpecimen(file, readFileSync(new URL(file, DIR), 'utf8'));
  if (!parsed) throw new Error(`no specimen ${prefix}`);
  return genomeToBase64url(parsed.genome);
}

test('a body over the shallows keeps its rim well above the water', async ({ page }) => {
  // M6 T10's in-game check (`m6-creature-mesh`), moved to the shallows, with the world held.
  await play(page, specimen('31-specimen-winged'));
  await page.waitForFunction(() => (window.__bs as BsHook).render.info().playerBody);
  await goToZone(page, 'shallows');
  await page.waitForTimeout(300);
  const { pxPerWu, caustic } = await info(page);
  expect(caustic).toBeGreaterThan(0);
  const player = await page.evaluate(() => (window.__bs as BsHook).state().player);
  if (!player) throw new Error('no player');
  const image = await shot(page);
  const r = player.radius * pxPerWu;
  const [cx, cy] = [image.width / 2, image.height / 2];
  const water: number[] = [];
  const body: number[] = [];
  for (let y = 0; y < image.height; y += 2) {
    for (let x = 0; x < image.width; x += 2) {
      const d = Math.hypot(x - cx, y - cy);
      const l = lumaAt(image.rgba, y * image.width + x);
      if (d <= 1.05 * r) body.push(l);
      else if (d >= 3 * r && d <= 4.5 * r) water.push(l);
    }
  }
  body.sort((a, b) => a - b);
  water.sort((a, b) => a - b);
  const rim = body[Math.floor(body.length * 0.98)] as number;
  const median = water[Math.floor(water.length / 2)] as number;
  console.log(`shallows rim ${rim.toFixed(1)}, water ${median.toFixed(1)}`);
  expect(rim - median).toBeGreaterThanOrEqual(40);
});
