import { expect, type Page, test } from '@playwright/test';
import { type Genome, genomeHash, parseGenomeText } from '../../src/genome/codec';
import { breedBatch, labRandomness } from '../../src/lab/breed';
import { cellRect, GRID_COUNT } from '../../src/lab/grid';
import { labGenomes } from '../../src/lab/specimens';
import { lab, measureCells, openLab, range, SEED, stage } from './lab-helpers';

// The Creature Lab tools (M3 T14): mutate and undo, breed two creatures into eight children and
// see where each trait came from, and copy a genome out and load it back in.

/** Clicks the middle of a cell, with shift for the second parent. */
async function clickCell(page: Page, index: number, shift = false): Promise<void> {
  const box = await stage(page).boundingBox();
  if (!box) throw new Error('no stage');
  const r = cellRect(index, box.width, box.height);
  await stage(page).click({
    position: { x: r.x + r.w / 2, y: r.y + r.h / 2 },
    modifiers: shift ? ['Shift'] : [],
  });
}

const hashes = (page: Page) => lab(page, (l) => l.state().creatures.map((c) => c.hash));

test('Mutate steps the selected creature to a new valid body, and Undo takes it back', async ({
  page,
}) => {
  await openLab(page);
  await expect(page.getByTestId('tool-mutate')).toBeDisabled();
  await expect(page.getByTestId('tool-undo')).toBeDisabled();
  await clickCell(page, 5);
  const before = await hashes(page);

  await page.getByTestId('tool-mutate').click();
  const mutated = await lab(page, (l) => l.state());
  expect(mutated.creatures[5]?.hash).not.toBe(before[5]);
  expect(mutated.creatures[5]?.valid).toBe(true);
  // Only the selected cell changed, and the inspector shows the new creature.
  expect(mutated.creatures.filter((_, i) => i !== 5).map((c) => c.hash)).toEqual(
    before.filter((_, i) => i !== 5),
  );
  expect(mutated.selected).toBe(5);
  await expect(page.getByTestId('inspect-name')).toHaveText(mutated.creatures[5]?.species ?? '');

  await page.getByTestId('tool-mutate').click();
  expect((await hashes(page))[5]).not.toBe(mutated.creatures[5]?.hash);

  await page.getByTestId('tool-undo').click();
  expect((await hashes(page))[5]).toBe(mutated.creatures[5]?.hash);
  await page.getByTestId('tool-undo').click();
  expect(await hashes(page)).toEqual(before);
  await expect(page.getByTestId('tool-undo')).toBeDisabled();
});

test('Breed shows eight valid children of the two selected creatures', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(m.text());
  });
  page.on('pageerror', (e) => problems.push(e.message));
  await openLab(page);
  await expect(page.getByTestId('tool-breed')).toBeDisabled();
  await clickCell(page, 2);
  await expect(page.getByTestId('tool-breed')).toBeDisabled();
  await clickCell(page, 7, true);
  await expect(page.getByTestId('tool-breed')).toBeEnabled();
  expect((await lab(page, (l) => l.state())).parents).toEqual([2, 7]);

  await page.getByTestId('tool-breed').click();
  const state = await lab(page, (l) => l.state());
  expect(state.offspring).toHaveLength(8);
  expect(state.offspring.every((c) => c.valid && c.hash && c.species)).toBe(true);
  const parents = [state.creatures[2]?.hash, state.creatures[7]?.hash];
  const kids = state.offspring.map((c) => c.hash);
  expect(new Set(kids).size).toBeGreaterThanOrEqual(6);
  expect(kids.some((h) => parents.includes(h))).toBe(false);

  // The page agrees with the pure batch function the unit tests cover.
  const set = labGenomes(SEED, 'genesis');
  const expected = breedBatch(set[2] as Genome, set[7] as Genome, labRandomness(SEED)).map((g) =>
    genomeHash(g),
  );
  expect(kids).toEqual(expected);

  // The same selection and seed give the same eight again.
  await page.getByTestId('tool-breed').click();
  expect((await lab(page, (l) => l.state())).offspring.map((c) => c.hash)).toEqual(kids);

  // The nine drawn creatures stay within the render budget and every child is visible.
  const info = await lab(page, (l) => l.renderInfo());
  expect(info.calls).toBeLessThanOrEqual(40);
  expect(info.triangles).toBeLessThan(150_000);
  expect(info.programs).toBe(1);
  const stats = await measureCells(
    page,
    range(8).map((k) => GRID_COUNT + k),
  );
  expect(stats.every((s) => s.lit > 50)).toBe(true);

  // Inspecting a child says where each simple trait came from.
  await expect(page.getByTestId('inspect-inherit')).toBeHidden();
  await clickCell(page, GRID_COUNT + 3);
  await expect(page.getByTestId('inspect-name')).toHaveText(state.offspring[3]?.species ?? '');
  const lines = page.getByTestId('inspect-inherit-lines').locator('li');
  await expect(lines).toHaveCount(6);
  const text = (await lines.allTextContents()).join('\n');
  expect(text).toMatch(/\((from (both parents|parent [AB]|neither)|a mix of both parents|new,)/);
  expect(text).not.toMatch(/allele|locus|gene|haplotype/i);
  // Inspecting a child keeps the parents, so Breed still works.
  expect((await lab(page, (l) => l.state())).parents).toEqual([2, 7]);
  expect(problems).toEqual([]);
});

test('a genome copied out loads back in with the same hash; garbage changes nothing', async ({
  page,
}) => {
  await openLab(page);
  const before = await hashes(page);
  await expect(page.getByTestId('tool-copy')).toBeDisabled();

  await clickCell(page, 4);
  await page.getByTestId('tool-copy').click();
  const text = await page.getByTestId('genome-copy').inputValue();
  expect(parseGenomeText(text)).not.toBeNull();
  expect(genomeHash(parseGenomeText(text) as Genome)).toBe(
    genomeHash(labGenomes(SEED, 'genesis')[4] as Genome),
  );

  await clickCell(page, 9);
  await page.getByTestId('genome-load').fill(text);
  await page.getByTestId('tool-load').click();
  await expect(page.getByTestId('lab-error')).toBeHidden();
  const after = await hashes(page);
  expect(after[9]).toBe(before[4]);
  expect(after.filter((_, i) => i !== 9)).toEqual(before.filter((_, i) => i !== 9));

  // Garbage shows an error line and changes nothing.
  await page.getByTestId('genome-load').fill('definitely not a genome');
  await page.getByTestId('tool-load').click();
  await expect(page.getByTestId('lab-error')).toBeVisible();
  expect(await hashes(page)).toEqual(after);

  // Undo puts the loaded cell back as it was.
  await page.getByTestId('tool-undo').click();
  expect(await hashes(page)).toEqual(before);
});
