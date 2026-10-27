import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { clickHatch, M5_INSPECT_HUB, openRecorded, state, waitPlaying } from './helpers';

async function hatched(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await openRecorded(page, '', M5_INSPECT_HUB);
  await clickHatch(page);
  await waitPlaying(page);
  return page;
}

// The inspect card: click another creature to read it before courting. Species, a rarity badge, size,
// plain-words traits, kinship and the hints, beside the creature and never over it.
test('clicking another creature opens a card that sits beside it', async ({ browser }) => {
  test.setTimeout(90_000);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const [a, b] = await Promise.all([hatched(ctxA), hatched(ctxB)]);
  const idB = (await state(b)).playerId as string;
  await a.waitForFunction((who) => window.__bs?.state().remotes.some((r) => r.id === who), idB, {
    timeout: 20_000,
  });
  // Beside B, with B's body drawn (its genome has arrived).
  await a.evaluate((who) => {
    const bs = window.__bs as BsHook;
    const r = bs.state().remotes.find((x) => x.id === who);
    if (r) bs.debug?.teleport(r.x + r.radius * 2.5, r.y);
  }, idB);
  await a.waitForFunction(
    (who) => window.__bs?.state().remotes.find((r) => r.id === who)?.species != null,
    idB,
    { timeout: 20_000 },
  );
  const at = await a.evaluate((who) => {
    const bs = window.__bs as BsHook;
    const s = bs.state();
    const r = s.remotes.find((x) => x.id === who);
    const { halfHeight, camX, camY } = bs.render.fx();
    const px = innerHeight / (2 * halfHeight);
    return r
      ? { x: innerWidth / 2 + (r.x - camX) * px, y: innerHeight / 2 - (r.y - camY) * px }
      : null;
  }, idB);
  expect(at).not.toBeNull();
  await a.mouse.click(at?.x ?? 0, at?.y ?? 0);

  const card = a.getByTestId('inspect');
  await expect(card).toBeVisible();
  await expect(a.getByTestId('inspect-species')).not.toBeEmpty();
  await expect(a.getByTestId('inspect-badge')).toHaveText(/^(Common|Uncommon|Rare|Exotic)$/);
  await expect(a.getByTestId('inspect-traits').locator('li')).toHaveCount(3);
  // The hub's answer adds kinship and whether they can mate now.
  await expect(a.getByTestId('inspect-kinship')).not.toBeEmpty();
  await expect(a.getByTestId('inspect-verdict')).not.toBeEmpty();
  const hints = a.getByTestId('inspect-hints');
  await expect(hints).toContainText('Mutations can still surprise you.');
  const weak = await hints.innerText();
  expect(weak).not.toMatch(/allele|locus|genotype|punnett|homozygous/i);
  for (const m of weak.matchAll(/(\d+(?:\.\d+)?)%/g))
    expect(Number(m[1])).toBe(Math.round(Number(m[1])));

  // The card does not cover the creature it describes, and fits the 960x540 window.
  const box = await card.boundingBox();
  expect(box).not.toBeNull();
  const b0 = box as NonNullable<typeof box>;
  expect(
    at && at.x >= b0.x && at.x <= b0.x + b0.width && at.y >= b0.y && at.y <= b0.y + b0.height,
  ).toBe(false);
  expect(b0.x).toBeGreaterThanOrEqual(0);
  expect(b0.y + b0.height).toBeLessThanOrEqual(540);
  await a.screenshot({ path: 'test-results/m5-inspect-card.png' });

  await a.keyboard.press('Escape');
  await expect(card).toBeHidden();
  await Promise.all([ctxA.close(), ctxB.close()]);
});
