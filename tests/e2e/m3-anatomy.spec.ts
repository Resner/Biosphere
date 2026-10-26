import { expect, type Page, test } from '@playwright/test';
import type { BsHook, BsState } from '../../src/game/debug';
import { genomeToBase64url } from '../../src/genome/codec';
import { currentAt } from '../../src/sim/currents';
import { RULES, TICK_HZ } from '../../src/sim/rules';
import { createWorld } from '../../src/sim/world';
import { ARCHETYPES, buildGenome } from '../archetypes';
import { hatch, openGame, playerOf, state } from './helpers';

// The game hatches a body (M3 T15): the player's genome decides how it swims, grows and feeds.

const SEED = 'anatomy';

async function play(page: Page, genome: string): Promise<void> {
  await openGame(page, `?debug=1&seed=${SEED}&genome=${genome}`);
  await hatch(page);
}

type PlayerState = NonNullable<BsState['player']>;

/** The speed the stats predict at `seconds` after a start from rest at full throttle. */
function predictedSpeed(stats: PlayerState['stats'], seconds: number): number {
  const m = RULES.movement;
  const k = m.drag * stats.drag;
  return ((m.thrust * stats.thrust) / k) * (1 - Math.exp(-k * seconds));
}

/** Swims east at full throttle for 4 s from rest; the speed over the last second, minus the current. */
async function measureSpeed(page: Page): Promise<{ measured: number; predicted: number }> {
  await page.evaluate(() => {
    const bs = window.__bs as BsHook;
    const { y } = bs.state().player as PlayerState;
    bs.debug?.teleport(2000, y);
    void bs.debug?.steerTo({ x: 6000, y });
  });
  const first = await state(page);
  await page.waitForFunction((t) => (window.__bs as BsHook).state().tick >= t + 90, first.tick);
  const a = await state(page);
  await page.waitForFunction((t) => (window.__bs as BsHook).state().tick >= t + 30, a.tick);
  const b = await state(page);
  const dt = (b.tick - a.tick) / TICK_HZ;
  const pa = a.player as PlayerState;
  const pb = b.player as PlayerState;
  const world = createWorld({ seed: SEED });
  world.tick = Math.round((a.tick + b.tick) / 2);
  const current = currentAt(world, (pa.x + pb.x) / 2, (pa.y + pb.y) / 2);
  const measured = Math.hypot((pb.x - pa.x) / dt - current.x, (pb.y - pa.y) / dt - current.y);
  const seconds = ((a.tick + b.tick) / 2 - first.tick) / TICK_HZ;
  return { measured, predicted: predictedSpeed(pb.stats, seconds) };
}

test.describe('anatomy changes play', () => {
  test('the debug state names the body', async ({ page }) => {
    await play(page, genomeToBase64url(ARCHETYPES.flagellate as never));
    const player = await playerOf(page);
    expect(player.genomeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(player.species).toMatch(/^[A-Z][a-z]+ [a-z]+$/);
    expect(['common', 'uncommon', 'rare', 'exotic']).toContain(player.rarity);
    expect(player.tier).toBeGreaterThanOrEqual(0);
    expect(player.stats.colliders.length).toBeGreaterThanOrEqual(1);
    await expect(page.getByTestId('hud-species')).toContainText(player.species);
  });

  test('swimming speed follows the stats, and bodies differ', async ({ page }) => {
    const speeds: Record<string, number> = {};
    for (const name of ['flagellate', 'armoured']) {
      await play(page, genomeToBase64url(ARCHETYPES[name] as never));
      const { measured, predicted } = await measureSpeed(page);
      expect(
        Math.abs(measured / predicted - 1),
        `${name}: ${measured} vs ${predicted}`,
      ).toBeLessThan(0.15);
      speeds[name] = measured;
    }
    const [fast, slow] = [speeds.flagellate as number, speeds.armoured as number].sort(
      (x, y) => y - x,
    ) as [number, number];
    expect(fast / slow).toBeGreaterThanOrEqual(1.2);
  });

  test('growth stops at the genome maximum', async ({ page }) => {
    // The smallest body the genes can make: base 300.
    const small = buildGenome({}, { size1: 0, size2: 0, size3: 0 });
    await play(page, genomeToBase64url(small));
    expect((await playerOf(page)).stats.maxBiomass).toBe(300);
    await page.evaluate(() => {
      const bs = window.__bs as BsHook;
      bs.debug?.setBiomass(290);
      bs.debug?.timeScale(8);
    });
    let top = 0;
    // About 24 s of sim at 8x, topping the energy up so that growth never waits for food.
    for (let i = 0; i < 12; i++) {
      await page.evaluate(() => (window.__bs as BsHook).debug?.setEnergy(1e9));
      await page.waitForTimeout(250);
      top = Math.max(top, (await playerOf(page)).biomass);
    }
    expect(top).toBeGreaterThan(299);
    expect(top).toBeLessThanOrEqual(300);
  });

  test('a filter mouth eats detritus and ignores crystal', async ({ page }) => {
    const filter = buildGenome({}, { mouthSize: 255, mouthType: 0, digestion: 255 });
    await play(page, genomeToBase64url(filter));
    const sitOn = async (kind: 'detritus' | 'crystal'): Promise<string> => {
      // Look for the kind around the world's middle, then sit right on it.
      const id = await page.evaluate(async (wanted) => {
        const bs = window.__bs as BsHook;
        const middle = (bs.state().player as PlayerState).x;
        for (let step = 0; step < 40; step++) {
          bs.debug?.teleport(middle + step * 120, middle);
          const before = bs.state().tick;
          while (bs.state().tick < before + 2) await new Promise((r) => setTimeout(r, 10));
          const item = bs.debug?.nearestFood(wanted);
          if (item) {
            bs.debug?.teleport(item.x, item.y);
            return item.id;
          }
        }
        throw new Error(`no ${wanted} found`);
      }, kind);
      const { tick } = await state(page);
      await page.waitForFunction((t) => (window.__bs as BsHook).state().tick >= t + 45, tick);
      return id;
    };
    const has = (id: string) => page.evaluate((i) => window.__bs?.debug?.hasFood(i), id);
    expect(await has(await sitOn('crystal'))).toBe(true);
    expect(await has(await sitOn('detritus'))).toBe(false);
  });
});

test.describe('hatching', () => {
  test('each hatch is a new genesis body, drawn as a mesh, named on the HUD and the death screen', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('./?debug=1&seed=rehatch');
    await page.waitForFunction(() => window.__bs?.ready === true);
    await hatch(page);
    const first = await playerOf(page);
    await page.waitForFunction(() => (window.__bs as BsHook).render.info().playerBody);
    await expect(page.getByTestId('hud-species')).toContainText(first.species);
    await expect(page.getByTestId('hud-species')).toContainText(first.rarity);

    await page.evaluate(() => (window.__bs as BsHook).debug?.setEnergy(0));
    await page.waitForFunction(() => window.__bs?.state().screen === 'dead', null, {
      timeout: 20_000,
    });
    await expect(page.getByTestId('death-species')).toContainText(first.species);

    await page.getByTestId('hatch-again').click();
    await page.waitForFunction(() => window.__bs?.state().screen === 'playing');
    expect((await playerOf(page)).genomeHash).not.toBe(first.genomeHash);
    expect(errors).toEqual([]);
  });

  test('an invalid ?genome= falls back to genesis and warns once', async ({ page }) => {
    const warnings: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'warning') warnings.push(message.text());
    });
    await page.goto('./?debug=1&genome=nonsense');
    await page.waitForFunction(() => window.__bs?.ready === true);
    await hatch(page);
    const first = await playerOf(page);
    expect(first.genomeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(warnings.filter((w) => w.includes('?genome='))).toHaveLength(1);
  });
});
