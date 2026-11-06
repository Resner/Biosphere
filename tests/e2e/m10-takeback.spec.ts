import { expect, test } from '@playwright/test';
import { M10_TAKEBACK_HUB, state } from './helpers';
import {
  available,
  closeAll,
  end,
  sameEnd,
  settled,
  type Trio,
  trio,
  witnessedFight,
} from './m10-steps';

// M10 T7: a witness that vanishes (ADR 0058). C referees A's fight with B, and C's page closes
// mid-duty. The authority hears C's socket close and takes the fight back at once, from
// `max(next, due) + 2`: the frames C had not batched are the autopilot's (at most 15, 1.5 s), A
// and B hear `enc-referee` by the authority and send their inputs to the hub again, and the fight
// ends on the authority's hash. C's offer reads `failed`, and C is struck.

test.describe.configure({ mode: 'serial' });

test('the authority takes a fight back when its witness’s page closes @slow', async ({
  browser,
  request,
}) => {
  test.setTimeout(420_000);
  let t: Trio | null = null;
  try {
    t = await trio(browser, M10_TAKEBACK_HUB);
    const { a, b, c, idC } = t;
    await available(c);
    const { id, from } = await witnessedFight(t);
    await c.context().close();

    // Both fighters hear the take-back, while the fight still runs.
    for (const page of [a, b]) {
      await page
        .waitForFunction(
          (enc) => {
            const e = window.__bs?.state().encounter;
            return e?.id === enc && (e.referee.by === 'authority' || e.over);
          },
          id,
          { timeout: 20_000 },
        )
        .catch(async (error) => {
          throw new Error(
            `no take-back: ${JSON.stringify((await state(page)).encounter?.referee)}`,
            {
              cause: error,
            },
          );
        });
    }
    const back = (await state(a)).encounter?.referee;
    expect(back?.by).toBe('authority');
    const until = back?.from as number;
    expect(until).toBeGreaterThan(from);
    expect((await state(b)).encounter?.referee).toEqual(back);

    await end(t, id);
    await sameEnd(t, id);
    // C's frames it never batched differ from the autopilot's: a fighter may dispute them, and the
    // authority, which holds no batch of C's for them, drops the dispute (C is struck once, below).
    for (const page of [a, b]) expect((await state(page)).encounter?.handovers).toBe(2);

    // The settlement shows the take-back, and the autopilot filled at most 15 frames of C's span.
    const fight = await settled(request, M10_TAKEBACK_HUB, id);
    expect(fight.referees).toEqual([
      { by: 'authority', from: 0 },
      { by: idC, from, position: 0 },
      { by: 'authority', from: until },
    ]);
    let fallback = 0;
    for (let f = until - 1; f >= from && fight.frames[f]?.every((i) => i === null); f--) fallback++;
    expect(fallback).toBeGreaterThan(0);
    expect(fallback).toBeLessThanOrEqual(15);

    // C's offer failed, and C is struck.
    const r = await request.get(`${M10_TAKEBACK_HUB}/v1/e2e/witness/enc:${id}`);
    expect(r.ok()).toBe(true);
    const view = (await r.json()) as {
      offers: { position: number; player: string; role: string; outcome: string }[];
      struck: string[];
    };
    expect(view.offers).toContainEqual({
      position: 0,
      player: idC,
      role: 'referee',
      outcome: 'failed',
    });
    expect(view.struck).toContain(idC);
  } finally {
    if (t) await closeAll(t);
  }
});
