import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, type Page, test } from '@playwright/test';
import type { CardState } from '../../src/card/hook';
import type { BsHook } from '../../src/game/debug';
import type { ProofBundle } from '../../src/ledger/proof';
import { M9_LIFECYCLE_HUB as HUB, ripe, state } from './helpers';
import { killB, mate, open, stage } from './m7-fight';
import { takeOver } from './m9-steps';

// The whole M9 line in one scenario (@slow, release gate), on an authority with short lives and
// matings: A and B hatch, mate and take over their children; A's child kills B's; B restores its
// ancestor as the fallback offers; every page closes. Then anyone can check it, with everyone
// offline: the cards of A's child, B's restored creature and B's dead child verify back to genesis
// with their fights replayed, the command line agrees, and a bundle tampered in flight fails.

test.describe.configure({ mode: 'serial' });
// The card is judged on its screenshots: no low preset, and the medium one asked for.
test.use({ storageState: { cookies: [], origins: [] } });

const run = promisify(execFile);

const cardUrl = (id: string): string => `./card.html?c=${id}&hub=${HUB}&quality=medium`;
const cardState = (page: Page): Promise<CardState> =>
  page.evaluate(() => (window.__card as { state(): CardState }).state());

async function waitDone(page: Page, what: string): Promise<CardState> {
  await page
    .waitForFunction(() => ['done', 'error'].includes(window.__card?.state().phase ?? ''), null, {
      timeout: 45_000,
    })
    .catch(async (error) => {
      throw new Error(`${what} never finished: ${JSON.stringify(await cardState(page))}`, {
        cause: error,
      });
    });
  return cardState(page);
}

/** Waits until the authority has settled the fight `id`, with nobody connected. */
async function settled(page: Page, id: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const r = await page.request.get(`${HUB}/v1/e2e/encounter/${id}`);
        return r.ok() ? ((await r.json()) as { settled: boolean }).settled : false;
      },
      { message: `the authority settles fight ${id}`, timeout: 60_000 },
    )
    .toBe(true);
}

test('a lineage from genesis through a mating, a fight and a death is verified by its cards and the CLI @slow', async ({
  browser,
}) => {
  test.setTimeout(420_000);
  const [a, b] = await Promise.all([
    open(browser, HUB, '&quality=medium'),
    open(browser, HUB, '&quality=medium'),
  ]);
  const made: { a0?: string; b0?: string; a1?: string; b1?: string } = {};
  const ids = await stage(
    a,
    b,
    async () => {
      await Promise.all([ripe(a), ripe(b)]);
      made.a0 = (await state(a)).life.creature as string;
      made.b0 = (await state(b)).life.creature as string;
      await mate(a, b);
      [made.a1, made.b1] = await Promise.all([takeOver(a), takeOver(b)]);
    },
    0.6,
  );
  const { a0, b0, a1, b1 } = made;
  if (!a0 || !b0 || !a1 || !b1) throw new Error('the mating made no children');
  expect([a0, b0, a1, b1].every((id, i, all) => all.indexOf(id) === i)).toBe(true);

  // B reloaded to lose its spawn protection and lost its draw hook with the page.
  await b.evaluate(() => (window.__bs as BsHook).debug?.skipDraw(true));
  expect((await state(a)).life.creature).toBe(a1);
  expect((await state(b)).life.creature).toBe(b1);

  // A's child kills B's child; B's death screen offers its ancestor, and B takes it.
  const fight = await killB(a, b, ids);
  await b.waitForFunction(() => window.__bs?.state().screen === 'dead', undefined, {
    timeout: 15_000,
  });
  expect((await state(b)).death?.cause).toBe('killed');
  await b.getByTestId('death-fallback-ancestor').click();
  await b.waitForFunction((who) => window.__bs?.state().life.creature === who, b0, {
    timeout: 20_000,
  });
  expect((await state(b)).life.status).toBe('playing');
  await Promise.all([a.context().close(), b.context().close()]);

  // Everyone has left. The authority settles the fight by itself, and then anyone can check.
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await settled(page, fight);

  const checked = new Map<string, CardState>();
  for (const [what, id] of [
    ["A's child", a1],
    ["B's restored creature", b0],
    ["B's dead child", b1],
  ] as const) {
    await page.goto(cardUrl(id));
    const s = await waitDone(page, `the card of ${what}`);
    expect(s, what).toMatchObject({
      phase: 'done',
      subject: id,
      verdict: 'verified',
      toGenesis: true,
      scaled: true,
      problems: [],
      missing: 0,
    });
    // Every settled fight on the record was replayed from its log.
    expect(s.fights.replayed, `${what}: fights replayed`).toBe(s.fights.settled);
    checked.set(id, s);
  }
  for (const id of [a1, b1]) {
    expect(checked.get(id)?.fights.settled, 'the fight is on the record').toBeGreaterThanOrEqual(1);
  }
  expect(checked.get(b1)?.status).toBe('dead');
  await page.goto(cardUrl(a1));
  await waitDone(page, "A's child's card");
  await page.screenshot({ path: 'test-results/m9-lifecycle-card.png' });
  await test.info().attach('m9-lifecycle-card', {
    path: 'test-results/m9-lifecycle-card.png',
    contentType: 'image/png',
  });

  // The command line, against the same authority, agrees.
  const cli = await run('node', ['tools/lineage.mjs', a1, '--hub', HUB, '--replay']).catch(
    (error: { stdout?: string; stderr?: string }) => {
      throw new Error(`the CLI did not exit 0:\n${error.stdout}\n${error.stderr}`, {
        cause: error,
      });
    },
  );
  expect(cli.stdout).toMatch(/verified/i);

  // A bundle tampered in flight fails, and the card names the problem.
  const bad = await context.newPage();
  let tampered = false;
  await bad.route(/\/v1\/proof\//, async (route) => {
    const response = await route.fetch();
    const bundle = (await response.json()) as ProofBundle;
    const record = bundle.records.find((r) => typeof r.record.body.biomass === 'number');
    if (record) {
      record.record.body.biomass = (record.record.body.biomass as number) + 1;
      tampered = true;
    }
    await route.fulfill({ response, json: bundle });
  });
  await bad.goto(cardUrl(a1));
  const failed = await waitDone(bad, 'the tampered card');
  expect(tampered, 'the bundle held a record with a biomass').toBe(true);
  expect(failed).toMatchObject({ phase: 'done', verdict: 'failed' });
  expect(failed.problems[0]).toMatch(/^A record has been changed since it was written\./);
  await context.close();
});
