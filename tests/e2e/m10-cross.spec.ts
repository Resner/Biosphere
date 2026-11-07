import { expect, type Page, test } from '@playwright/test';
import { M10_CROSS_HUB, state } from './helpers';
import {
  APART_WU,
  available,
  closeAll,
  end,
  sameEnd,
  settled,
  type Trio,
  trio,
  witnessedFight,
} from './m10-steps';

// M10 T7, M11 T14: a witness far off in the world (ADR 0058). C swims 20,000 wu from A and B,
// past every link class and the hub's relay reach (ADR 0062), so the hub relays the duty link's
// signals only while C holds the referee duty, and C referees the fight to its end over that link.

test.describe.configure({ mode: 'serial' });

/** The link classes a page holds C in (empty when it holds no link to C). */
const classesOf = async (page: Page, id: string) =>
  (await state(page)).net.links.filter((l) => l.id === id).map((l) => l.class);

test('a witness 20,000 wu away referees a fight over its duty links alone @slow', async ({
  browser,
  request,
}) => {
  test.setTimeout(420_000);
  let t: Trio | null = null;
  try {
    t = await trio(browser, M10_CROSS_HUB, true);
    const { a, b, c, idB, idC } = t;
    const [sa, sc] = [await state(a), await state(c)];
    expect(sc.world?.id).toBe(sa.world?.id);
    const [pa, pc] = [sa.player, sc.player];
    expect(Math.hypot((pc?.x ?? 0) - (pa?.x ?? 0), (pc?.y ?? 0) - (pa?.y ?? 0))).toBeGreaterThan(
      APART_WU * 0.6,
    );
    // Once C is gone from beside them, neither fighter holds a link to it.
    for (const page of [a, b]) {
      await expect
        .poll(() => classesOf(page, idC), { message: 'the link to C closes', timeout: 20_000 })
        .toEqual([]);
    }
    await available(c);
    const { id, from } = await witnessedFight(t);

    // The fighters reach C over a duty link alone: P0, the duty's class, and no other.
    for (const page of [a, b]) {
      const s = await state(page);
      expect(s.net.dutyLinks).toContainEqual({ peer: idC, open: true, encs: [id] });
      expect(await classesOf(page, idC)).toEqual([0]);
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
