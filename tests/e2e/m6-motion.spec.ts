import { readdirSync, readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { genomeToBase64url } from '../../src/genome/codec';
import { buildCreature } from '../../src/genome/stats';
import { parseSpecimen } from '../../src/lab/gallery';
import { cellRect, stageCoreRadius } from '../../src/lab/grid';
import { buildCreatureGeometry, partId } from '../../src/render/creature-mesh';
import { lab, openLab, stage } from './lab-helpers';

// Motion v2 (M6 T11) in the Creature Lab: with the clock stopped (`debug.pause`) and stepped
// (`advance`), two frames 0.25 s apart differ inside every specimen's parts and are equal outside
// every creature (to the bloom's rounding), so the bodies move and nothing else does.

const DIR = new URL('../fixtures/gallery/', import.meta.url);
// One specimen of every silhouette class (M6 T9): cell to fan tail.
const SPECIMENS = readdirSync(DIR)
  .filter((f) => /^(2[1-9]|3[0-2])-specimen-/.test(f))
  .sort()
  .map((file) => {
    const parsed = parseSpecimen(file, readFileSync(new URL(file, DIR), 'utf8'));
    if (!parsed) throw new Error(`bad specimen ${file}`);
    return { file, genome: parsed.genome };
  });

/** The box round a specimen's parts at rest, in core radii (x forward, y left). */
function partBox(genome: (typeof SPECIMENS)[number]['genome']) {
  const geometry = buildCreatureGeometry(buildCreature(genome).plan, 'high');
  const position = geometry.getAttribute('position').array;
  const part = geometry.getAttribute('aPart').array;
  const box = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
  for (let i = 0; i < part.length; i++) {
    if (partId(part[i] as number) === 0) continue;
    const [x, y] = [position[i * 3] as number, position[i * 3 + 1] as number];
    box.x0 = Math.min(box.x0, x);
    box.x1 = Math.max(box.x1, x);
    box.y0 = Math.min(box.y0, y);
    box.y1 = Math.max(box.y1, y);
  }
  geometry.dispose();
  return box;
}

/** A decoded screenshot of the stage: RGB per pixel. */
async function frame(page: Page): Promise<{ width: number; height: number; rgb: Uint8Array }> {
  const png = await stage(page).screenshot();
  const { width, height, base64 } = await page.evaluate(async (data) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const c = document.createElement('canvas');
    c.width = image.width;
    c.height = image.height;
    const g = c.getContext('2d');
    if (!g) throw new Error('2D canvas unavailable');
    g.drawImage(image, 0, 0);
    const rgba = g.getImageData(0, 0, image.width, image.height).data;
    const out = new Uint8Array(image.width * image.height * 3);
    for (let i = 0; i < image.width * image.height; i++) {
      out[i * 3] = rgba[i * 4] ?? 0;
      out[i * 3 + 1] = rgba[i * 4 + 1] ?? 0;
      out[i * 3 + 2] = rgba[i * 4 + 2] ?? 0;
    }
    let text = '';
    for (let i = 0; i < out.length; i += 0x8000) {
      text += String.fromCharCode(...out.subarray(i, i + 0x8000));
    }
    return { width: image.width, height: image.height, base64: btoa(text) };
  }, png.toString('base64'));
  return { width, height, rgb: new Uint8Array(Buffer.from(base64, 'base64')) };
}

test('two frames 0.25 s apart differ inside every specimen’s parts and match outside every creature', async ({
  page,
}) => {
  await openLab(page);
  expect(SPECIMENS).toHaveLength(12);
  const ok = await page.evaluate(
    (texts) => window.__lab?.debug?.showGenomes(texts),
    SPECIMENS.map((s) => genomeToBase64url(s.genome)),
  );
  expect(ok).toBe(true);
  await lab(page, (l) => l.debug?.advance(0.5));
  const a = await frame(page);
  // The same frame again: a paused Lab draws the same picture (the film grain holds too).
  await lab(page, (l) => l.debug?.advance(0));
  const again = await frame(page);
  await lab(page, (l) => l.debug?.advance(0.25));
  const b = await frame(page);

  const box = (await stage(page).boundingBox()) as { width: number; height: number };
  const core = stageCoreRadius(box.width, box.height);
  const centres = SPECIMENS.map((_, i) => {
    const r = cellRect(i, box.width, box.height);
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  });
  const scale = a.width / box.width;
  const lum = (f: typeof a, i: number) =>
    0.2126 * (f.rgb[i * 3] as number) +
    0.7152 * (f.rgb[i * 3 + 1] as number) +
    0.0722 * (f.rgb[i * 3 + 2] as number);

  for (const [k, s] of SPECIMENS.entries()) {
    const c = centres[k] as { x: number; y: number };
    const p = partBox(s.genome);
    const [x0, x1] = [c.x + p.x0 * core, c.x + p.x1 * core].map((v) => Math.round(v * scale));
    const [y0, y1] = [c.y - p.y1 * core, c.y - p.y0 * core].map((v) => Math.round(v * scale));
    let sum = 0;
    let count = 0;
    let moved = 0;
    for (let y = y0 as number; y <= (y1 as number); y++) {
      for (let x = x0 as number; x <= (x1 as number); x++) {
        const i = y * a.width + x;
        sum += Math.abs(lum(a, i) - lum(b, i));
        count++;
        if (Math.abs(lum(a, i) - lum(b, i)) >= 12) moved++;
      }
    }
    expect(sum / count, `${s.file}: mean difference in its part box`).toBeGreaterThanOrEqual(2);
    // The outline moves, not only the shading: edges sweep across pixels.
    expect(moved, `${s.file}: pixels the parts swept`).toBeGreaterThanOrEqual(10);
  }

  // Outside every creature (its reach plus the gait's 0.6 core radii, and a margin for its rim's
  // glow) nothing moves. The bloom's widest level spreads a creature's light over the whole stage at
  // under one level, so a moving body may round a far pixel the other way: never by more than 1.
  const keep = (3.1 + 1.5) * core * scale;
  let outside = 0;
  let equal = 0;
  let worst = 0;
  let unstable = 0;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const i = y * a.width + x;
      for (let ch = 0; ch < 3; ch++) if (a.rgb[i * 3 + ch] !== again.rgb[i * 3 + ch]) unstable++;
      if (centres.some((c) => Math.hypot(x - c.x * scale, y - c.y * scale) < keep)) continue;
      outside++;
      let same = true;
      for (let ch = 0; ch < 3; ch++) {
        const d = Math.abs((a.rgb[i * 3 + ch] as number) - (b.rgb[i * 3 + ch] as number));
        worst = Math.max(worst, d);
        if (d > 0) same = false;
      }
      if (same) equal++;
    }
  }
  expect(unstable).toBe(0);
  expect(outside).toBeGreaterThan(a.width * a.height * 0.2);
  expect(worst).toBeLessThanOrEqual(1);
  expect(equal / outside).toBeGreaterThanOrEqual(0.99);
});
