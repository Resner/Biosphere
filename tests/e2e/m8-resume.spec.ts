import { expect, type Page, test } from '@playwright/test';
import { clickHatch, M8_RESUME_HUB, state, waitPlaying } from './helpers';
import { open, seen, stage } from './m7-fight';
import { chase, engage, flee, reloadMidFight, sameEnd, waitOver } from './m8-fight';

// Back to the fight (M8 T10): A engages B, and B reloads right after `enc-start`. B's title offers
// "Back to the fight"; a click puts B straight into the same fight, caught up. A stance B picks
// then shows on A's client, A swims off, and both hashes equal the referee's. A fight can end
// before B is back (B's autopilot flees, or A loses it), so A engages again, at most 3 times.

test.describe.configure({ mode: 'serial' });

type Ids = { idA: string; idB: string };

/** One try: A engages, B reloads and resumes. The fight's id once B is back in it, else null. */
async function tryResume(a: Page, b: Page, ids: Ids, previous?: string): Promise<string | null> {
  const id = await engage(a, ids, previous);
  await chase(a, ids.idB);
  await b.waitForFunction((enc) => window.__bs?.state().encounter?.id === enc, id, {
    timeout: 5_000,
  });
  if (!(await reloadMidFight(a, b, id))) {
    // The fight ended while B was away: B swims on as it was, and A tries again.
    await clickHatch(b);
    await waitPlaying(b);
    return null;
  }
  await expect(b.getByTestId('resume-line')).toHaveText('Your creature fights on by itself');
  await expect(b.getByTestId('hatch')).toBeHidden();
  await b.getByTestId('resume-fight').click();
  await b
    .waitForFunction(() => window.__bs?.state().screen === 'playing', undefined, {
      timeout: 10_000,
    })
    .catch(async (error) => {
      throw new Error(`B never went back: ${JSON.stringify(await seen(b))}`, { cause: error });
    });
  const back = (await state(b)).encounter;
  expect(back?.id).toBe(id);
  expect(back?.rejoins).toBe(1);
  // Caught up in one step: the first frame shown is the present, not frame 0.
  expect(back?.frame ?? 0).toBeGreaterThan(0);
  return back?.over ? null : id;
}

test('B reloads mid-fight, goes back to it with one click, and both end on the referee hash', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const [a, b] = await Promise.all([open(browser, M8_RESUME_HUB), open(browser, M8_RESUME_HUB)]);
  try {
    // B stays whole: a healthy starter neither flees nor dies while it is away.
    const ids = await stage(a, b, undefined, 1);
    let id: string | null = null;
    let previous: string | undefined;
    for (let attempt = 0; attempt < 3 && id === null; attempt++) {
      if (previous) await waitOver(a, previous, 'A');
      id = await tryResume(a, b, ids, previous);
      previous = (await state(a)).encounter?.id;
    }
    if (!id)
      throw new Error(`B was never back in a running fight: ${JSON.stringify(await seen(a))}`);

    // B picks the evasive stance (3) until its own view shows it, and A's client shows it too.
    await b
      .waitForFunction(
        (me) => {
          const enc = window.__bs?.state().encounter;
          if (!enc || enc.over) return true;
          if (enc.fighters.find((f) => f.player === me)?.stance === 'evasive') return true;
          dispatchEvent(new KeyboardEvent('keydown', { key: '3' }));
          dispatchEvent(new KeyboardEvent('keyup', { key: '3' }));
          return false;
        },
        ids.idB,
        { timeout: 15_000, polling: 'raf' },
      )
      .catch(async (error) => {
        throw new Error(`B's stance never showed: ${JSON.stringify(await seen(b))}`, {
          cause: error,
        });
      });
    const stanceShown = await a
      .waitForFunction(
        ([enc, who]) => {
          const e = window.__bs?.state().encounter;
          if (e?.id !== enc) return false;
          return e.fighters.find((f) => f.player === who)?.stance === 'evasive' || e.over;
        },
        [id, ids.idB] as const,
        { timeout: 10_000 },
      )
      .then(async () => (await state(a)).encounter?.fighters.find((f) => f.player === ids.idB));
    // A fight that ended in the meantime can still be judged by its hash, but the stance must have shown.
    const ended = (await state(a)).encounter?.over === true;
    if (!ended) expect(stanceShown?.stance, "B's stance on A's client").toBe('evasive');

    await flee(a, ids.idB);
    await waitOver(a, id, 'A');
    await waitOver(b, id, 'B');
    await sameEnd(a, b, id);
  } finally {
    await Promise.all([a.context().close(), b.context().close()]);
  }
});
