import { expect, test } from '@playwright/test';
import { M7_KILL_HUB, ripe, state } from './helpers';
import { killB, mate, open, stage } from './m7-fight';

// A kill in play, with records (M7 T14, moved from T13): A and B mate, so both carry an egg; B,
// lowered to a third of its health, is killed by A, which eats B's egg with it. B's death screen
// names the killer and B's fallback lists no pending child; A still carries its own egg.

test.describe.configure({ mode: 'serial' });

test('a kill eats the victim’s egg, names the killer and leaves the killer’s egg @slow', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const [a, b] = await Promise.all([open(browser, M7_KILL_HUB), open(browser, M7_KILL_HUB)]);
  try {
    const ids = await stage(
      a,
      b,
      async () => {
        await Promise.all([ripe(a), ripe(b)]);
        await mate(a, b);
      },
      0.6,
    );
    // B reloaded and resumed with its egg still pending.
    expect((await state(b)).life.pending).toBe(true);
    expect((await state(a)).life.pending).toBe(true);

    await killB(a, b, ids);

    await b.waitForFunction(() => window.__bs?.state().screen === 'dead', undefined, {
      timeout: 15_000,
    });
    expect((await state(b)).death?.cause).toBe('killed');
    await expect(b.getByTestId('death-cause')).toHaveText(/^Killed by \S/);
    // The egg died with its carrier: nothing to fall back on.
    expect((await state(b)).life.pending).toBe(false);
    expect((await state(b)).life.fallback?.pending ?? false).toBe(false);
    // The killer keeps its own.
    expect((await state(a)).player?.alive).toBe(true);
    expect((await state(a)).life.pending).toBe(true);
  } finally {
    await Promise.all([a.context().close(), b.context().close()]);
  }
});
