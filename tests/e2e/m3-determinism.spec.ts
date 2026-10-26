import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { openGame } from './helpers';

// Development and stats are the same floating-point operations in every engine: the 20 golden
// genomes (recorded by Node, `src/genome/__golden__/stats.json`) hash identically in Chromium.

interface Golden {
  vectors: Record<string, { genome: string; planHash: string; statsHash: string }>;
}

test('the golden genomes develop and measure identically in Chromium', async ({ page }) => {
  const golden = JSON.parse(
    readFileSync(new URL('../../src/genome/__golden__/stats.json', import.meta.url), 'utf8'),
  ) as Golden;
  const vectors = Object.values(golden.vectors);
  expect(vectors).toHaveLength(20);

  await openGame(page, '?debug=1&seed=m3-determinism');
  const hashes = await page.evaluate(
    (list) => window.__bs?.genome?.hashes(list) ?? [],
    vectors.map((v) => v.genome),
  );
  expect(hashes).toEqual(vectors.map(({ planHash, statsHash }) => ({ planHash, statsHash })));
});
