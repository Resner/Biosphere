import { expect, test } from '@playwright/test';
import { decodeRecoveryCode } from '../../src/ledger/recovery';
import { clickHatch, openRecorded, state, waitPlaying } from './helpers';

// The recovery code (M4 T11): a second browser takes over a creature with the code, and the first
// browser's tab stops through the single-session rule.

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

test('a recovery code moves the creature to another browser and replaces the old tab', async ({
  browser,
}) => {
  const a = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const pageA = await a.newPage();
  await openRecorded(pageA);
  // Until the code has been seen, the title screen reminds the player to save it.
  await expect(pageA.getByTestId('recovery-reminder')).toBeVisible();
  await clickHatch(pageA);
  await waitPlaying(pageA);
  const before = await state(pageA);

  // The panel is on the title screen: another tab of the same context would take the session over,
  // so read the code from a page that stays offline.
  const reader = await a.newPage();
  await reader.goto('./?debug=1');
  await reader.waitForFunction(() => window.__bs?.ready === true);
  await reader.waitForFunction(() => window.__bs?.state().playerId);
  expect((await state(reader)).playerId).toBe(before.playerId);
  await reader.getByTestId('recovery-open').click();
  const shown = reader.getByTestId('recovery-code');
  await expect(shown).toHaveAttribute('data-revealed', 'false');
  await shown.click();
  await expect(shown).toHaveAttribute('data-revealed', 'true');
  const text = (await shown.textContent()) ?? '';
  const seed = decodeRecoveryCode(text);
  expect(seed).not.toBeNull();
  await reader.getByTestId('recovery-copy').click();
  await expect(reader.getByTestId('recovery-copied')).toHaveText('Copied');
  expect(await reader.evaluate(() => navigator.clipboard.readText())).toBe(text);
  // The reminder is gone for good once the code was shown.
  await reader.reload();
  await reader.waitForFunction(() => window.__bs?.ready === true);
  await expect(reader.getByTestId('recovery-reminder')).toBeHidden();
  const dump = JSON.stringify(await state(reader)) + JSON.stringify(await state(pageA));
  const bytes = seed as Uint8Array;
  expect(dump).not.toContain(toHex(bytes));
  expect(dump).not.toContain(Buffer.from(bytes).toString('base64url'));
  expect(dump).not.toContain(text.replaceAll('-', ''));
  await reader.close();

  // A fresh browser imports the code: same player, same creature.
  const b = await browser.newContext();
  const pageB = await b.newPage();
  await openRecorded(pageB);
  const otherPlayer = (await state(pageB)).playerId;
  expect(otherPlayer).not.toBe(before.playerId);
  await pageB.getByTestId('recovery-open').click();
  await pageB.getByTestId('recovery-input').fill(text.toLowerCase().replaceAll('-', ' '));
  await pageB.getByTestId('recovery-import').click();
  await expect(pageB.getByTestId('recovery-confirm')).toContainText(
    'This replaces the creature you are playing with. Continue?',
  );
  await pageB.getByTestId('recovery-yes').click();
  await pageB.waitForFunction(
    (was) => window.__bs?.ready === true && window.__bs.state().playerId !== was,
    otherPlayer,
  );
  expect((await state(pageB)).playerId).toBe(before.playerId);

  // The old tab is replaced through the single-session rule and does not reconnect.
  await pageA.waitForFunction(() => window.__bs?.state().net.status === 'replaced');
  expect((await state(pageA)).net.text).toBe('Playing in another tab');

  await clickHatch(pageB);
  await waitPlaying(pageB);
  const after = await state(pageB);
  expect(after.life.creature).toBe(before.life.creature);
  expect(after.player?.genomeHash).toBe(before.player?.genomeHash);
  await pageA.waitForTimeout(2500);
  expect((await state(pageA)).net.status).toBe('replaced');
  await a.close();
  await b.close();
});

test('a wrong code is refused and the creature stays', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await openRecorded(page);
  const id = (await state(page)).playerId;
  await page.getByTestId('recovery-open').click();
  // Plain words, and the whole panel fits the smallest supported window.
  const panel = page.getByTestId('recovery');
  expect(await panel.innerText()).not.toMatch(/seed|key|hash|identity|ed25519|crypto|base32/i);
  const box = await panel.boundingBox();
  const { width, height } = page.viewportSize() ?? { width: 960, height: 540 };
  expect(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width).toBe(true);
  expect(box && box.y + box.height <= height).toBe(true);
  await page.getByTestId('recovery-input').fill('AAAAA-BBBBB');
  // Enter in the field imports; it must not hatch.
  await page.getByTestId('recovery-input').press('Enter');
  await page.getByTestId('recovery-yes').click();
  await expect(page.getByTestId('recovery-error')).toBeVisible();
  expect((await state(page)).screen).toBe('title');
  expect((await state(page)).playerId).toBe(id);
  await page.getByTestId('recovery-close').click();
  await expect(page.getByTestId('recovery')).toBeHidden();
  await context.close();
});
