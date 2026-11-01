import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { decodeRecoveryCode } from '../../src/ledger/recovery';
import { RULES_VERSION } from '../../src/sim/rules';
import { clickHatch, M6C_RESET_HUB, openRecorded, state, waitPlaying } from './helpers';

// The world renewal (M6c T2, ADR 0040). `wrangler dev` always starts migrated, so the hub's E2E hook
// stages this browser's identity as one first seen before the reset.

test.describe.configure({ mode: 'serial' });

const NOTICE =
  'The world was renewed in v0.7.2. Your identity is kept; your creatures start again.';

/** Waits until the hub has said who the player is on this page, and returns whether it said "renewed". */
async function heard(page: Page): Promise<boolean> {
  // A truthy wrapper, since `waitForFunction` waits past `false`.
  const handle = await page.waitForFunction(
    () => {
      const renewed = window.__bs?.state().renewed;
      return renewed === null || renewed === undefined ? null : { renewed };
    },
    undefined,
    { timeout: 15_000 },
  );
  return ((await handle.jsonValue()) as { renewed: boolean }).renewed;
}

async function reopen(page: Page): Promise<void> {
  await page.reload();
  await page.waitForFunction(() => window.__bs?.ready === true);
}

/** Opens a fresh browser on the reset hub, stages its identity as pre-reset and returns its id. */
async function returning(
  context: BrowserContext,
  request: APIRequestContext,
): Promise<{ page: Page; playerId: string }> {
  const page = await context.newPage();
  await openRecorded(page, '', M6C_RESET_HUB);
  // A new identity is never told.
  expect(await heard(page)).toBe(false);
  await expect(page.getByTestId('renewed')).toBeHidden();
  const playerId = (await state(page)).playerId as string;
  const staged = await request.post(`${M6C_RESET_HUB}/v1/e2e/pre-reset`, { data: { playerId } });
  expect(staged.status(), 'the hub staged the identity as pre-reset').toBe(204);
  return { page, playerId };
}

test('a returning identity sees the renewal notice once, and not after a reload', async ({
  browser,
  request,
}) => {
  const context = await browser.newContext();
  const { page } = await returning(context, request);
  const notice = page.getByTestId('renewed');

  // The notice, as a glass toast on the title screen.
  await reopen(page);
  expect(await heard(page)).toBe(true);
  await expect(notice).toBeVisible();
  await expect(notice).toHaveText(NOTICE);
  expect((await state(page)).screen).toBe('title');
  // History lists only the new epoch: nothing yet.
  await expect(page.getByTestId('history-empty')).toBeVisible();

  // And never again.
  await reopen(page);
  expect(await heard(page)).toBe(false);
  await expect(notice).toBeHidden();
  await context.close();
});

test('the recovery code of a returning identity still imports, and a fresh genesis hatches under rules 8', async ({
  browser,
  request,
}) => {
  test.setTimeout(45_000);
  const a = await browser.newContext();
  const { page, playerId } = await returning(a, request);
  await page.getByTestId('recovery-open').click();
  await page.getByTestId('recovery-code').click();
  await expect(page.getByTestId('recovery-code')).toHaveAttribute('data-revealed', 'true');
  const code = (await page.getByTestId('recovery-code').textContent()) ?? '';
  expect(decodeRecoveryCode(code)).not.toBeNull();
  await a.close();

  // Another browser takes the identity over with the code, and it is that identity that hears of
  // the renewal, wherever it comes back.
  const b = await browser.newContext();
  const other = await b.newPage();
  await openRecorded(other, '', M6C_RESET_HUB);
  const was = (await state(other)).playerId;
  await other.getByTestId('recovery-open').click();
  await other.getByTestId('recovery-input').fill(code);
  await other.getByTestId('recovery-import').click();
  await other.getByTestId('recovery-yes').click();
  await other.waitForFunction(
    (id) => window.__bs?.ready === true && window.__bs.state().playerId !== id,
    was,
  );
  expect((await state(other)).playerId).toBe(playerId);
  await other.waitForFunction(() => window.__bs?.state().renewed === true, undefined, {
    timeout: 15_000,
  });
  await expect(other.getByTestId('renewed')).toBeVisible();

  await clickHatch(other);
  await waitPlaying(other);
  const genesis = await other.evaluate(() => window.__bs?.life.recompute());
  expect(RULES_VERSION).toBe(8);
  expect(genesis?.rules, 'the genesis record names the live rules').toBe(RULES_VERSION);
  expect((await state(other)).life.creature).toBeTruthy();
  await b.close();
});
