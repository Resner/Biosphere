import { expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { decodeGenome, encodeGenome, genomeToBase64url } from '../../src/genome/codec';
import { HAPLOTYPE_BYTES, LOCI } from '../../src/genome/karyotype';
import { starterGenome } from '../../src/genome/starter';
import { PARTICLE_COUNTS, PRESETS, type PresetName } from '../../src/render/presets';
import { ZONE_LOOK } from '../../src/render/zones';
import type { Zone } from '../../src/sim/bathymetry';
import { foodNear } from '../../src/sim/food';
import { createWorld } from '../../src/sim/world';
import { hatch, openGame } from './helpers';

// Sunlight and marine snow (M6 T17): caustics on the water and over bodies, god rays in the
// composite, and snow carried by the currents with a few bright specks on high. Motion is judged on
// two decoded screenshots of the canvas alone, 2 s apart, with the world running: the cell can
// neither burn in the shallows nor be crushed in the abyss. Open water leaves out the player's body
// and the food, which bobs and glows by itself (`foodDiscs`).

// The motion test runs on the suite's low preset; the others choose theirs with `?quality=`.
// Each takes 12 to 17 s alone; a loaded runner renders software GL far slower.
test.describe.configure({ timeout: 60_000 });
const SEED = 'zones';

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

interface Disc {
  x: number;
  y: number;
  r: number;
}

const info = (page: Page) => page.evaluate(() => (window.__bs as BsHook).render.info());

async function waitForFrames(page: Page, frames = 3): Promise<void> {
  const before = Number(await page.locator('#scene').getAttribute('data-frames'));
  await page.waitForFunction(
    (target) => Number(document.querySelector('#scene')?.getAttribute('data-frames')) >= target,
    before + frames,
  );
}

async function play(page: Page, quality?: PresetName): Promise<void> {
  await openGame(
    page,
    `?debug=1&seed=${SEED}&genome=${HARDY}${quality ? `&quality=${quality}` : ''}`,
  );
  await hatch(page);
  const player = (await page.evaluate(() => (window.__bs as BsHook).state().player)) ?? null;
  expect(player?.stats.uvTolerance).toBe(1);
  expect(player?.stats.pressureTolerance).toBe(1);
}

/** Moves the player well inside a zone with the world held, then lets it run again. */
async function goToZone(page: Page, zone: Zone): Promise<void> {
  await page.evaluate((z) => {
    const debug = (window.__bs as BsHook).debug;
    debug?.timeScale(0);
    debug?.setZone(z);
    debug?.timeScale(1);
  }, zone);
  await waitForFrames(page);
  expect((await page.evaluate(() => (window.__bs as BsHook).state())).zone).toBe(zone);
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
 * Screen discs (CSS pixels) over the food in view at the page's tick, its glow and a few ticks of
 * bobbing included, worked out from the same pond in Node.
 */
async function foodDiscs(page: Page): Promise<Disc[]> {
  const view = await page.evaluate(() => {
    const hook = window.__bs as BsHook;
    const { camX, camY } = hook.render.fx();
    return {
      tick: hook.state().tick,
      camX,
      camY,
      pxPerWu: hook.render.info().pxPerWu,
      w: innerWidth,
      h: innerHeight,
    };
  });
  world.tick = view.tick;
  const reach = Math.hypot(view.w, view.h) / 2 / view.pxPerWu;
  return foodNear(world, view.camX, view.camY, reach).map((item) => ({
    x: view.w / 2 + (item.x - view.camX) * view.pxPerWu,
    y: view.h / 2 - (item.y - view.camY) * view.pxPerWu,
    r: (3 * item.radius + 3) * view.pxPerWu,
  }));
}

/** Mean absolute difference (0..255, over RGB) of two PNGs, outside the discs. */
function difference(page: Page, a: Buffer, b: Buffer, skip: Disc[]): Promise<number> {
  return page.evaluate(
    async ({ a, b, skip }) => {
      const pixels = async (base64: string) => {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('2D canvas unavailable');
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, image.width, image.height);
      };
      const one = await pixels(a);
      const two = await pixels(b);
      const { width, height } = one;
      const masked = new Uint8Array(width * height);
      for (const d of skip) {
        for (let y = Math.max(0, Math.floor(d.y - d.r)); y < Math.min(height, d.y + d.r); y++) {
          for (let x = Math.max(0, Math.floor(d.x - d.r)); x < Math.min(width, d.x + d.r); x++) {
            if (Math.hypot(x + 0.5 - d.x, y + 0.5 - d.y) < d.r) masked[y * width + x] = 1;
          }
        }
      }
      let sum = 0;
      let n = 0;
      for (let p = 0; p < width * height; p++) {
        if (masked[p]) continue;
        for (let c = 0; c < 3; c++) {
          sum += Math.abs((one.data[p * 4 + c] ?? 0) - (two.data[p * 4 + c] ?? 0));
        }
        n += 3;
      }
      return sum / n;
    },
    { a: a.toString('base64'), b: b.toString('base64'), skip },
  );
}

/** Particles a preset draws: its share of each layer's full count. */
const particlesOf = (preset: PresetName): number =>
  Object.values(PARTICLE_COUNTS).reduce(
    (sum, count) => sum + Math.round(count * PRESETS[preset].particles),
    0,
  );

test('caustics move the shallows; the abyss changes only as its snow drifts', async ({ page }) => {
  await play(page);
  const { pxPerWu } = await info(page);
  const player = (await page.evaluate(() => (window.__bs as BsHook).state().player)) ?? null;
  const { width, height } = page.viewportSize() ?? { width: 960, height: 540 };
  // The player's body: the camera centres on it.
  const body = { x: width / 2, y: height / 2, r: 3 * (player?.radius ?? 10) * pxPerWu };
  const change: Partial<Record<Zone, number>> = {};
  for (const zone of ['shallows', 'abyss'] as const) {
    await goToZone(page, zone);
    const skip = [body, ...(await foodDiscs(page))];
    const first = await shot(page);
    skip.push(...(await foodDiscs(page)));
    const specks = await page.evaluate(() => (window.__bs as BsHook).render.specks('mid'));
    await page.waitForTimeout(2000);
    skip.push(...(await foodDiscs(page)));
    const second = await shot(page);
    skip.push(...(await foodDiscs(page)));
    change[zone] = await difference(page, first, second, skip);
    // The snow drifts in every zone.
    const later = await page.evaluate(() => (window.__bs as BsHook).render.specks('mid'));
    const moved = later.filter((s) => {
      const before = specks.find((b) => b.index === s.index);
      return before && Math.hypot(s.x - before.x, s.y - before.y) > 0.5;
    });
    expect(moved.length, `${zone}: specks that drifted`).toBeGreaterThan(later.length / 2);
    if (zone === 'shallows') {
      // Low keeps the caustics in the water but has no composite to draw god rays in.
      const low = await info(page);
      expect(low.caustic).toBeGreaterThan(0);
      expect(low.rays).toBe(0);
      expect(low.particles).toBe(particlesOf('low'));
    }
  }
  const { shallows = 0, abyss = 0 } = change;
  expect(abyss, 'the abyss still changes a little').toBeGreaterThan(0);
  // The calm shallows (M6b T8) still move clearly more than the abyss: the spec's 1.5× (M6 T17
  // asked 3× of the busier v0.7.0 shallows; `m6b-water.spec.ts` measures the calming itself).
  expect(shallows, `shallows ${shallows} vs abyss ${abyss}`).toBeGreaterThanOrEqual(1.5 * abyss);
});

test.describe('presets', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('god rays and caustics follow the sunlight: calm in the shallows, fading through twilight, none deeper', async ({
    page,
  }) => {
    await play(page, 'medium');
    const light: Partial<Record<Zone, { rays: number; caustic: number }>> = {};
    for (const zone of ['shallows', 'twilight', 'deep'] as const) {
      await goToZone(page, zone);
      const { rays, caustic, passes, targets, particles } = await info(page);
      light[zone] = { rays, caustic };
      // Folded into the water shader and the composite: no pass and no target of their own.
      expect(passes).toEqual(['scene', 'refraction', 'dof', 'bloom', 'grade', 'vignette']);
      expect(targets).toBe(2 + 4);
      expect(particles).toBe(particlesOf('medium'));
    }
    const { shallows, twilight, deep } = light as Record<Zone, { rays: number; caustic: number }>;
    // The calm shallows (M6b T8) hold a faint light, below the twilight's top, where this lands
    // (just inside it) and the sunlight focuses most before fading through it (`zones.test.ts`).
    expect(shallows.rays).toBeGreaterThan(0);
    expect(shallows.rays).toBeLessThanOrEqual(0.5);
    expect(shallows.caustic).toBeGreaterThan(0);
    expect(shallows.caustic).toBeLessThanOrEqual(0.4);
    expect(twilight.rays).toBeGreaterThan(shallows.rays);
    expect(twilight.rays).toBeLessThanOrEqual(ZONE_LOOK.twilight.rays);
    expect(twilight.caustic).toBeGreaterThan(shallows.caustic);
    expect(twilight.caustic).toBeLessThanOrEqual(ZONE_LOOK.twilight.caustic);
    expect(deep).toEqual({ rays: 0, caustic: 0 });
    // The bright specks are high's alone.
    const snow = await page.evaluate(() => (window.__bs as BsHook).render.specks('mid'));
    expect(snow.some((s) => s.bright)).toBe(false);
  });

  test('high draws every effect within its budget, with a few bright specks', async ({ page }) => {
    await play(page, 'high');
    await goToZone(page, 'shallows');
    const high = await info(page);
    expect(high.rays).toBeGreaterThan(0);
    expect(high.caustic).toBeGreaterThan(0);
    expect(high.calls).toBeLessThanOrEqual(PRESETS.high.budget.calls);
    expect(high.triangles).toBeLessThanOrEqual(PRESETS.high.budget.triangles);
    expect(high.particles).toBe(particlesOf('high'));
    const snow = await page.evaluate(() => (window.__bs as BsHook).render.specks('mid'));
    const bright = snow.filter((s) => s.bright).length;
    expect(bright).toBeGreaterThan(0);
    expect(bright).toBeLessThan(snow.length * 0.06);
  });
});
