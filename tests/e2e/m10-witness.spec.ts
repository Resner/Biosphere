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

test('a witness in the pond referees a fight from the handover to its end @slow', async ({
  browser,
  request,
}) => {
  test.setTimeout(420_000);
  let t: Trio | null = null;
  try {
    t = await trio(browser, M10_WITNESS_HUB);
    const { a, b, c, idC } = t;
    expect((await state(c)).pond?.id).toBe((await state(a)).pond?.id);
    await available(c);
    const { id, from } = await witnessedFight(t);
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
    expect(p95(w.dutyMs)).toBeLessThanOrEqual(2);

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
