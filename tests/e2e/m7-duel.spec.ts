import { expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { M7_DUEL_HUB, state, topUp } from './helpers';
import { fightLine, open, parkBeside, seen, stage } from './m7-fight';

// The first hub duel (M7 T11): A parks beside B, B (resumed, so not spawn-protected) lowers its
// health, and A presses F. Both clients get the same `enc-start`, A picks a stance that B's client
// shows, A swims onto B and kills it, both clients' final hash equals the referee's, and B's death
// screen names the cause. B's autopilot may flee (an escape ends the fight with no kill), so A
// heals and engages again until a fight ends in B's death, as the other M7 hub specs do.

test.describe.configure({ mode: 'serial' });

/** B's health as a share of its maximum. */
const HURT = 0.3;

type Ids = { idA: string; idB: string };

/** One fight, from A's F to the referee's end on both pages. Returns the encounter's id. */
async function oneFight(
  a: Page,
  b: Page,
  { idA, idB }: Ids,
  previous?: string,
): Promise<{ id: string; stance: boolean }> {
  // A parks beside B, lets a few snapshots leave from the new place (the engage carries A's signed
  // snapshot, and an engage from a stale place is refused), and presses F; if no new fight starts,
  // it parks and presses again.
  await expect(async () => {
    await parkBeside(a, idB);
    const at = (await state(a)).tick;
    await a.waitForFunction((t) => (window.__bs?.state().tick ?? 0) >= t + 15, at, {
      timeout: 8_000,
    });
    await expect(a.getByTestId('attack-hint')).toBeVisible();
    const before = (await a.evaluate(() => (window.__bs as BsHook).render.fx())).engage;
    await a.keyboard.press('f');
    // The engage ring was asked for in the key press itself.
    expect((await a.evaluate(() => (window.__bs as BsHook).render.fx())).engage).toBe(before + 1);
    await a.waitForFunction(
      (old) => {
        const enc = window.__bs?.state().encounter;
        return enc !== null && enc !== undefined && enc.id !== old;
      },
      previous,
      { timeout: 4_000 },
    );
  }, 'A parks beside B, presses F and the fight starts')
    .toPass({ timeout: 40_000 })
    .catch(async (error) => {
      throw new Error(`A's fight never started: ${JSON.stringify(await seen(a))}`, {
        cause: error,
      });
    });

  // A braces by itself against B's windups: B hits as hard as A, and an A left at a few points
  // dies of the water before the next try.
  await a.evaluate(() => (window.__bs as BsHook).debug?.autoBrace(true));
  // A swims onto B (debug steering works in a fight) until the referee ends it, from the first
  // frame: the escape clock (3 s outside range) runs while A waits for its stance and for B's page.
  const chase = a
    .waitForFunction(
      (who) => {
        const bs = window.__bs as BsHook;
        const s = bs.state();
        if (s.encounter?.over) return true;
        const r = s.remotes.find((x) => x.id === who);
        if (r) void bs.debug?.steerTo({ id: who, x: r.x, y: r.y });
        return false;
      },
      idB,
      { timeout: 40_000, polling: 250 },
    )
    .catch(async (error) => {
      throw new Error(`the fight never ended: ${JSON.stringify(await seen(a))}`, {
        cause: error,
      });
    });
  chase.catch(() => undefined); // awaited below
  // Both get `enc-start`. A sets its stance (1: aggressive) from the frame it sees the fight and
  // presses again every frame until its own view shows it (a press that lands past the deadline
  // is dropped, and a loaded runner can miss the first frames).
  const stanceA = await a
    .waitForFunction(
      (me) => {
        const enc = window.__bs?.state().encounter;
        if (!enc) return false;
        if (enc.over) return 'over';
        if (enc.fighters.find((f) => f.player === me)?.stance === 'aggressive') return 'shown';
        dispatchEvent(new KeyboardEvent('keydown', { key: '1' }));
        dispatchEvent(new KeyboardEvent('keyup', { key: '1' }));
        return false;
      },
      idA,
      { timeout: 15_000, polling: 'raf' },
    )
    .catch(async (error) => {
      throw new Error(`A's stance never showed: ${JSON.stringify(await seen(a))}`, {
        cause: error,
      });
    });
  const encA = (await state(a)).encounter;
  // A fight that is over before A's stance showed (B died or fled at once) has no stance to see.
  const stance = (await stanceA.jsonValue()) === 'shown';
  if (stance) {
    await b
      .waitForFunction(
        ([id, me]) => {
          const enc = window.__bs?.state().encounter;
          return (
            enc?.id === id && enc?.fighters.find((f) => f.player === me)?.stance === 'aggressive'
          );
        },
        [encA?.id, idA] as const,
        { timeout: 10_000 },
      )
      .catch(async (error) => {
        throw new Error(`B never saw A's stance: ${JSON.stringify(await seen(b))}`, {
          cause: error,
        });
      });
  }

  await chase;
  await b.waitForFunction(() => window.__bs?.state().encounter?.over === true, undefined, {
    timeout: 10_000,
  });
  return { id: encA?.id as string, stance };
}

test('A engages B with F, both play the same fight, and A kills B', async ({ browser }) => {
  test.setTimeout(240_000);
  const [a, b] = await Promise.all([open(browser, M7_DUEL_HUB), open(browser, M7_DUEL_HUB)]);
  try {
    // B somewhere calm and hurt to a third: a loaded runner plays few frames for A (the referee
    // flies A's missing inputs with its autopilot), so a healthier B escapes before enough strikes
    // land, and a nearly dead one dies of the water (a `died` outcome) before A's strikes kill it.
    const ids = await stage(a, b, undefined, HURT);

    let id: string | undefined;
    let killed = false;
    const fights: string[] = [];
    let stanceShown = false;
    for (let attempt = 0; attempt < 4 && !killed; attempt++) {
      // A whole again for each try, B back to a third (an escape leaves it hurt, and a fight that
      // starts at zero health says nothing).
      await a.evaluate(() => (window.__bs as BsHook).debug?.setHealth(Number.MAX_SAFE_INTEGER));
      // B fed: a hurt B that starves (a `died` outcome, not a kill) says nothing. Never A: its full
      // belly turns into growth, and B's autopilot flees from a body over 1.5 times its size.
      await topUp(b);
      await b.evaluate((share) => {
        const bs = window.__bs as BsHook;
        bs.debug?.setHealth(Number.MAX_SAFE_INTEGER);
        const p = bs.state().player;
        if (p) bs.debug?.setHealth(p.health * share);
      }, HURT);
      const fight = await oneFight(a, b, ids, id);
      id = fight.id;
      stanceShown ||= fight.stance;
      const outcomes = (await state(a)).encounter?.fighters.map((f) => f.outcome);
      killed = outcomes?.includes('killed') ?? false;
      fights.push(await fightLine(a, ids));
    }

    const [endA, endB] = [(await state(a)).encounter, (await state(b)).encounter];
    for (const enc of [endA, endB]) {
      expect(enc?.id).toBe(id);
      expect(enc?.endHash).toMatch(/^[0-9a-f]+$/);
      expect(enc?.hash).toBe(enc?.endHash);
    }
    expect(endA?.endHash).toBe(endB?.endHash);
    const fighterOf = (enc: typeof endA, who: string) =>
      enc?.fighters.find((f) => f.player === who);
    expect(fighterOf(endA, ids.idB)?.outcome, `B survived four fights:\n${fights.join('\n')}`).toBe(
      'killed',
    );
    expect(fighterOf(endB, ids.idB)?.outcome).toBe('killed');
    // The stance A picked showed on B's client in at least one of the fights.
    expect(stanceShown, "A's stance showed on B in some fight").toBe(true);

    // B's death screen names the cause.
    await b.waitForFunction(() => window.__bs?.state().screen === 'dead', undefined, {
      timeout: 10_000,
    });
    expect((await state(b)).death?.cause).toBe('killed');
    await expect(b.getByTestId('death-cause')).toContainText('Killed');
    expect((await state(a)).player?.alive).toBe(true);
  } finally {
    await Promise.all([a.context().close(), b.context().close()]);
  }
});
