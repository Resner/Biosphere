import { expect, type Page, test } from '@playwright/test';
import type { CardState } from '../../src/card/hook';
import type { BsHook } from '../../src/game/debug';
import type { SignedSettlement } from '../../src/ledger/settlement';
import type { SignedAttestation } from '../../src/ledger/witness';
import { clickHatch, M10_CARD_HUB, state, waitPlaying } from './helpers';
import { fightToEnd, open, stage } from './m7-fight';

// Witnesses on the card (M10 T10): C and D can witness (the hub's `WITNESS_PLAY_MS=0` and
// `WITNESS_IP_CHECK=off`). A fights B, and the fight is refereed by whichever of them the drand
// order puts first, where the page takes the referee duty, and audited by the next. Then every
// page closes, and A's card verifies and ends that fight's line in what a witness did, as the
// hub's settlement and attestations say, never hiding an event the authority checked alone.

test.describe.configure({ mode: 'serial' });
// The card is judged on its screenshots: no low preset, and the high one asked for.
test.use({ storageState: { cookies: [], origins: [] } });

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

/** What `GET /v1/e2e/witness/<event>` serves that the test reads (`WitnessView`, `worker/duty.ts`). */
interface WitnessView {
  attestations: SignedAttestation[];
}

/** Hatches the page's creature and waits until it tells the hub it can witness. */
async function witnessing(page: Page): Promise<void> {
  // Four software-rendered pages draw slower than a witness may: availability judges fast frames.
  await page.evaluate(() => (window.__bs as BsHook).debug?.dutyFrameMs(16));
  await clickHatch(page);
  await waitPlaying(page);
  await expect
    .poll(async () => (await state(page)).witness.avail, {
      message: 'the page offers to witness',
      timeout: 60_000,
    })
    .toBe(true);
}

const hubJson = async <T>(page: Page, path: string): Promise<T> =>
  (await (await page.request.get(`${M10_CARD_HUB}${path}`)).json()) as T;

const cardState = (page: Page): Promise<CardState> =>
  page.evaluate(() => (window.__card as { state(): CardState }).state());

test('a card says which of its events a witness saw @slow', async ({ browser }) => {
  test.setTimeout(420_000);
  const pages = await Promise.all([0, 1, 2, 3].map(() => open(browser, M10_CARD_HUB)));
  const [a, b, c, d] = pages as [Page, Page, Page, Page];
  let creature = '';
  let enc = '';
  try {
    await Promise.all([witnessing(c), witnessing(d)]);
    const ids = await stage(a, b).catch(async (error) => {
      const seen = await Promise.all(
        pages.map(async (page) => {
          const st = await state(page);
          return {
            screen: st.screen,
            life: st.life.status,
            net: st.net.status,
            witness: st.witness,
          };
        }),
      );
      throw new Error(`the hatches did not start play: ${JSON.stringify(seen)}`, { cause: error });
    });
    // A's and B's hatches are audited first: both witnesses must be free for the fight's pool.
    for (const page of [c, d]) {
      await expect
        .poll(async () => (await state(page)).witness.auditing, {
          message: 'the witness is free',
          timeout: 60_000,
        })
        .toBeNull();
    }
    creature = (await state(a)).life.creature as string;
    enc = (await fightToEnd(a, b, ids)) ?? '';
    if (!enc) throw new Error('no fight');
    // The fight's auditor attests after its end, and the hub stores it.
    await expect
      .poll(
        async () =>
          (await hubJson<WitnessView | null>(a, `/v1/e2e/witness/enc:${enc}`))?.attestations.map(
            (s) => s.attestation.agree,
          ),
        { message: "the hub stores the fight's attestation", timeout: 120_000 },
      )
      .toEqual([true]);
  } finally {
    await Promise.all(pages.map((p) => p.context().close()));
  }

  // Every page is closed. What the hub's settlement says of the fight's referees.
  const context = await browser.newContext({ viewport: DESKTOP });
  const page = await context.newPage();
  try {
    const fight = await hubJson<{ settlement: SignedSettlement }>(page, `/v1/fight/${enc}`);
    const s = fight.settlement.settlement;
    const refereed = s.v === 2 && s.referees.some((x) => x.by !== 'authority');

    await page.goto(`./card.html?c=${creature}&hub=${M10_CARD_HUB}&quality=high`);
    await page
      .waitForFunction(() => window.__card?.state().phase === 'done', null, { timeout: 60_000 })
      .catch(async (error) => {
        throw new Error(`the card never finished: ${JSON.stringify(await cardState(page))}`, {
          cause: error,
        });
      });
    const card = await cardState(page);
    expect(card).toMatchObject({ verdict: 'verified', problems: [] });
    // The fight, its own line, ends in what the witnesses did.
    const line = card.story.find((l) => l.startsWith('Fought once'));
    expect(line, JSON.stringify(card.story)).toMatch(
      refereed ? / · refereed by a witness, audited by another$/ : / · audited by a witness$/,
    );
    // Every fight, birth and hatch says witnessed or authority alone.
    const hatched = card.story[0] ?? '';
    expect(hatched).toMatch(/ · (audited by a witness|checked by the authority alone)$/);
    const w = card.witnessed;
    if (!w) throw new Error('no witness counts');
    expect(w).toMatchObject({ refereed: refereed ? 1 : 0, overruled: 0, unchecked: 0 });
    expect(w.audited).toBeGreaterThanOrEqual(1);
    expect(w.events).toBe(2);
    await expect(page.getByTestId('card-story')).toContainText(line as string);
    // The details, opened: what witnesses saw, counted.
    await page.getByTestId('card-details').locator('summary').click();
    await expect(page.getByTestId('card-families')).toBeVisible();
    await expect(page.getByTestId('card-families')).toContainText(
      `Witnesses: ${w.events - w.authorityOnly} of ${w.events} events seen by a witness; ${w.authorityOnly} checked by the authority alone`,
    );

    await page.screenshot({ path: 'test-results/m10-card-desktop.png', fullPage: true });
    await test.info().attach('m10-card-desktop', {
      path: 'test-results/m10-card-desktop.png',
      contentType: 'image/png',
    });
    await page.setViewportSize(PHONE);
    const widths = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(widths.scroll).toBeLessThanOrEqual(widths.client);
    await page.screenshot({ path: 'test-results/m10-card-phone.png', fullPage: true });
    await test.info().attach('m10-card-phone', {
      path: 'test-results/m10-card-phone.png',
      contentType: 'image/png',
    });
  } finally {
    await context.close();
  }
});
