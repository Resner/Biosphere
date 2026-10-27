import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import {
  clickHatch,
  goTo,
  M5_LIFECYCLE_HUB as HUB,
  openRecorded,
  ripe,
  state,
  topUp,
  waitPlaying,
} from './helpers';

// The whole M5 line in one scenario (@slow, release gate), on an authority with lives of 1 to 2 min
// and maturity in seconds: A mates with B and promotes the child, the child mates with C and
// promotes the grandchild, then each creature of A's line dies of old age in turn and the walk
// offers the one before it until nothing is left and a new genesis starts. B kept their child
// pending throughout (their own creature dies of old age meanwhile) and takes it at the end.

async function hatched(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await openRecorded(page, '', HUB);
  await clickHatch(page);
  await waitPlaying(page);
  return page;
}

/**
 * Waits in real time, belly full, until the creature dies of old age. The authority credits at
 * most wall time, and 30x play only meets more toxin clouds.
 */
async function growOld(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const bs = window.__bs as BsHook;
      const w = window as unknown as { lastHealth?: number };
      const { screen, player } = bs.state();
      if (screen === 'dead') return true;
      bs.debug?.setEnergy(Number.MAX_SAFE_INTEGER);
      // A toxin cloud drifted over the waiting creature: move out of it.
      if (player && (w.lastHealth ?? 0) > player.health) {
        bs.debug?.teleport(player.x + 300, player.y + 300);
      }
      w.lastHealth = player?.health ?? 0;
      return false;
    },
    undefined,
    { timeout: 170_000 },
  );
  expect((await state(page)).death?.cause).toBe('old-age');
}

/** `courter` courts `partner`, who accepts; both end up with a card for a different child. */
async function mate(courter: Page, partner: Page): Promise<void> {
  const who = (await state(partner)).playerId as string;
  await Promise.all([topUp(courter), topUp(partner)]);
  // The partner drifts and the hub's answer takes a moment: stay beside them until the key is offered.
  await expect(async () => {
    await goTo(courter, who);
    await expect(courter.getByTestId('mate-hint')).toHaveText(/^E: court /, { timeout: 1500 });
  }).toPass({ timeout: 30_000 });
  await courter.keyboard.press('e');
  await courter.keyboard.press('e');
  await expect(partner.getByTestId('invite')).toBeVisible({ timeout: 15_000 });
  await partner.keyboard.press('e');
  for (const page of [courter, partner]) {
    await page.waitForFunction(() => window.__bs?.state().offspring.kind === 'card', undefined, {
      timeout: 60_000,
    });
  }
}

async function become(page: Page, creature: string | null): Promise<void> {
  await page.keyboard.press('h');
  await page.waitForFunction((c) => window.__bs?.state().life.creature === c, creature, {
    timeout: 20_000,
  });
}

test('a line of three creatures, promoted, grown old and walked back to a new genesis @slow', async ({
  browser,
}) => {
  test.setTimeout(600_000);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const ctxC = await browser.newContext();
  const [a, b, c] = await Promise.all([hatched(ctxA), hatched(ctxB), hatched(ctxC)]);
  await Promise.all([ripe(a), ripe(b), ripe(c)]);
  const root = (await state(a)).life.creature as string;

  // A and B mate: two different children, A becomes theirs, B keeps the card (one pending).
  await mate(a, b);
  const [childA, childB] = [(await state(a)).offspring, (await state(b)).offspring];
  expect(childA.genomeHash).not.toBe(childB.genomeHash);
  await become(a, childA.creature);
  const first = childA.creature as string;
  expect((await state(b)).offspring.kind).toBe('card');

  // The child grows up and mates with C; A promotes the grandchild.
  await ripe(a);
  await mate(a, c);
  const grand = (await state(a)).offspring;
  await become(a, grand.creature);
  expect(grand.generation).toBe(2);
  expect((await state(b)).offspring.creature).toBe(childB.creature);

  // The lineage view lists the whole line.
  await a.keyboard.press('Escape');
  await expect(a.getByTestId('lineage')).toBeVisible();
  const ids = a.getByTestId('lineage-chain').locator('li');
  await expect(ids).toHaveCount(3, { timeout: 10_000 });
  await a.screenshot({ path: 'test-results/m5-lifecycle-lineage.png' });
  await a.keyboard.press('Escape');

  // Old age walks the chain: the grandchild, the child, the genesis creature, then a new genesis.
  for (const expected of [first, root]) {
    await growOld(a);
    await expect(a.getByTestId('death-fallback-ancestor')).toBeVisible();
    await a.getByTestId('death-fallback-ancestor').click();
    await a.waitForFunction((who) => window.__bs?.state().life.creature === who, expected, {
      timeout: 20_000,
    });
    expect((await state(a)).life.status).toBe('playing');
  }
  await growOld(a);
  await expect(a.getByTestId('death-fallback-ancestor')).toBeHidden();
  await a.screenshot({ path: 'test-results/m5-lifecycle-extinct.png' });
  await a.getByTestId('hatch-again').click();
  await waitPlaying(a);
  const fresh = (await state(a)).life.creature;
  expect([root, first, grand.creature]).not.toContain(fresh);

  // B's own creature died of old age long ago, standing by; the child is still pending and the
  // death screen offers it.
  await expect(b.getByTestId('death-fallback-child')).toBeVisible();
  expect((await state(b)).offspring.creature).toBe(childB.creature);
  await b.getByTestId('death-fallback-child').click();
  await b.waitForFunction((x) => window.__bs?.state().life.creature === x, childB.creature, {
    timeout: 20_000,
  });
  expect((await state(b)).offspring.kind).toBe('none');
  await Promise.all([ctxA.close(), ctxB.close(), ctxC.close()]);
});
