import { readdirSync, readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { openGame } from './helpers';

// Fights are the same floating-point operations in every engine: each encounter golden (recorded by
// Node, `src/sim/__golden__/encounter-*.json`) replays to its pinned hash in Chromium (M7 T10).

interface Golden {
  log: unknown;
  hash: string;
  results: unknown;
}

const DIR = new URL('../../src/sim/__golden__/', import.meta.url);

test('the encounter goldens replay to their pinned hashes in Chromium', async ({ page }) => {
  const names = readdirSync(DIR).filter((n) => /^encounter-.*\.json$/.test(n));
  expect(names.length).toBeGreaterThanOrEqual(6);
  const goldens = names.map((n) => JSON.parse(readFileSync(new URL(n, DIR), 'utf8')) as Golden);

  await openGame(page, '?seed=m7-determinism');
  const replayed = await page.evaluate(
    (logs) => logs.map((log) => window.__bs?.replayEncounter(log as never) ?? null),
    goldens.map((g) => g.log),
  );
  expect(replayed).toEqual(goldens.map(({ hash, results }) => ({ hash, results })));
});
