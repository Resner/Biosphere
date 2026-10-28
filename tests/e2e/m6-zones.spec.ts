import { expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { decodeGenome, encodeGenome, genomeToBase64url } from '../../src/genome/codec';
import { HAPLOTYPE_BYTES, LOCI } from '../../src/genome/karyotype';
import { starterGenome } from '../../src/genome/starter';
import { type Zone, zoneAt } from '../../src/sim/bathymetry';
import { createWorld } from '../../src/sim/world';
import { hatch, openGame, state } from './helpers';

// Depth zones on screen (M6 T16), judged on decoded screenshots of the canvas alone (the DOM is
// hidden for each shot). The world is frozen (`timeScale(0)`) before each move, so neither UV nor
// pressure can kill the cell and the shaders' clock holds still.

const SEED = 'zones';
const seed32 = createWorld({ seed: SEED }).seed32;

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

// `luminescence` is a Mendelian locus: byte 1 is the dominant "on" allele, byte 0 "off".
const DARK = starterWith({ luminescence: 0 });
const GLOWING = starterWith({ luminescence: 1, lumHue: 120 });
const UV_PROOF = starterWith({ uvTolerance: 255 });

async function waitForFrames(page: Page, frames = 3): Promise<void> {
  const before = Number(await page.locator('#scene').getAttribute('data-frames'));
  await page.waitForFunction(
    (target) => Number(document.querySelector('#scene')?.getAttribute('data-frames')) >= target,
    before + frames,
  );
}

async function play(page: Page, genome: string): Promise<void> {
  await openGame(page, `?debug=1&seed=${SEED}&genome=${genome}`);
  await hatch(page);
  await page.evaluate(() => (window.__bs as BsHook).debug?.timeScale(0));
}

async function goToZone(page: Page, zone: Zone): Promise<void> {
  await page.evaluate((z) => (window.__bs as BsHook).debug?.setZone(z), zone);
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
 * Luminance (0..255) statistics of the pixels between radii `r0` and `r1` around a point of a PNG:
 * the mean of the darkest `share` of them (the water, not food or specks), and the brightest.
 */
function ring(
  page: Page,
  png: Buffer,
  at: { x: number; y: number; r0: number; r1: number; share?: number },
): Promise<{ water: number; max: number }> {
  return page.evaluate(
    async ({ base64, at }) => {
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
          const d = Math.hypot(x - at.x, y - at.y);
          if (d < at.r0 || d > at.r1) continue;
          const i = (y * width + x) * 4;
          values.push(
            0.2126 * (data[i] ?? 0) + 0.7152 * (data[i + 1] ?? 0) + 0.0722 * (data[i + 2] ?? 0),
          );
        }
      }
      values.sort((a, b) => a - b);
      const kept = values.slice(0, Math.max(1, Math.floor(values.length * (at.share ?? 0.8))));
      return {
        water: kept.reduce((a, b) => a + b, 0) / kept.length,
        max: values[values.length - 1] ?? 0,
      };
    },
    { base64: png.toString('base64'), at },
  );
}

/** Where the player is drawn and its radius, in screenshot pixels (device scale factor 1). */
async function playerOnScreen(page: Page): Promise<{ x: number; y: number; r: number }> {
  return page.evaluate(() => {
    const hook = window.__bs as BsHook;
    const player = hook.state().player;
    if (!player) throw new Error('no player');
    const { pxPerWu } = hook.render.info();
    const { camX, camY } = hook.render.fx();
    return {
      x: innerWidth / 2 + (player.x - camX) * pxPerWu,
      y: innerHeight / 2 - (player.y - camY) * pxPerWu,
      r: player.radius * pxPerWu,
    };
  });
}

test('the water darkens strictly from the shallows to the abyss, and state() names the zone', async ({
  page,
}) => {
  await play(page, DARK);
  const means: number[] = [];
  for (const zone of ['shallows', 'twilight', 'deep', 'abyss'] as const) {
    await goToZone(page, zone);
    const s = await state(page);
    const player = s.player as NonNullable<typeof s.player>;
    expect(s.zone).toBe(zone);
    expect(s.zone).toBe(zoneAt(seed32, player.x, player.y));
    expect(s.depth).toBeGreaterThanOrEqual(0);
    await expect(page.getByTestId('hud-zone')).toHaveText(zone[0]?.toUpperCase() + zone.slice(1));
    const centre = await playerOnScreen(page);
    // Everything but the player's own body.
    const { water } = await ring(page, await shot(page), {
      ...centre,
      r0: centre.r * 3,
      r1: 4000,
    });
    means.push(water);
  }
  for (let i = 1; i < means.length; i++) {
    expect(means[i] as number, `zone ${i} darker than zone ${i - 1}: ${means}`).toBeLessThan(
      means[i - 1] as number,
    );
  }
});

test('a luminescent creature lights the abyss around it; a dark one does not', async ({ page }) => {
  const surround = async (genome: string) => {
    await play(page, genome);
    await goToZone(page, 'abyss');
    const centre = await playerOnScreen(page);
    return ring(page, await shot(page), {
      ...centre,
      r0: centre.r * 1.6,
      r1: centre.r * 4,
      share: 1,
    });
  };
  const dark = await surround(DARK);
  const glowing = await surround(GLOWING);
  expect(glowing.water, `glowing ${glowing.water} vs dark ${dark.water}`).toBeGreaterThan(
    dark.water + 4,
  );
});

test('a creature beyond the sight ring in the abyss is dimmed but keeps its rim', async ({
  page,
}) => {
  await play(page, DARK);
  await goToZone(page, 'abyss');
  const s = await state(page);
  const player = s.player as NonNullable<typeof s.player>;
  const { pxPerWu } = await page.evaluate(() => (window.__bs as BsHook).render.info());
  const dx = 300 / pxPerWu;
  await page.evaluate(
    ({ x, y, genome }) =>
      (window.__bs as BsHook).debug?.setRemotes([{ id: 'r1', name: 'Far', x, y, genome }]),
    { x: player.x + dx, y: player.y, genome: DARK },
  );
  await page.waitForFunction(() => (window.__bs as BsHook).render.info().remoteBodies === 1);
  const centre = await playerOnScreen(page);
  const png = await shot(page);
  const r = centre.r;
  const remote = await ring(page, png, { x: centre.x + 300, y: centre.y, r0: 0, r1: r * 1.3 });
  const water = await ring(page, png, { x: centre.x + 300, y: centre.y, r0: r * 3, r1: r * 5 });
  expect(remote.max, `rim ${remote.max} over water ${water.water}`).toBeGreaterThan(
    water.water + 40,
  );
});

test('the UV cue shows only in the shallows, and only below full UV tolerance', async ({
  page,
}) => {
  await play(page, DARK);
  const s = await state(page);
  expect(s.player?.stats.uvTolerance).toBeLessThan(1);
  const cue = page.getByTestId('uv-cue');
  for (const zone of ['twilight', 'deep', 'abyss'] as const) {
    await goToZone(page, zone);
    await expect(cue).toBeHidden();
  }
  await goToZone(page, 'shallows');
  await expect(cue).toBeVisible();
  await expect(page.getByTestId('hud-zone-warning')).toHaveText('UV burns');

  await play(page, UV_PROOF);
  expect((await state(page)).player?.stats.uvTolerance).toBe(1);
  await goToZone(page, 'shallows');
  await expect(page.getByTestId('hud-zone')).toHaveText('Shallows');
  await expect(cue).toBeHidden();
});

test('the pressure cue shows in the abyss for a creature that feels it', async ({ page }) => {
  await play(page, DARK);
  expect((await state(page)).player?.stats.pressureTolerance).toBeLessThan(1);
  const cue = page.getByTestId('pressure-cue');
  await goToZone(page, 'twilight');
  await expect(cue).toBeHidden();
  await goToZone(page, 'abyss');
  await expect(cue).toBeVisible();
  await expect(page.getByTestId('hud-zone-warning')).toHaveText('Pressure crushes');
});
