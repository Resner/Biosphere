import { expect, test } from '@playwright/test';
import { M10_WITNESS_HUB, state } from './helpers';
import {
  available,
  closeAll,
  end,
  p95,
  sameEnd,
  settled,
  type Trio,
  trio,
  witnessedFight,
} from './m10-steps';

// M10 T7: a witness referees a fight in one pond (ADR 0058). A, B and C share a pond; A engages B,
// C draws the referee duty (its pool holds C alone), opens its duty links, and takes the fight over
// from frame h: A's and B's inputs go to C signed, C's signed frames come back and its batches
// drive the authority. The fight ends on the same hash on all three pages, the settlement names C
// from h, the handover shows no resync and rollbacks of at most 2 frames, and C's duty handlers
// stay under 2 ms at the 95th percentile.

test.describe.configure({ mode: 'serial' });

test('a witness beside the fight referees a fight from the handover to its end @slow', async ({
  browser,
  request,
}) => {
  test.setTimeout(420_000);
  let t: Trio | null = null;
  try {
    t = await trio(browser, M10_WITNESS_HUB);
    const { a, b, c, idC } = t;
    expect((await state(c)).world?.id).toBe((await state(a)).world?.id);
    await available(c);
    const { id, from } = await witnessedFight(t);

    // The look, for the record: C's "Witnessing a fight" chip, and the witness's eye on A's combat
    // HUD. A screenshot loads the machine as no game frame does, so C's handlers while it is taken
    // are left out of the timing below.
    const shotFrom = (await state(c)).witness.dutyMs.length;
    for (const [page, name] of [
      [c, 'm10-witness-chip'],
      [a, 'm10-witness-mark'],
    ] as const) {
      const path = test.info().outputPath(`${name}.png`);
      await page.screenshot({ path });
      await test.info().attach(name, { path, contentType: 'image/png' });
    }
    const shotTo = (await state(c)).witness.dutyMs.length;
    await expect(c.getByTestId('hud-witness')).toBeVisible();
    await expect(a.getByTestId('witness-mark')).toBeVisible();
    await expect(a.getByTestId('witness-mark')).toHaveAttribute('title', 'Refereed by a witness');
    await end(t, id);
    const hash = await sameEnd(t, id);

    // C's copy of the fight ended on the same hash, every input it took was signed, and it batched.
    await expect
      .poll(async () => (await state(c)).witness.duty, {
        message: 'C’s duty ends',
        timeout: 20_000,
      })
      .toBeNull();
    const w = (await state(c)).witness;
    expect(w.last?.enc).toBe(id);
    expect(w.last?.from).toBe(from);
    expect(w.last?.over).toBe(true);
    expect(w.last?.hash).toBe(hash);
    expect(w.last?.dropped.forged ?? 0).toBe(0);
    expect(w.batches).toBeGreaterThan(0);
    const timed = [...w.dutyMs.slice(0, shotFrom), ...w.dutyMs.slice(shotTo)];
    expect(timed.length).toBeGreaterThan(100);
    expect(p95(timed)).toBeLessThanOrEqual(2);

    // The handover can't be seen: no resync and short rollbacks around it, on both fighters.
    for (const page of [a, b]) {
      const enc = (await state(page)).encounter;
      expect(enc?.handovers).toBe(1);
      expect(enc?.disputes).toBe(0);
      expect(enc?.witnessInputs).toBeGreaterThan(0);
      expect(enc?.aroundHandover.resyncs).toBe(0);
      expect(enc?.aroundHandover.rollback).toBeLessThanOrEqual(2);
    }

    // The settlement names C from the handover's frame, at its place in the order.
    const fight = await settled(request, M10_WITNESS_HUB, id);
    expect(fight.referees).toEqual([
      { by: 'authority', from: 0 },
      { by: idC, from, position: 0 },
    ]);
  } finally {
    if (t) await closeAll(t);
  }
});

// M10 T7: a witness that vanishes (ADR 0058). C referees A's fight with B, and C's page closes
// mid-duty. The authority hears C's socket close and takes the fight back at once, from
// `max(next, due) + 2`: the frames C had not batched are the autopilot's (at most 15, 1.5 s), A
// and B hear `enc-referee` by the authority and send their inputs to the hub again, and the fight
// ends on the authority's hash. C's offer reads `failed`, and C is struck.

test('the authority takes a fight back when its witness’s page closes @slow', async ({
  browser,
  request,
}) => {
  test.setTimeout(420_000);
  let t: Trio | null = null;
  try {
    t = await trio(browser, M10_WITNESS_HUB);
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
    const fight = await settled(request, M10_WITNESS_HUB, id);
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
    const r = await request.get(`${M10_WITNESS_HUB}/v1/e2e/witness/enc:${id}`);
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
