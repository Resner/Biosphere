import type { APIRequestContext, Browser, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { percentile } from '../../src/render/post/benchmark';
import { clickHatch, state, waitPlaying } from './helpers';
import { open, seen, stage } from './m7-fight';
import { chase, engage, flee, waitOver } from './m8-fight';

// Shared by the M10 witness specs (M10 T7): three players, a fight between A and B, and C, who
// may referee it (`WITNESS_PLAY_MS=0`, `WITNESS_IP_CHECK=off` on the hub). C's pool has C alone, so
// the drand order puts it first, and the referee duty is C's to take.

export interface Trio {
  a: Page;
  b: Page;
  c: Page;
  idA: string;
  idB: string;
  idC: string;
}

/** What the test reads of a page's witness side, for a failure's message. */
export const witnessSeen = (page: Page) =>
  page.evaluate(() => {
    const s = (window.__bs as BsHook).state();
    return {
      witness: { ...s.witness, dutyMs: s.witness.dutyMs.length },
      dutyLinks: s.net.dutyLinks,
      pond: s.pond?.id,
      encounter: s.encounter && {
        id: s.encounter.id,
        frame: s.encounter.frame,
        over: s.encounter.over,
        referee: s.encounter.referee,
        handovers: s.encounter.handovers,
      },
    };
  });

async function hatch(page: Page): Promise<void> {
  await clickHatch(page);
  await waitPlaying(page);
}

/**
 * A and B hatch and are staged for a fight, B whole; C hatches too, in their pond, or with `apart`
 * once A and B hold theirs (a hub with `POND_MAX=2` then seats C in another pond).
 */
export async function trio(browser: Browser, hub: string, apart = false): Promise<Trio> {
  const a = await open(browser, hub);
  const b = await open(browser, hub);
  let c: Page;
  let ids: { idA: string; idB: string };
  if (apart) {
    ids = await stage(a, b, undefined, 1);
    c = await open(browser, hub);
    await hatch(c);
  } else {
    c = await open(browser, hub);
    [ids] = await Promise.all([stage(a, b, undefined, 1), hatch(c)]);
  }
  // `stage` reloads B, which draws again: every page here skips its draw.
  await b.evaluate(() => (window.__bs as BsHook).debug?.skipDraw(true));
  const idC = (await state(c)).playerId as string;
  return { a, b, c, ...ids, idC };
}

/** C tells the hub it can witness (5 s of fast frames, visible, not fighting). */
export async function available(c: Page): Promise<void> {
  await expect
    .poll(async () => (await state(c)).witness.avail, {
      message: 'C offers to witness',
      timeout: 60_000,
    })
    .toBe(true);
}

/** A engages B, both brace by themselves, and A chases B, so the fight runs until `flee`. Returns its id. */
export async function fight(t: Trio, previous?: string): Promise<string> {
  await t.b.evaluate(() => (window.__bs as BsHook).debug?.autoBrace(true));
  const id = await engage(t.a, t, previous);
  await chase(t.a, t.idB);
  return id;
}

/**
 * C referees fight `id` and has finalized `frames` frames, A and B heard the handover, and C's
 * chip shows. Returns C's first frame, or null when the fight ended first.
 */
export async function refereed(t: Trio, id: string, frames = 30): Promise<number | null> {
  const { a, b, c, idC } = t;
  const over = async () => {
    const enc = (await state(a)).encounter;
    return enc?.id !== id || enc.over;
  };
  await expect
    .poll(
      async () => {
        if (await over()) return 'over';
        const sc = await state(c);
        const duty = sc.witness.duty;
        if (duty?.enc !== id || duty.phase !== 'refereeing' || duty.frames < frames) return 'wait';
        if (!sc.hud.chips.includes('witness')) return 'no chip';
        for (const page of [a, b]) {
          const enc = (await state(page)).encounter;
          if (enc?.referee.by !== idC || enc.referee.from !== duty.from) return 'wait';
        }
        return 'refereed';
      },
      { message: `C referees fight ${id}, or it ends`, timeout: 60_000 },
    )
    .toMatch(/^(over|refereed)$/)
    .catch(async (error) => {
      throw new Error(
        `C never refereed: ${JSON.stringify({ a: await witnessSeen(a), b: await witnessSeen(b), c: await witnessSeen(c), seen: await seen(a) })}`,
        { cause: error },
      );
    });
  if (await over()) return null;
  return (await state(c)).witness.duty?.from ?? null;
}

/** A fight C referees: tried up to 3 times, since a fight can end before the handover. Returns its id and C's first frame. */
export async function witnessedFight(t: Trio): Promise<{ id: string; from: number }> {
  let previous: string | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (previous) await waitOver(t.a, previous, 'A');
    const id = await fight(t, previous);
    const from = await refereed(t, id);
    if (from !== null) return { id, from };
    previous = id;
  }
  throw new Error(`no fight was refereed by C: ${JSON.stringify(await witnessSeen(t.c))}`);
}

/** A swims off, and the fight ends on A's and B's pages. */
export async function end(t: Trio, id: string): Promise<void> {
  await flee(t.a, t.idB);
  await waitOver(t.a, id, 'A');
  await waitOver(t.b, id, 'B');
}

/** A and B end the fight on its `enc-end`'s hash, with no desync. Returns that hash. */
export async function sameEnd(t: Trio, id: string): Promise<string> {
  const hashes: string[] = [];
  for (const page of [t.a, t.b]) {
    const enc = (await state(page)).encounter;
    expect(enc?.id).toBe(id);
    expect(enc?.endHash).toMatch(/^[0-9a-f]+$/);
    expect(enc?.hash).toBe(enc?.endHash);
    expect(enc?.desyncs).toBe(0);
    hashes.push(enc?.endHash as string);
  }
  expect(hashes[1]).toBe(hashes[0]);
  return hashes[0] as string;
}

/** A settled fight as `GET /v1/fight/<enc>` serves it: the spans and its log's frames. */
export interface Settled {
  referees: { by: string; from: number; position?: number }[];
  frames: (number | null)[][];
}

/** Waits until the authority has settled fight `id`, then reads its settlement and log. */
export async function settled(request: APIRequestContext, hub: string, id: string) {
  await expect
    .poll(
      async () => {
        const r = await request.get(`${hub}/v1/e2e/encounter/${id}`);
        return r.ok() ? ((await r.json()) as { settled: boolean }).settled : false;
      },
      { message: `the authority settles fight ${id}`, timeout: 60_000 },
    )
    .toBe(true);
  const r = await request.get(`${hub}/v1/fight/${id}`);
  expect(r.ok()).toBe(true);
  const body = (await r.json()) as {
    settlement: { settlement: { v: number; referees?: Settled['referees'] } };
    log: { frames: Settled['frames'] } | null;
  };
  return {
    referees: body.settlement.settlement.referees ?? [],
    frames: body.log?.frames ?? [],
  } satisfies Settled;
}

/** The 95th percentile of `ms`. */
export function p95(ms: readonly number[]): number {
  return percentile(ms, 0.95);
}

/** Every page of the trio closes. */
export async function closeAll(t: Partial<Trio>): Promise<void> {
  await Promise.all(
    [t.a, t.b, t.c].map((page) =>
      page
        ?.context()
        .close()
        .catch(() => {}),
    ),
  );
}
