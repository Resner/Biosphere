import { type Browser, expect, type Page, test } from '@playwright/test';
import type { CardState } from '../../src/card/hook';
import type { BsHook } from '../../src/game/debug';
import type { ProofBundle } from '../../src/ledger/proof';
import { clickHatch, M9_CARD_HUB, openRecorded, state, waitPlaying } from './helpers';
import { decodePng } from './look-metrics';

// The creature card (M9 T12): A hatches and leaves, and anyone opens the card of A's creature with
// every player offline. The card draws the creature before its verdict, verifies the proof in the
// browser, names a tampered record in plain words, and says when there is no such creature.

test.describe.configure({ mode: 'serial', timeout: 90_000 }); // the recorded hatch alone takes about 15 s
// The card is judged on its screenshots: no low preset, and the high one asked for.
test.use({ storageState: { cookies: [], origins: [] } });

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

interface Hatched {
  creature: string;
  species: string;
}

let hatched: Promise<Hatched> | null = null;

/** A's creature, hatched once per worker: A hatches, the hub takes a report, and A's page closes. */
function hatchAndLeave(browser: Browser): Promise<Hatched> {
  hatched ??= (async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await openRecorded(page, '', M9_CARD_HUB);
    await clickHatch(page);
    await waitPlaying(page);
    // A report the hub took, so the close writes a checkpoint (a record with a biomass).
    await page.waitForFunction(
      () => ((window.__bs as BsHook).state().life.lastAckN ?? 0) > 0,
      null,
      {
        timeout: 30_000,
      },
    );
    const s = await state(page);
    if (!s.life.creature || !s.player) throw new Error('A hatched no recorded creature');
    const out = { creature: s.life.creature, species: s.player.species };
    await context.close();
    return out;
  })();
  return hatched;
}

const cardUrl = (id: string): string => `./card.html?c=${id}&hub=${M9_CARD_HUB}&quality=high`;
const cardState = (page: Page): Promise<CardState> =>
  page.evaluate(() => (window.__card as { state(): CardState }).state());

async function waitPhase(page: Page, phases: CardState['phase'][]): Promise<CardState> {
  await page
    .waitForFunction((want) => want.some((p) => p === window.__card?.state().phase), phases, {
      timeout: 30_000,
    })
    .catch(async (error) => {
      throw new Error(
        `the card never reached ${phases}: ${JSON.stringify(await cardState(page))}`,
        {
          cause: error,
        },
      );
    });
  return cardState(page);
}

/** Pixels of the stage's screenshot brighter than the water: the creature drawn. */
async function litPixels(page: Page): Promise<number> {
  const png = await page.getByTestId('card-canvas').screenshot();
  const { rgba: data } = await decodePng(page, png);
  let lit = 0;
  for (let i = 0; i < data.length; i += 4) {
    if ((data[i] as number) + (data[i + 1] as number) + (data[i + 2] as number) > 90) lit++;
  }
  return lit;
}

test('a card verifies a creature whose owner is offline, drawing it before the verdict @slow', async ({
  browser,
}) => {
  const a = await hatchAndLeave(browser);
  const context = await browser.newContext({ viewport: DESKTOP });
  const page = await context.newPage();
  // The verifier's worker is held until the creature is drawn: no frame may wait on it.
  let atDraw: CardState | null = null;
  await page.route(/verify-worker-[^/]*\.js$/, async (route) => {
    await page.waitForFunction(() => window.__card?.state().drawn === true, null, {
      timeout: 30_000,
    });
    atDraw = await cardState(page);
    await route.continue();
  });
  await page.goto(cardUrl(a.creature));
  const s = await waitPhase(page, ['done', 'error']);
  expect(atDraw).toMatchObject({ phase: 'verifying', verdict: null, drawn: true });

  expect(s).toMatchObject({
    phase: 'done',
    error: null,
    subject: a.creature,
    species: a.species,
    generation: 0,
    status: 'active',
    verdict: 'verified',
    toGenesis: true,
    scaled: false,
    problems: [],
    missing: 0,
    drawn: true,
    renderer: 'webgl',
  });
  await expect(page.getByTestId('card-species')).toHaveText(a.species);
  await expect(page.getByTestId('card-verdict')).toHaveText('Verified back to genesis');
  await expect(page.getByTestId('card-story')).toContainText('Hatched from drand round');
  // A card names no player: the hub's default names are "Cell" and four digits.
  await expect(page.locator('body')).not.toContainText(/Cell\d{4}/);
  expect(await litPixels(page)).toBeGreaterThan(400);
  await test.info().attach('m9-card-timings', {
    body: JSON.stringify(s.timings),
    contentType: 'application/json',
  });
  await page.screenshot({ path: 'test-results/m9-card-desktop.png' });
  await test.info().attach('m9-card-desktop', {
    path: 'test-results/m9-card-desktop.png',
    contentType: 'image/png',
  });

  // At phone width nothing scrolls sideways, and the creature is still drawn.
  await page.setViewportSize(PHONE);
  await page.waitForFunction(
    (w) =>
      (document.querySelector('[data-testid="card-stage"]')?.getBoundingClientRect().width ?? w) <
      w,
    PHONE.width,
  );
  const widths = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client);
  expect(await litPixels(page)).toBeGreaterThan(200);
  await page.screenshot({ path: 'test-results/m9-card-phone.png', fullPage: true });
  await test.info().attach('m9-card-phone', {
    path: 'test-results/m9-card-phone.png',
    contentType: 'image/png',
  });
  await context.close();
});

test('a bundle tampered in flight fails with a plain problem line', async ({ browser }) => {
  const a = await hatchAndLeave(browser);
  const context = await browser.newContext({ viewport: DESKTOP });
  const page = await context.newPage();
  let tampered = false;
  await page.route(/\/v1\/proof\//, async (route) => {
    const response = await route.fetch();
    const bundle = (await response.json()) as ProofBundle;
    const s = bundle.records.find((r) => typeof r.record.body.biomass === 'number');
    if (s) {
      s.record.body.biomass = (s.record.body.biomass as number) + 1;
      tampered = true;
    }
    await route.fulfill({ response, json: bundle });
  });
  await page.goto(cardUrl(a.creature));
  const s = await waitPhase(page, ['done', 'error']);
  expect(tampered, 'the bundle held a record with a biomass').toBe(true);
  expect(s).toMatchObject({ phase: 'done', verdict: 'failed', drawn: true });
  expect(s.problems[0]).toMatch(/^A record has been changed since it was written\. \(/);
  await expect(page.getByTestId('card-verdict')).toHaveText(
    'Not verified: A record has been changed since it was written.',
  );
  await page.getByText('How it was checked').click();
  await expect(page.getByTestId('card-problems')).toContainText('A record has been changed');
  await page.screenshot({ path: 'test-results/m9-card-failed.png' });
  await test.info().attach('m9-card-failed', {
    path: 'test-results/m9-card-failed.png',
    contentType: 'image/png',
  });
  await context.close();
});

test('an unknown id says there is no such creature', async ({ browser }) => {
  const context = await browser.newContext({ viewport: PHONE });
  const page = await context.newPage();
  await page.goto(cardUrl('0'.repeat(64)));
  const s = await waitPhase(page, ['error', 'done']);
  expect(s).toMatchObject({ phase: 'error', error: 'not-found', verdict: null, drawn: false });
  await expect(page.getByTestId('card-error')).toHaveText('No such creature');
  await context.close();
});
