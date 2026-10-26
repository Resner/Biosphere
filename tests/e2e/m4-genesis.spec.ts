import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { genomeHash } from '../../src/genome/codec';
import type { Beacon } from '../../src/ledger/drand';
import { randomnessOf } from '../../src/ledger/drand';
import { genesisFor } from '../../src/ledger/genesis';
import { clickHatch, openRecorded, playerOf, state, waitPlaying } from './helpers';

// Hatching through the ledger (M4 T9) against the local authority with recorded drand rounds.

const rounds: { first: number; beacons: Beacon[] } = JSON.parse(
  readFileSync(new URL('../fixtures/drand/rounds.json', import.meta.url), 'utf8'),
);

test.describe.configure({ mode: 'serial' });

test('a hatch waits for the beacon, then the creature appears with its recorded DNA', async ({
  browser,
}) => {
  const page = await (await browser.newContext()).newPage();
  await openRecorded(page);
  const started = Date.now();
  await clickHatch(page);
  await expect(page.getByTestId('hatch-note')).toHaveText('Awaiting beacon…');
  expect((await state(page)).life.awaitingBeacon).toBe(true);
  expect((await state(page)).screen).toBe('title');
  // The note must not sit on top of the Creature Lab link (960×540).
  const note = await page.getByTestId('hatch-note').boundingBox();
  const lab = await page.getByTestId('lab-link').boundingBox();
  if (!note || !lab) throw new Error('missing boxes');
  expect(note.y).toBeGreaterThanOrEqual(lab.y + lab.height);
  await waitPlaying(page);
  // Under the fixture clock the wait is a round or two; the PR suite bound is 15 s.
  expect(Date.now() - started).toBeLessThan(15_000);

  const s = await state(page);
  expect(s.life).toMatchObject({ status: 'playing', awaitingBeacon: false, practice: false });
  expect(s.life.creature).toMatch(/^[0-9a-f]{64}$/);
  expect(s.life.genome).toBe(s.player?.genomeHash);
  await expect(page.getByTestId('hatch-note')).toBeHidden();
  await expect(page.getByTestId('practice-badge')).toBeHidden();

  // The DNA is a function of the beacon and the commitment, recomputed here from the fixtures.
  const mine = await page.evaluate(() => window.__bs?.life.recompute());
  if (!mine) throw new Error('no genesis was recorded');
  const beacon = rounds.beacons[mine.round - rounds.first] as Beacon;
  expect(mine.genomeHash).toBe(s.player?.genomeHash);
  expect(genomeHash(genesisFor(randomnessOf(beacon), mine.commit))).toBe(s.player?.genomeHash);
  await page.context().close();
});

test('two identities get different creatures', async ({ browser }) => {
  const hashes: string[] = [];
  for (let i = 0; i < 2; i++) {
    const page = await (await browser.newContext()).newPage();
    await openRecorded(page);
    await clickHatch(page);
    await waitPlaying(page);
    hashes.push((await playerOf(page)).genomeHash);
    await page.context().close();
  }
  expect(new Set(hashes).size).toBe(2);
});

test('DNA that does not check out spawns nothing and offers a retry', async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  // The hub's genesis arrives with another creature's genome text.
  await page.routeWebSocket(/\/v1\/hub/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => {
      const text = typeof message === 'string' ? message : message.toString();
      const msg = JSON.parse(text) as { t: string; genome?: string };
      if (msg.t === 'genesis') {
        const { genome } = msg;
        msg.genome = `${genome?.slice(0, -3)}${genome?.endsWith('AAA') ? 'BBB' : 'AAA'}`;
        ws.send(JSON.stringify(msg));
      } else {
        ws.send(text);
      }
    });
    ws.onMessage((message) => server.send(message));
    ws.onClose(() => server.close());
  });
  await openRecorded(page);
  await clickHatch(page);
  await expect(page.getByTestId('hatch-note')).toHaveText('Could not verify your creature', {
    timeout: 15_000,
  });
  const s = await state(page);
  expect(s.screen).toBe('title');
  expect(s.player).toBeNull();
  expect(s.life.status).toBe('idle');
  await expect(page.getByRole('button', { name: 'Hatch', exact: true })).toBeEnabled();
  await page.context().close();
});

test('a pinned body is an unrecorded practice cell', async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openRecorded(page, '&genome=starter');
  await clickHatch(page);
  await page.waitForFunction(() => window.__bs?.state().screen === 'playing');
  expect((await state(page)).life).toMatchObject({ status: 'practice', practice: true });
  await expect(page.getByTestId('practice-badge')).toBeVisible();
  await expect(page.getByTestId('practice-badge')).toHaveText('Not recorded');
  await page.context().close();
});
