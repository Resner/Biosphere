import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { state } from './helpers';
import { FIGHT_WALL_MS, parkBeside, seen } from './m7-fight';

// Shared by the M8 hub specs (M8 T10): an engage that returns the fight's id, a chase that keeps
// the fight going while the network does its worst, and a flight that ends it.

type Ids = { idA: string; idB: string };

/**
 * A parks beside B and presses F until a fight other than `previous` starts on A's page (parking
 * again whenever B has drifted off). Returns its id.
 */
export async function engage(a: Page, ids: Ids, previous?: string): Promise<string> {
  await expect(async () => {
    await parkBeside(a, ids.idB);
    // The engage carries A's signed snapshot: let a few leave from the new place first.
    const at = (await state(a)).tick;
    await a.waitForFunction((t) => (window.__bs?.state().tick ?? 0) >= t + 15, at, {
      timeout: 8_000,
    });
    await a.keyboard.press('f');
    await a.waitForFunction(
      (old) => {
        const enc = window.__bs?.state().encounter;
        return enc != null && enc.id !== old && !enc.over;
      },
      previous,
      { timeout: 4_000 },
    );
  }, 'A engages B')
    .toPass({ timeout: 40_000 })
    .catch(async (error) => {
      throw new Error(`A's fight never started: ${JSON.stringify(await seen(a))}`, {
        cause: error,
      });
    });
  return (await state(a)).encounter?.id as string;
}

/**
 * A braces by itself and follows B, page-side, until `flee` (the escape clock runs from the first
 * frame, so a chase that waits for the test loses a slow runner's fight).
 */
export async function chase(a: Page, idB: string): Promise<void> {
  await a.evaluate((who) => {
    const bs = window.__bs as BsHook;
    bs.debug?.autoBrace(true);
    const w = window as unknown as { __chase?: number };
    clearInterval(w.__chase);
    w.__chase = window.setInterval(() => {
      const r = bs.state().remotes.find((x) => x.id === who);
      if (r && bs.state().encounter?.over === false)
        void bs.debug?.steerTo({ id: who, x: r.x, y: r.y });
    }, 250);
  }, idB);
}

/** A stops chasing and swims straight away from B, so the fight ends in A's escape. */
export async function flee(a: Page, idB: string): Promise<void> {
  await a.evaluate((who) => {
    const bs = window.__bs as BsHook;
    clearInterval((window as unknown as { __chase?: number }).__chase);
    const p = bs.state().player;
    const foe = bs.state().encounter?.fighters.find((f) => f.player === who);
    if (!p || !foe) return;
    const dx = p.x - foe.x || 1;
    const dy = p.y - foe.y;
    const k = 400 / Math.hypot(dx, dy);
    void bs.debug?.steerTo({ x: p.x + dx * k, y: p.y + dy * k });
  }, idB);
}

/** Waits until the fight `id` is over on `page` (its `enc-end` applied), bounded by the fight's timeout. */
export async function waitOver(page: Page, id: string, who: string): Promise<void> {
  await page
    .waitForFunction(
      (enc) => {
        const e = window.__bs?.state().encounter;
        return e?.id === enc && e.over;
      },
      id,
      { timeout: FIGHT_WALL_MS },
    )
    .catch(async (error) => {
      throw new Error(`${who}'s fight never ended: ${JSON.stringify(await seen(page))}`, {
        cause: error,
      });
    });
}

/** Both pages end the fight `id` on the referee's hash, and on the same one. */
export async function sameEnd(a: Page, b: Page, id: string): Promise<void> {
  const [endA, endB] = [(await state(a)).encounter, (await state(b)).encounter];
  for (const enc of [endA, endB]) {
    expect(enc?.id).toBe(id);
    expect(enc?.endHash).toMatch(/^[0-9a-f]+$/);
    expect(enc?.hash).toBe(enc?.endHash);
    expect(enc?.desyncs).toBe(0);
  }
  expect(endA?.endHash).toBe(endB?.endHash);
}
