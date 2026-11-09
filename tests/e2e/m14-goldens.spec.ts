import { expect, test } from '@playwright/test';
import { SETS } from '../goldens-catalogue';
import { openGame } from './helpers';

// Every golden file is recomputed in the page's own bundle (M14 T5): each set of
// `tests/goldens-catalogue.ts` is run by `window.__bs.goldens.run` and compared, in Node, with what
// the golden pins. The unit tests pin the same files in Node, so a set that differs here is an
// engine difference, a determinism bug at its cause (`src/sim/math.ts` is the usual place).

test('every golden set is recomputed in the page and equals its file', async ({ page }) => {
  await openGame(page, '?seed=m14-goldens');

  const names = await page.evaluate(() => window.__bs?.goldens.sets() ?? []);
  expect([...names].sort(), 'the page and the catalogue name the same sets').toEqual(
    SETS.map((s) => s.name).sort(),
  );

  for (const set of SETS) {
    const output = await page.evaluate(
      ([name, input]) => window.__bs?.goldens.run(name as string, input),
      [set.name, set.input()],
    );
    expect.soft(output, `golden set ${set.name} (${set.files.join(', ')})`).toEqual(set.expected());
  }
});
