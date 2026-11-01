import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import {
  clickHatch,
  goTo,
  M5_PROMOTE_HUB,
  openRecorded,
  ripe,
  state,
  topUp,
  waitPlaying,
} from './helpers';

// The offspring (M5 T11): after a mating both players get an egg and then a card with a different
// child; A becomes theirs with H, starves it, and is offered the parent, who comes back with the
// life it had when it was frozen.

test.describe.configure({ mode: 'serial' });

async function hatched(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await openRecorded(page, '', M5_PROMOTE_HUB);
  await clickHatch(page);
  await waitPlaying(page);
  return page;
}

const BANNED = /commit|ledger|checkpoint|nonce|beacon|allele|locus|genotype|hash/i;

test('a mating gives each player an egg, a card and a choice that brings the parent back @slow', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const [a, b] = await Promise.all([hatched(ctxA), hatched(ctxB)]);
  await Promise.all([ripe(a), ripe(b)]);
  const idB = (await state(b)).playerId as string;
  await goTo(a, idB);
  await expect(a.getByTestId('mate-hint')).toHaveText(/^E: court /);
  await Promise.all([topUp(a), topUp(b)]);
  const parentA = (await state(a)).life.creature;
  // The first press may land before the hub has answered the check; repeats are ignored.
  await a.keyboard.press('e');
  await a.keyboard.press('e');
  // A loaded runner can take seconds to carry the court through the hub; say what each side saw if it never comes.
  await expect(b.getByTestId('invite'), "the hub carries A's court to B as an invitation")
    .toBeVisible({
      timeout: 20_000,
    })
    .catch(async (error) => {
      const [ma, mb] = (await Promise.all([state(a), state(b)])).map((s) => s.mate);
      throw new Error(`no invitation. A: ${JSON.stringify(ma)} B: ${JSON.stringify(mb)}`, {
        cause: error,
      });
    });
  await b.keyboard.press('e');

  // The round arrives: an egg, then the card, on both sides, with different children.
  for (const page of [a, b]) {
    await page.waitForFunction(
      () => ['egg', 'card'].includes(window.__bs?.state().offspring.kind ?? ''),
      undefined,
      { timeout: 40_000 },
    );
  }
  // The egg is drawn in the scene (M6 T20), beside the parent.
  expect((await state(a)).offspring.eggShown).toBe(true);
  await a.screenshot({ path: 'test-results/m5-promote-egg.png' });
  for (const page of [a, b]) {
    await expect(page.getByTestId('offspring')).toBeVisible({ timeout: 10_000 });
    const text = await page.getByTestId('offspring').textContent();
    expect(text).not.toMatch(BANNED);
    await expect(page.getByTestId('offspring-line')).toContainText('generation 1');
  }
  const [childA, childB] = [(await state(a)).offspring, (await state(b)).offspring];
  expect(childA.genomeHash).not.toBe(childB.genomeHash);
  expect(childA.creature).not.toBe(childB.creature);
  await a.screenshot({ path: 'test-results/m5-promote-card.png' });

  // A becomes the child; the parent is frozen where it was.
  const frozenAt = (await state(a)).life.activeMs;
  await a.keyboard.press('h');
  await a.waitForFunction(
    (child) => window.__bs?.state().life.creature === child,
    childA.creature,
    { timeout: 20_000 },
  );
  const now = await state(a);
  expect(now.player?.genomeHash).toBe(childA.genomeHash);
  expect(now.offspring.kind).toBe('none');
  // B keeps the child waiting.
  expect((await state(b)).offspring.kind).toBe('card');

  // The lineage view: the frozen parent, the other parent and the child, with both parents drawn.
  // Esc opens the menu, which holds Lineage (M6b T9).
  await a.keyboard.press('Escape');
  await a.getByTestId('menu-lineage').click();
  const panel = a.getByTestId('lineage');
  await expect(panel).toBeVisible();
  await expect(a.getByTestId('lineage-node')).toHaveCount(3, { timeout: 10_000 });
  await expect(a.getByTestId('lineage-edge')).toHaveCount(2);
  await expect(a.getByTestId('lineage-chain').locator('li')).toHaveCount(2);
  expect(await panel.textContent()).not.toMatch(/pedigree|ledger|chain_parent|checkpoint/i);
  const box = await panel.boundingBox();
  expect(
    box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 960 && box.y + box.height <= 540,
  ).toBe(true);
  await a.screenshot({ path: 'test-results/m5-promote-lineage.png' });
  await a.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await a.keyboard.press('Escape');
  await expect(a.getByTestId('menu')).toBeHidden();

  // Starving the child: the death screen offers the parent, with how much life is left.
  await a.evaluate(() => {
    const bs = window.__bs as BsHook;
    bs.debug?.setEnergy(0);
    bs.debug?.timeScale(30);
  });
  await expect(a.getByTestId('death-fallback-ancestor')).toBeVisible({ timeout: 60_000 });
  const label = (await a.getByTestId('death-fallback-ancestor').textContent()) ?? '';
  expect(label).toMatch(/^Return to .*, generation 0 \(about \d+ min of life left\)$/);
  expect(label).not.toMatch(BANNED);
  await expect(a.getByTestId('hatch-again')).toBeHidden();
  await a.screenshot({ path: 'test-results/m5-promote-death.png' });
  // Back to real time first: at 30x the restored parent can starve between the wait and the read.
  await a.evaluate(() => (window.__bs as BsHook).debug?.timeScale(1));
  await a.getByTestId('death-fallback-ancestor').click();
  // The creature id changes before the status does: wait for play, not just the id.
  await a.waitForFunction(
    (parent) => {
      const { life } = window.__bs?.state() ?? {};
      return life?.creature === parent && life.status === 'playing';
    },
    parentA,
    { timeout: 20_000 },
  );
  const back = await state(a);
  expect(back.life.status).toBe('playing');
  expect(back.life.activeMs).toBeGreaterThanOrEqual(frozenAt);
  expect(back.life.activeMs - frozenAt).toBeLessThan(5000);
  await Promise.all([ctxA.close(), ctxB.close()]);
});
