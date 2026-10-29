import { expect, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { PRESET_NAMES, PRESETS } from '../../src/render/presets';
import {
  BUDGET_VIEWPORT,
  budgetCast,
  CROWD,
  frames,
  openBudgetGame,
  stageScene,
} from '../../tools/budget-scene.mjs';

// Budgets (M6 T26): every preset keeps its draw calls, triangles and render-target memory within
// DESIGN §12 in a crowded pond with every zone effect on, low falls back to no post target at all,
// and a long crowded run leaves the JS heap and the GPU resources where they were. CI renders in
// software, so this judges budgets, never frame rates. `npm run report:budget` stages the same
// scenes (`tools/budget-scene.mjs`) for `docs/perf/budget.md`.

const { player, crowd } = budgetCast();

test.describe('budgets', () => {
  // The suite default is the low preset (playwright.config.ts); each test picks its own. A
  // 1920×1080 viewport at a pixel ratio of 1 is the drawing buffer the memory budgets are set for.
  test.use({
    storageState: { cookies: [], origins: [] },
    viewport: BUDGET_VIEWPORT,
    deviceScaleFactor: 1,
  });

  for (const preset of PRESET_NAMES) {
    test(`${preset} stays within its budgets with 24 bodies in the shallows and the abyss @slow`, async ({
      page,
      baseURL,
    }) => {
      // Software GL draws a 1920×1080 frame of 25 bodies in about a second.
      test.setTimeout(300_000);
      const budget = PRESETS[preset].budget;
      await openBudgetGame(page, baseURL as string, preset, player);
      const canvas = await page.evaluate(() => {
        const el = document.querySelector('#scene') as HTMLCanvasElement;
        return { width: el.width, height: el.height };
      });
      expect(canvas).toEqual(BUDGET_VIEWPORT);

      for (const scene of ['crowded', 'abyss'] as const) {
        const info = await stageScene(page, scene, crowd);
        const label = `${preset} ${scene}`;
        console.log(
          `${label}: ${info.calls} calls, ${info.triangles} triangles, ${info.targets} targets, ` +
            `${(info.targetBytes / 1e6).toFixed(1)} MB`,
        );
        expect(info.remoteBodies, label).toBe(CROWD);
        expect(info.playerBody, label).toBe(true);
        expect(info.calls, label).toBeLessThanOrEqual(budget.calls);
        expect(info.triangles, label).toBeLessThanOrEqual(budget.triangles);
        expect(info.targetBytes, label).toBeLessThanOrEqual(budget.targetBytes);
        // Every effect is on: carried eggs, both size outlines, and the zone's light.
        expect(info.eggs, label).toBeGreaterThanOrEqual(CROWD / 4);
        expect(info.outlines.bigger, label).toBeGreaterThan(0);
        expect(info.outlines.smaller, label).toBeGreaterThan(0);
        expect(info.particles, label).toBeGreaterThan(0);
        if (scene === 'crowded') {
          expect(info.caustic, label).toBeGreaterThan(0.5);
          if (preset !== 'low') expect(info.rays, label).toBeGreaterThan(0.5);
        } else {
          expect(info.caustic, label).toBe(0);
          expect(info.rays, label).toBe(0);
        }
        if (preset === 'low') {
          // Low falls back everywhere: no pass and no target, no god rays, plain sprites for bokeh,
          // plain translucency for the glass.
          expect(info.passes, label).toEqual([]);
          expect(info.targets, label).toBe(0);
          expect(info.targetBytes, label).toBe(0);
          expect(info.dof, label).toBe('none');
          expect(info.rays, label).toBe(0);
        } else {
          expect(info.passes, label).toEqual(
            expect.arrayContaining(['refraction', 'dof', 'bloom']),
          );
          expect(info.targets, label).toBeGreaterThan(0);
        }
      }
    });
  }
});

test.describe('allocations', () => {
  // The frame loop at medium (the post chain on) in a small window: software GL draws it at
  // about 15 frames a second alone, so 1,200 frames take a minute and a half, or several beside
  // the budget tests.
  test.use({
    storageState: { cookies: [], origins: [] },
    viewport: { width: 640, height: 400 },
    deviceScaleFactor: 1,
  });

  test('1,200 frames of a crowded pond keep the JS heap and the GPU resources level @slow', async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(600_000);
    await openBudgetGame(page, baseURL as string, 'medium', player);
    await stageScene(page, 'crowded', crowd);
    // A forced, full garbage collection through the DevTools protocol (`--expose-gc` without a
    // relaunch), then the live heap.
    const cdp = await page.context().newCDPSession(page);
    const heap = async (): Promise<number> => {
      for (let i = 0; i < 2; i++) await cdp.send('HeapProfiler.collectGarbage');
      return (await cdp.send('Runtime.getHeapUsage')).usedSize;
    };
    const memory = () =>
      page.evaluate(() => {
        const info = (window.__bs as BsHook).render.info();
        return { ...info.memory, targets: info.targets, bodies: info.remoteBodies };
      });

    // Warm up: shaders compile, caches fill and the JIT settles before the baseline.
    await frames(page, 120);
    const before = { heap: await heap(), memory: await memory() };
    await frames(page, 1_200, 480_000);
    const after = { heap: await heap(), memory: await memory() };
    const growth = after.heap - before.heap;
    console.log(
      `1,200 frames: heap ${(before.heap / 1e6).toFixed(2)} → ${(after.heap / 1e6).toFixed(2)} MB ` +
        `(${(growth / 1e3).toFixed(0)} kB), ${JSON.stringify(after.memory)}`,
    );
    expect(growth).toBeLessThan(1_000_000);
    expect(after.memory).toEqual(before.memory);
    expect(after.memory.bodies).toBe(CROWD);
  });
});
