// The budget scenes (M6 T26), shared by `npm run report:budget` and `m6-budget.spec.ts` so the test
// checks the report's own path: the game at a 1920×1080 drawing buffer on one preset, the player
// pinned, and an empty pond, a crowded one in the shallows or a crowded one in the abyss.
import { readdirSync, readFileSync } from 'node:fs';

/** CSS pixels at a pixel ratio of 1: the drawing buffer the memory budgets are set for. */
export const BUDGET_VIEWPORT = { width: 1920, height: 1080 };
export const BUDGET_SCENES = ['empty', 'crowded', 'abyss'];
/** A pond holds 24 players: the crowded scenes draw 24 others beside the player. */
export const CROWD = 24;
/** The player's biomass: tier 1, so the crowd holds smaller, comparable and bigger bodies. */
const PLAYER_BIOMASS = 1_200;
/** Software GL builds 24 bodies and draws the high preset slowly. */
const TIMEOUT = 120_000;

/** The gallery specimens (`tests/fixtures/gallery/*.hex`) as base64url genome text, in file order. */
export function galleryGenomes() {
  const dir = new URL('../tests/fixtures/gallery/', import.meta.url);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.hex'))
    .sort()
    .map((f) => {
      const hex = readFileSync(new URL(f, dir), 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'))
        .join('');
      return Buffer.from(hex, 'hex').toString('base64url');
    });
}

/** The crowd: the last 24 specimens (every v2 silhouette and rarity tier), the player the one before. */
export function budgetCast(genomes = galleryGenomes()) {
  if (genomes.length < CROWD + 1) throw new Error('the gallery needs 25 specimens');
  return { player: genomes[genomes.length - CROWD - 1], crowd: genomes.slice(-CROWD) };
}

/** Waits until the canvas has drawn `count` more frames, for up to `timeout` ms. */
export async function frames(page, count = 3, timeout = TIMEOUT) {
  const now = Number(await page.locator('#scene').getAttribute('data-frames'));
  await page.waitForFunction(
    (target) => Number(document.querySelector('#scene')?.getAttribute('data-frames')) >= target,
    now + count,
    { timeout },
  );
}

/**
 * Opens the game on `preset` with the player's body pinned, hatches it and freezes the world (UV
 * and pressure would hurt it; the shaders' clock holds too, the frames keep drawing).
 */
export async function openBudgetGame(page, baseURL, preset, player) {
  await page.goto(new URL(`./?debug=1&seed=budget&quality=${preset}&genome=${player}`, baseURL).href);
  await page.waitForFunction(() => window.__bs?.ready === true, null, { timeout: TIMEOUT });
  await page.getByRole('button', { name: 'Hatch', exact: true }).click();
  await page.waitForFunction(() => window.__bs?.state().screen === 'playing', null, {
    timeout: TIMEOUT,
  });
  await page.mouse.move(BUDGET_VIEWPORT.width / 2, BUDGET_VIEWPORT.height / 2);
  // The hatch draws the egg and its rings (extra calls) until they are gone: measure after.
  await page.waitForFunction(
    () => {
      const { render } = window.__bs;
      const info = render.info();
      return info.playerBody && info.eggs === 0 && render.fx().rings === 0;
    },
    null,
    { timeout: TIMEOUT },
  );
  await page.evaluate((biomass) => {
    const { debug } = window.__bs;
    debug.timeScale(0);
    debug.setBiomass(biomass);
  }, PLAYER_BIOMASS);
}

/**
 * Stages `scene` (`empty`: the twilight spawn alone; `crowded`: the shallows' caustics and god rays
 * with 24 bodies, a plume, carried eggs and size outlines; `abyss`: the same crowd in the dark, where
 * luminescent bodies light pools and vent crystals glow) and returns `render.info()` once it is drawn.
 */
export async function stageScene(page, scene, crowd) {
  const zone = scene === 'empty' ? 'twilight' : scene === 'crowded' ? 'shallows' : 'abyss';
  const remotes = scene === 'empty' ? [] : crowd;
  await page.evaluate(
    ({ zone, remotes, viewport }) => {
      const { debug, render } = window.__bs;
      const at = debug.setZone(zone);
      if (zone === 'shallows') debug.spawnPlume(at.x + 120, at.y - 80, 80);
      const { pxPerWu } = render.info();
      // A 6 × 4 grid over the view, clear of the player in the centre.
      debug.setRemotes(
        remotes.map((genome, i) => ({
          id: `crowd${i}`,
          name: `C${i}`,
          genome,
          // Smaller (tier 0), comparable and bigger (tier 2) bodies, so both outlines draw.
          biomass: i % 6 === 5 ? 17_000 : i % 3 === 0 ? 120 : 1_500,
          x: at.x + (((i % 6) - 2.5) * 0.16 * viewport.width) / pxPerWu,
          y: at.y + ((Math.floor(i / 6) - 1.5) * 0.23 * viewport.height) / pxPerWu,
          egg: i % 4 === 1,
          ready: i % 2 === 0,
        })),
      );
    },
    { zone, remotes, viewport: BUDGET_VIEWPORT },
  );
  await page.waitForFunction(
    (n) => {
      const { state, render } = window.__bs;
      return (
        render.info().remoteBodies === n && state().remotes.every((remote) => remote.alpha === 1)
      );
    },
    remotes.length,
    { timeout: TIMEOUT },
  );
  await frames(page);
  return page.evaluate(() => window.__bs.render.info());
}
