import { expect, test } from '@playwright/test';
import { M10_CROSS_HUB, state } from './helpers';
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

// M10 T7: a witness in another pond (ADR 0058). The hub holds two seats a pond (`POND_MAX=2`), so
// A and B share one and C sits in the next. The hub relays the duty link's signals across ponds
// while C holds the referee duty, and C referees the fight to its end over that link.

test.describe.configure({ mode: 'serial' });

test('a witness in another pond referees a fight over a cross-pond duty link @slow', async ({
  browser,
  request,
}) => {
  test.setTimeout(420_000);
  let t: Trio | null = null;
  try {
    t = await trio(browser, M10_CROSS_HUB, true);
    const { a, b, c, idB, idC } = t;
    const [pondA, pondB, pondC] = await Promise.all(
      [a, b, c].map(async (p) => (await state(p)).pond),
    );
    expect(pondA?.id).toBe(pondB?.id);
    expect(pondC?.id).not.toBe(pondA?.id);
    expect(pondA?.members).not.toContain(idC);
    await available(c);
    const { id, from } = await witnessedFight(t);

    // The fighters reach C over a duty link alone: C is no member of their pond.
    for (const page of [a, b]) {
      const s = await state(page);
      expect(s.pond?.members).not.toContain(idC);
      expect(s.net.dutyLinks).toContainEqual({ peer: idC, open: true, encs: [id] });
    }
    expect((await state(c)).net.dutyLinks.map((l) => l.peer)).toContain(idB);

    await end(t, id);
    const hash = await sameEnd(t, id);
    await expect
      .poll(async () => (await state(c)).witness.duty, {
        message: 'C’s duty ends',
        timeout: 20_000,
      })
      .toBeNull();
    const w = (await state(c)).witness;
    expect(w.last?.enc).toBe(id);
    expect(w.last?.hash).toBe(hash);
    for (const page of [a, b]) {
      const enc = (await state(page)).encounter;
      expect(enc?.witnessInputs).toBeGreaterThan(0);
      expect(enc?.aroundHandover.resyncs).toBe(0);
    }
    const fight = await settled(request, M10_CROSS_HUB, id);
    expect(fight.referees).toEqual([
      { by: 'authority', from: 0 },
      { by: idC, from, position: 0 },
    ]);
  } finally {
    if (t) await closeAll(t);
  }
});
