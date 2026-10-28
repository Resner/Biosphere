import { expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import type { Speck } from '../../src/render/particles';
import { PRESETS } from '../../src/render/presets';
import { hatch, openGame } from './helpers';

// The depth of field (M6 T3), judged on decoded screenshots against the same preset with the DOF
// switched off (`?dof=0`). Each page freezes the world and its animation (`timeScale(0)`), so the
// specks stand still and `render.specks()` says where each one is drawn; a speck keeps its index, size and depth from page to
// page, though it drifts to another place. The DOM HUD is hidden for each shot.

// The suite default is the low preset (playwright.config.ts); these specs choose their own.
test.use({ storageState: { cookies: [], origins: [] } });
// Each scenario renders two pages of the post chain in software: twice what one look takes.
test.describe.configure({ timeout: 60_000 });

type Preset = 'medium' | 'high';

const info = (page: Page) => page.evaluate(() => (window.__bs as BsHook).render.info());
const specks = (page: Page, layer: 'far' | 'mid' | 'near') =>
  page.evaluate((l) => (window.__bs as BsHook).render.specks(l), layer);

async function waitForFrames(page: Page, frames = 3): Promise<void> {
  const before = Number(await page.locator('#scene').getAttribute('data-frames'));
  await page.waitForFunction(
    (target) => Number(document.querySelector('#scene')?.getAttribute('data-frames')) >= target,
    before + frames,
  );
}

/** Hatches the starter cell on `preset`, with or without the DOF, and freezes the world. */
async function play(page: Page, preset: Preset, dof: boolean): Promise<void> {
  await openGame(page, `?debug=1&seed=dof&quality=${preset}${dof ? '' : '&dof=0'}`);
  await hatch(page);
  await page.evaluate(() => (window.__bs as BsHook).debug?.timeScale(0));
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

type Probe =
  /** Median luminance of each 1 px ring from the centre out to `max`. */
  | { kind: 'profile'; x: number; y: number; max: number }
  /** Pixels within `r` brighter than the ring just outside it by more than `delta`. */
  | { kind: 'cover'; x: number; y: number; r: number; delta: number };

function measure(page: Page, png: Buffer, probes: Probe[]): Promise<number[][]> {
  return page.evaluate(
    async ({ base64, probes }) => {
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
      const luma = (x: number, y: number) => {
        const i = (y * width + x) * 4;
        return 0.2126 * (data[i] ?? 0) + 0.7152 * (data[i + 1] ?? 0) + 0.0722 * (data[i + 2] ?? 0);
      };
      /** The luminances of the pixels whose centres lie between r0 and r1 from (x0, y0). */
      const ring = (x0: number, y0: number, r0: number, r1: number) => {
        const values: number[] = [];
        for (let y = Math.floor(y0 - r1); y <= Math.ceil(y0 + r1); y++) {
          for (let x = Math.floor(x0 - r1); x <= Math.ceil(x0 + r1); x++) {
            const d = Math.hypot(x + 0.5 - x0, y + 0.5 - y0);
            if (x < 0 || y < 0 || x >= width || y >= height || d < r0 || d >= r1) continue;
            values.push(luma(x, y));
          }
        }
        return values;
      };
      const median = (values: number[]) => {
        const sorted = [...values].sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length / 2)] ?? 0;
      };
      return probes.map((p) => {
        if (p.kind === 'profile') {
          const out: number[] = [];
          for (let r = 0; r < p.max; r++) out.push(median(ring(p.x, p.y, r, r + 1)));
          return out;
        }
        const background = median(ring(p.x, p.y, p.r, p.r + 3));
        return [ring(p.x, p.y, 0, p.r).filter((v) => v > background + p.delta).length];
      });
    },
    { base64: png.toString('base64'), probes },
  );
}

/** The steepest fall of a radial profile over 2 px, between `from` and `to`. */
function steepest(profile: number[], from: number, to: number): number {
  let best = 0;
  for (let r = Math.floor(from); r + 2 <= Math.ceil(to); r++)
    best = Math.max(best, (profile[r] ?? 0) - (profile[r + 2] ?? 0));
  return best;
}

/** The 10-90% width of the falling outer edge of a radial profile, from its peak to `background`. */
function ramp(profile: number[], background: number): number {
  let peakAt = 0;
  profile.forEach((v, r) => {
    if (v > (profile[peakAt] ?? 0)) peakAt = r;
  });
  const span = (profile[peakAt] ?? 0) - background;
  const below = (share: number) => {
    let r = peakAt;
    while (r < profile.length && (profile[r] ?? 0) > background + share * span) r++;
    return r;
  };
  return below(0.1) - below(0.9);
}

/** The radius of the starter cell on screen. */
async function cellRadius(page: Page): Promise<number> {
  return page.evaluate(() => {
    const hook = window.__bs as BsHook;
    return (hook.state().player?.radius ?? 0) * hook.render.info().pxPerWu;
  });
}

/** Whether the whole of a circle lies on the screen, clear of the player's cell and of `others`. */
function clear(
  speck: { x: number; y: number },
  reach: number,
  screen: { width: number; height: number; cell: number },
  others: { x: number; y: number; reach: number }[],
): boolean {
  const { x, y } = speck;
  if (x < reach || y < reach || x > screen.width - reach || y > screen.height - reach) return false;
  if (Math.hypot(x - screen.width / 2, y - screen.height / 2) < screen.cell + reach + 10)
    return false;
  // The speck itself is among the others, at distance 0.
  return others.every(
    (o) => (o.x === x && o.y === y) || Math.hypot(o.x - x, o.y - y) > reach + o.reach,
  );
}

/** One frozen frame of `preset`, with or without the DOF: the picture, the specks and the counters. */
async function look(page: Page, preset: Preset, dof: boolean) {
  await play(page, preset, dof);
  const { width, height } = page.viewportSize() ?? { width: 960, height: 540 };
  return {
    info: await info(page),
    screen: { width, height, cell: await cellRadius(page) },
    mid: await specks(page, 'mid'),
    far: await specks(page, 'far'),
    near: await specks(page, 'near'),
    png: await shot(page),
  };
}
type Look = Awaited<ReturnType<typeof look>>;

/** The steepest fall in luminance across the rim of the player's cell, at the screen centre. */
async function cellEdge(page: Page, frame: Look): Promise<number> {
  const { width, height, cell } = frame.screen;
  const [profile = []] = await measure(page, frame.png, [
    { kind: 'profile', x: width / 2, y: height / 2, max: Math.ceil(cell * 1.5) },
  ]);
  return steepest(profile, cell * 0.6, cell * 1.4);
}

/** The pass list, the DOF in force and the targets it adds, within the preset's budget. */
function expectDof(preset: Preset, off: Look, on: Look): void {
  expect(off.info.passes).not.toContain('dof');
  expect(off.info.dof).toBe('none');
  expect(on.info.passes).toContain('dof');
  // Half strength on medium. The sprites draw their own blur: no target is added.
  expect(on.info.dof).toBe(preset === 'medium' ? 'half' : 'full');
  expect(on.info.targets).toBe(off.info.targets);
  expect(on.info.calls).toBeLessThanOrEqual(PRESETS[preset].budget.calls);
  expect(on.info.triangles).toBeLessThanOrEqual(PRESETS[preset].budget.triangles);
  expect(off.mid.every((s) => s.blur === 0)).toBe(true);
}

test('medium keeps the creature sharp, spreads off-plane specks into discs and softens far bokeh', async ({
  page,
}) => {
  const off = await look(page, 'medium', false);
  const on = await look(page, 'medium', true);
  expectDof('medium', off, on);

  const sharp = await cellEdge(page, off);
  const kept = await cellEdge(page, on);

  // A mid-layer speck well off the plane, with nothing else near it in either page.
  const reachOf = (s: Speck) => s.size / 2 + s.blur + 4;
  const isolated = (frame: Look, s: Speck, reach: number) =>
    clear(
      s,
      reach,
      frame.screen,
      frame.mid.map((o) => ({ x: o.x, y: o.y, reach: o.size / 2 + 6 })),
    );
  const candidates = on.mid
    .filter((s) => s.blur >= 3 && s.size >= 5)
    .map((s) => ({ on: s, off: off.mid.find((o) => o.index === s.index) }))
    .filter(
      (p): p is { on: Speck; off: Speck } =>
        !!p.off && isolated(on, p.on, reachOf(p.on)) && isolated(off, p.off, reachOf(p.on)),
    )
    // The most blurred, of the larger specks.
    .sort((a, b) => b.on.blur - a.on.blur);
  const cover = async (frame: Look, s: Speck, r: number) => {
    const [[count = 0] = []] = await measure(page, frame.png, [
      { kind: 'cover', x: s.x, y: s.y, r, delta: 3 },
    ]);
    return count;
  };
  // Nothing else lit sits behind the speck: its sharp disc fills its own area and not more (a
  // haze disc or a food item behind it would count as cover in both pages).
  let pick: { on: Speck; off: Speck } | undefined;
  for (const candidate of candidates) {
    const own = Math.PI * (candidate.off.size / 2 + 2) ** 2;
    const lit = await cover(off, candidate.off, reachOf(candidate.on));
    if (lit > 0 && lit <= own) {
      pick = candidate;
      break;
    }
  }
  expect(pick, 'an isolated mid-layer speck off the plane').toBeDefined();
  if (!pick) return;
  const r = reachOf(pick.on);
  const sharpCover = await cover(off, pick.off, r);
  const blurCover = await cover(on, pick.on, r);

  // A far-layer bokeh disc clear of the other far and near discs in both pages.
  const discs = (frame: Look) =>
    [...frame.far, ...frame.near].map((d) => ({ x: d.x, y: d.y, reach: d.size / 2 + d.blur + 4 }));
  const farCandidates = on.far
    .map((s) => ({ on: s, off: off.far.find((o) => o.index === s.index) }))
    .filter((p): p is { on: Speck; off: Speck } => {
      if (!p.off) return false;
      const reach = p.on.size / 2 + p.on.blur + 12;
      return (
        clear(p.on, reach, on.screen, discs(on)) && clear(p.off, reach, off.screen, discs(off))
      );
    })
    .sort((a, b) => b.on.size - a.on.size);
  const profileOf = async (frame: Look, s: Speck, max: number) => {
    const [profile = []] = await measure(page, frame.png, [
      { kind: 'profile', x: s.x, y: s.y, max },
    ]);
    return profile;
  };
  // A disc on plain water: the profile ends flat and the disc stands out of it, so no haze or
  // food behind the disc shapes the edge that is measured.
  const plain = (profile: number[]): boolean => {
    const tail = profile.slice(-6);
    const level = tail.reduce((a, b) => a + b, 0) / tail.length;
    return Math.max(...tail) - Math.min(...tail) <= 2 && Math.max(...profile) - level >= 4;
  };
  let far: { on: Speck; off: Speck } | undefined;
  let max = 0;
  for (const candidate of farCandidates) {
    max = Math.ceil(candidate.on.size / 2 + candidate.on.blur + 12);
    if (
      plain(await profileOf(off, candidate.off, max)) &&
      plain(await profileOf(on, candidate.on, max))
    ) {
      far = candidate;
      break;
    }
  }
  expect(far, 'a far-layer disc on plain water, clear of the others').toBeDefined();
  if (!far) return;
  const edge = async (frame: Look, s: Speck) => {
    const profile = await profileOf(frame, s, max);
    const background = profile.slice(-3).reduce((a, b) => a + b, 0) / 3;
    return ramp(profile, background);
  };
  const sharpEdge = await edge(off, far.off);
  const softEdge = await edge(on, far.on);

  expect(sharp).toBeGreaterThan(20);
  expect(Math.abs(kept - sharp)).toBeLessThanOrEqual(0.1 * sharp);
  expect(sharpCover).toBeGreaterThan(0);
  expect(blurCover).toBeGreaterThanOrEqual(3 * sharpCover);
  expect(softEdge).toBeGreaterThan(sharpEdge);
});

test('high runs a full-strength depth of field and keeps the creature sharp @slow', async ({
  page,
}) => {
  const off = await look(page, 'high', false);
  const on = await look(page, 'high', true);
  expectDof('high', off, on);
  const sharp = await cellEdge(page, off);
  const kept = await cellEdge(page, on);
  expect(sharp).toBeGreaterThan(20);
  expect(Math.abs(kept - sharp)).toBeLessThanOrEqual(0.1 * sharp);
  expect(on.mid.some((s) => s.blur > 0)).toBe(true);
});

test('low draws its fake bokeh with no depth-of-field pass', async ({ page }) => {
  await openGame(page, '?debug=1&seed=dof&quality=low');
  await hatch(page);
  await waitForFrames(page);
  const low = await info(page);
  expect(low.passes).toEqual([]);
  expect(low.dof).toBe('none');
  expect(low.targets).toBe(0);
  const far = await specks(page, 'far');
  expect(far.length).toBeGreaterThan(0);
  expect(far.every((s) => s.blur === 0)).toBe(true);
});
