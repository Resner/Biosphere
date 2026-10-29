// The budget report (M6 T26): `npm run report:budget` builds the site, serves `dist/`, stages the
// budget scenes (`budget-scene.mjs`: an empty pond, a crowded one in the shallows, the crowd in the
// abyss) on every preset in the shared Chromium, writes `docs/perf/budget.md` and saves a screenshot
// of each to `test-results/budget/` (not committed). `--no-build` uses the `dist/` already there.
// Exits 1 when a preset breaks a budget.
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { build, createServer, preview } from 'vite';
import {
  BUDGET_SCENES,
  BUDGET_VIEWPORT,
  budgetCast,
  openBudgetGame,
  stageScene,
} from './budget-scene.mjs';
import { chromiumPath } from './gallery-capture.mjs';

const args = process.argv.slice(2);
for (const arg of args) if (arg !== '--no-build') throw new Error(`unknown argument ${arg}`);
if (!args.includes('--no-build')) await build({ logLevel: 'warn' });

// The report's text comes from TypeScript that imports without extensions, so Vite loads it.
const vite = await createServer({
  configFile: false,
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true, include: [] },
});
const server = await preview({ logLevel: 'error', preview: { port: 0, open: false } });
const executablePath = chromiumPath(chromium.executablePath());
const browser = await chromium.launch(executablePath ? { executablePath } : {});
try {
  const { budgetReport, overBudget } = await vite.ssrLoadModule('/tools/budget-table.ts');
  const { PRESET_NAMES } = await vite.ssrLoadModule('/src/render/presets.ts');
  const { port } = server.httpServer.address();
  const base = `http://localhost:${port}/`;
  const { player, crowd } = budgetCast();
  const shots = new URL('../test-results/budget/', import.meta.url);
  await mkdir(shots, { recursive: true });
  // One page per preset, side by side: software GL takes about a second a frame at 1920×1080.
  const perPreset = await Promise.all(
    PRESET_NAMES.map(async (preset) => {
      const context = await browser.newContext({ viewport: BUDGET_VIEWPORT, deviceScaleFactor: 1 });
      try {
        const page = await context.newPage();
        await openBudgetGame(page, base, preset, player);
        const rows = [];
        for (const scene of BUDGET_SCENES) {
          const info = await stageScene(page, scene, crowd);
          await page.screenshot({ path: new URL(`${preset}-${scene}.png`, shots).pathname });
          rows.push({
            preset,
            scene,
            calls: info.calls,
            triangles: info.triangles,
            targets: info.targets,
            targetBytes: info.targetBytes,
            passes: info.passes,
            bodies: info.remoteBodies + (info.playerBody ? 1 : 0),
          });
          process.stdout.write(`${preset} ${scene}: ${info.calls} calls, ${info.triangles} triangles\n`);
        }
        return rows;
      } finally {
        await context.close();
      }
    }),
  );
  const rows = perPreset.flat();
  const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();
  const meta = {
    date: new Date().toISOString().slice(0, 10),
    commit: git('rev-parse', '--short', 'HEAD'),
    browser: `Chromium ${browser.version()}`,
  };
  const dir = new URL('../docs/perf/', import.meta.url);
  await mkdir(dir, { recursive: true });
  const out = new URL('budget.md', dir);
  await writeFile(out, budgetReport(rows, meta));
  process.stdout.write(`budget: ${out.pathname}, screenshots in ${shots.pathname}\n`);
  if (overBudget(rows).length > 0) process.exitCode = 1;
} finally {
  await browser.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
  await vite.close();
}
