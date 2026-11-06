import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, type Page, test } from '@playwright/test';
import type { CardState } from '../../src/card/hook';
import type { BsHook } from '../../src/game/debug';
import type { SignedAttestation } from '../../src/ledger/witness';
import { M10_LIFECYCLE_HUB as HUB, ripe, state } from './helpers';
import { mate, open, stage } from './m7-fight';
import { takeOver } from './m9-steps';
import {
  closeAll,
  end,
  hatch,
  sameEnd,
  settled,
  type Trio,
  witness,
  witnessedFight,
} from './m10-steps';

// The whole M10 line in one scenario (@slow, release gate), on an authority with short lives and
// matings and the witness variables (`WITNESS_PLAY_MS=0`, `WITNESS_IP_CHECK=off`): A and B hatch,
// mate and take over their children while C and D, who can witness, audit the births. A's child
// engages B's, and whichever of C and D the drand order puts first referees it from the handover,
// the other audits it; a second fight loses its witness when that page closes, and the authority
// takes it back. Every page closes. Then anyone can check it, with everyone offline: the cards
// verify and say what witnesses did, the command line agrees, and the audit shows no movement flag.

test.describe.configure({ mode: 'serial' });
// The card is judged on its screenshot: no low preset, and the medium one asked for.
test.use({ storageState: { cookies: [], origins: [] } });

const run = promisify(execFile);

const cardUrl = (id: string): string => `./card.html?c=${id}&hub=${HUB}&quality=medium`;
const cardState = (page: Page): Promise<CardState> =>
  page.evaluate(() => (window.__card as { state(): CardState }).state());

async function cardOf(page: Page, id: string, what: string): Promise<CardState> {
  await page.goto(cardUrl(id));
  await page
    .waitForFunction(() => ['done', 'error'].includes(window.__card?.state().phase ?? ''), null, {
      timeout: 60_000,
    })
    .catch(async (error) => {
      throw new Error(`${what} never finished: ${JSON.stringify(await cardState(page))}`, {
        cause: error,
      });
    });
  return cardState(page);
}

/** Waits until one of the pages attested an event of `kind`, agreeing. */
async function audited(pages: Page[], kind: string): Promise<string> {
  let found = '';
  await expect
    .poll(
      async () => {
        for (const page of pages) {
          const hit = (await state(page)).witness.audits.find((x) =>
            x.event.startsWith(`${kind}:`),
          );
          if (hit) {
            found = hit.event;
            return hit.agree;
          }
        }
        return null;
      },
      { message: `C or D audits the ${kind}`, timeout: 90_000 },
    )
    .toBe(true);
  return found;
}

/** The hub's stored attestations of an event, once there is `n`. */
async function attestations(page: Page, event: string, n: number): Promise<boolean[]> {
  let agree: boolean[] = [];
  await expect
    .poll(
      async () => {
        const r = await page.request.get(`${HUB}/v1/e2e/witness/${event}`);
        const view = r.ok()
          ? ((await r.json()) as { attestations: SignedAttestation[] } | null)
          : null;
        agree = view?.attestations.map((s) => s.attestation.agree) ?? [];
        return agree.length;
      },
      { message: `the hub stores ${n} attestation(s) of ${event}`, timeout: 120_000 },
    )
    .toBeGreaterThanOrEqual(n);
  return agree;
}

test('a mating, a witnessed fight and a fight whose witness fails are verified by cards, the CLI and the audit @slow', async ({
  browser,
  request,
}) => {
  test.setTimeout(600_000);
  const a = await open(browser, HUB);
  const b = await open(browser, HUB);
  const c = await witness(browser, HUB);
  const d = await witness(browser, HUB);
  let t: Trio | null = null;
  const made: { a1?: string; b1?: string; c0?: string; d0?: string } = {};
  const fights: string[] = [];
  try {
    // C and D hatch first, so both are in the pool for the births and the fights.
    await Promise.all([hatch(c), hatch(d)]);
    const ids = await stage(
      a,
      b,
      async () => {
        await Promise.all([ripe(a), ripe(b)]);
        await mate(a, b);
        [made.a1, made.b1] = await Promise.all([takeOver(a), takeOver(b)]);
      },
      1,
    );
    // `stage` reloaded B, which draws again: every page here skips its draw.
    await b.evaluate(() => (window.__bs as BsHook).debug?.skipDraw(true));
    if (!made.a1 || !made.b1) throw new Error('the mating made no children');
    made.c0 = (await state(c)).life.creature as string;
    made.d0 = (await state(d)).life.creature as string;
    t = {
      hub: HUB,
      a,
      b,
      c,
      d,
      ...ids,
      idC: (await state(c)).playerId as string,
      idD: (await state(d)).playerId as string,
    };

    // The births are audited by C or D, and the hub stores the attestation.
    const mating = await audited([c, d], 'mating');
    expect(await attestations(a, mating, 1)).toEqual([true]);

    // A's child fights B's child; a witness referees it from the handover, and the fight ends on
    // the authority's hash on both pages.
    const first = await witnessedFight(t);
    await end(t, first.id);
    await sameEnd(t, first.id);
    fights.push(first.id);
    const one = await settled(request, HUB, first.id);
    expect(one.referees.length).toBeGreaterThanOrEqual(2);
    expect(one.referees[0]).toMatchObject({ by: 'authority', from: 0 });
    expect([t.idC, t.idD]).toContain(one.referees[1]?.by);
    expect(one.referees[1]?.from).toBe(first.from);
    // The other witness audits it, and the hub stores that.
    expect(await attestations(a, `enc:${first.id}`, 1)).toEqual([true]);

    // A second fight whose witness's page closes mid-duty: the authority takes it back.
    const second = await witnessedFight(t);
    const holders: Page[] = [];
    for (const page of [c, d]) {
      if ((await state(page)).witness.duty?.enc === second.id) holders.push(page);
    }
    const holder = holders[0];
    if (holders.length !== 1 || !holder)
      throw new Error(`${holders.length} pages hold the duty of fight ${second.id}`);
    await holder.context().close();
    for (const page of [a, b]) {
      await page
        .waitForFunction(
          (enc) => {
            const e = window.__bs?.state().encounter;
            return e?.id === enc && (e.referee.by === 'authority' || e.over);
          },
          second.id,
          { timeout: 20_000 },
        )
        .catch(async (error) => {
          throw new Error(
            `no take-back: ${JSON.stringify((await state(page)).encounter?.referee)}`,
            { cause: error },
          );
        });
    }
    await end(t, second.id);
    await sameEnd(t, second.id);
    fights.push(second.id);
    const two = await settled(request, HUB, second.id);
    // The authority, the witness that failed, the authority again (the hub may then offer the
    // duty to the other witness, so later spans are not pinned).
    expect(two.referees.slice(0, 3).map((r) => r.by === 'authority')).toEqual([true, false, true]);
    expect(two.referees[1]?.from).toBe(second.from);
    expect(two.referees[2]?.from).toBeGreaterThan(second.from);
  } finally {
    await closeAll({ a, b, c, d });
  }

  // Every page is closed. The cards verify and say what witnesses did.
  const { a1, b1, c0, d0 } = made;
  if (!a1 || !b1 || !c0 || !d0) throw new Error('missing creatures');
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    for (const [what, id] of [
      ["A's child", a1],
      ["B's child", b1],
    ] as const) {
      const card = await cardOf(page, id, `the card of ${what}`);
      expect(card, what).toMatchObject({ phase: 'done', verdict: 'verified', problems: [] });
      expect(card.story[0], `${what}: ${JSON.stringify(card.story)}`).toMatch(
        /^Born .* · audited by a witness$/,
      );
      // Both fights are on the record, each marked refereed by a witness.
      const refereed = card.story.filter(
        (l) => /^Fight \d/.test(l) && /refereed by a witness/.test(l),
      );
      expect(refereed.length, `${what}: ${JSON.stringify(card.story)}`).toBeGreaterThanOrEqual(2);
      const w = card.witnessed;
      if (!w) throw new Error(`${what}: no witness counts`);
      expect(w.refereed).toBeGreaterThanOrEqual(2);
      expect(w.overruled).toBe(0);
      expect(w.unchecked).toBe(0);
    }
    for (const [what, id] of [
      ['C', c0],
      ['D', d0],
    ] as const) {
      const card = await cardOf(page, id, `the card of ${what}`);
      expect(card, what).toMatchObject({ phase: 'done', verdict: 'verified', problems: [] });
      expect(card.story[0]).toMatch(/ · (audited by a witness|checked by the authority alone)$/);
    }
    await cardOf(page, a1, "A's child");
    await page.screenshot({ path: 'test-results/m10-lifecycle-card.png' });
    await test.info().attach('m10-lifecycle-card', {
      path: 'test-results/m10-lifecycle-card.png',
      contentType: 'image/png',
    });
  } finally {
    await context.close();
  }

  // The command line, against the same authority, agrees and prints the witnessed line.
  const cli = await run('node', ['tools/lineage.mjs', a1, '--hub', HUB, '--replay']).catch(
    (error: { stdout?: string; stderr?: string }) => {
      throw new Error(`the CLI did not exit 0:\n${error.stdout}\n${error.stderr}`, {
        cause: error,
      });
    },
  );
  expect(cli.stdout).toMatch(/verified/i);
  expect(cli.stdout).toMatch(/Witnesses: \d+ of \d+ events? seen by a witness/);

  // Honest play never met the movement check.
  const audit = await request.get(`${HUB}/v1/audit`);
  expect(audit.ok()).toBe(true);
  const flags = (await audit.json()) as { total: Record<string, number> };
  expect(flags.total.teleport ?? 0, JSON.stringify(flags.total)).toBe(0);
  expect(fights).toHaveLength(2);
});
