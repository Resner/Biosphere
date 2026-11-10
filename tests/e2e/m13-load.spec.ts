import { expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { CLOSE_RATE_LIMITED } from '../../src/net/protocol';
import { MEASURED } from '../../worker/plan';
import { LoadClient } from '../load-client';
import { clickHatch, openRecorded, playerOf, state, waitPlaying } from './helpers';

// M13 T11: a real page's cadence against the capacity model, on one hub (8837, the witness
// variables, because every client shares localhost). 40 headless clients (T7's) join around the
// world's centre over 30 s (answering no offers), then pages A and B hatch among them, move 40,000
// wu out into the twilight within reach of each other, and play for 3 minutes after their first
// seated minute. The checks are upper bounds only, since a slow runner sends
// fewer messages, never more:
// - per page: incoming messages per minute at most 1.5 times `MEASURED.page.total`, and each of
//   `where`, `progress`, `ping`, `signal` and `avail` at most 1.5 times the model's rate, plus 1;
// - hub-wide: request-equivalents per seated player-minute at most 1, and the meter's messages
//   equal to the sessions' received count within 2%;
// - clean: no socket closed for its rate, no `where` dropped and no audit flag after the founders (bar the plausibility kinds below).

const HUB = 'http://localhost:8837';
const WS = 'ws://localhost:8837/v1/hub';
const CLIENTS = 40;
/** The clients that hatch together first: the world's first creatures have nobody to audit them. */
const FOUNDERS = 8;
const JOIN_MS = 30_000;
const SETTLE_MS = 60_000;
const WINDOW_MS = 180_000;
const OFFERS_PER_MINUTE = 2;
const SLACK = 1.5;
/** The world's centre, where the hub's ring of spawns sits (ADR 0061). */
const CENTRE = 131_072;
/** How far from the centre the pages swim, well outside the clients' wandering. */
const APART_WU = 40_000;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** Past midnight by this much, so the meter's new day has begun when the window starts. */
const MIDNIGHT_MARGIN_MS = 5000;
/** The one flag kind the check leaves out: a pond this small has no witness pool to audit with. */
const NOT_A_FAULT = 'authority-only';

test.describe.configure({ mode: 'serial' });

interface Seated {
  id: string;
  name: string;
  seatedAt: number;
  received: number;
  byType: Record<string, number>;
}
interface Meter {
  today: { requests: number; messages: number; playerMs: number };
}
interface Sample {
  at: number;
  sessions: Seated[];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const getJson = async <T>(path: string): Promise<T> => {
  const res = await fetch(`${HUB}${path}`);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return (await res.json()) as T;
};
const sample = async (): Promise<Sample> => ({
  at: Date.now(),
  sessions: await getJson<Seated[]>('/v1/e2e/sessions'),
});
const flagsOf = async (): Promise<Record<string, number>> =>
  (await getJson<{ day: Record<string, number> } | null>('/v1/e2e/audit'))?.day ?? {};

/**
 * Plays until `stop` is set: swims to the nearest food while the belly is under 60% of the fullest
 * it has been, and rests otherwise, so it neither starves nor swims at full throttle throughout
 * (a leaf crossing is a `where`).
 */
async function swim(page: Page, turn: number, stop: { done: boolean }): Promise<void> {
  let fullest = 0;
  for (let leg = 0; !stop.done; leg++) {
    const p = await playerOf(page);
    fullest = Math.max(fullest, p.energy);
    const hungry = p.energy < fullest * 0.6;
    const heading = turn + leg * 1.7;
    const away = { x: p.x + Math.cos(heading) * 400, y: p.y + Math.sin(heading) * 400 };
    if (!hungry) {
      // Resting, as a fed player does: coasting reports less than full throttle across leaves.
      await page.waitForTimeout(2000);
      continue;
    }
    await page.evaluate(
      ([fallback]) => {
        const debug = (window.__bs as BsHook).debug;
        return debug?.steerTo(debug.nearestFood() ?? (fallback as { x: number; y: number }));
      },
      [away] as const,
    );
  }
}

test('two pages among 40 headless clients send no more than the model says @slow', async ({
  browser,
}) => {
  test.setTimeout(900_000);
  const pages: Page[] = [];
  const clients: LoadClient[] = [];
  const failures: string[] = [];
  const stop = { done: false };
  // Identities that no earlier run on this hub (a repeat, or a local re-run on its saved store) has used: a returning client brings its old life's clock, which the audit flags.
  const runBase = (Math.floor(Date.now() / 1000) % 100_000) * 100;
  try {
    const join = (i: number): Promise<void> => {
      const client = new LoadClient({
        url: WS,
        index: runBase + i,
        offersPerMinute: OFFERS_PER_MINUTE,
        answerOffers: false,
      });
      clients.push(client);
      return client.start().catch((e: unknown) => {
        failures.push(`client ${i}: ${e instanceof Error ? e.message : String(e)}`);
      });
    };

    // The founders hatch together; whatever the audit flags after them is the test's to keep clean.
    await Promise.all(Array.from({ length: FOUNDERS }, (_, i) => join(i)));
    const founderFlags = await flagsOf();
    const joins: Promise<void>[] = [];
    const t0 = Date.now();
    for (let i = FOUNDERS; i < CLIENTS; i++) {
      await sleep(Math.max(0, t0 + (JOIN_MS * (i - FOUNDERS)) / (CLIENTS - FOUNDERS) - Date.now()));
      joins.push(join(i));
    }
    await Promise.all(joins);
    expect(failures, 'every headless client joined').toEqual([]);
    expect(clients.filter((c) => c.inWater)).toHaveLength(CLIENTS);

    // Pages A and B hatch among them.
    const ids: string[] = [];
    for (const name of ['A', 'B']) {
      const page = await (await browser.newContext()).newPage();
      pages.push(page);
      await openRecorded(page, '', HUB);
      await clickHatch(page);
      await waitPlaying(page);
      ids.push((await state(page)).playerId as string);
      expect(name).toBeTruthy();
    }

    // The headless clients answer no offers, so a page that saw them would dial peers that never
    // link and redial them as its backoff allows: the cadence of a world of unreachable peers, not
    // the model's. The pages swim apart from them (fixture mode takes the jump), within reach of
    // each other, so their one link is real.
    let at = { x: CENTRE + APART_WU, y: CENTRE };
    for (const page of pages) {
      at = await page.evaluate(
        ([x, y]) => {
          const debug = (window.__bs as BsHook).debug;
          debug?.teleport(x as number, y as number);
          return debug?.setZone('twilight') ?? { x: x as number, y: y as number };
        },
        [at.x + 300, at.y],
      );
    }

    // Both swim from the moment they play; the count starts one seated minute in.
    const swimming = pages.map((page, i) => swim(page, i * Math.PI, stop));
    const seatedAt = Math.max(
      ...(await sample()).sessions.filter((s) => ids.includes(s.id)).map((s) => s.seatedAt),
    );
    await sleep(Math.max(0, seatedAt + SETTLE_MS - Date.now()));
    // The meter's `today` restarts at 00:00 UTC (`E2E main` ran this across it: 1,068 counted
    // against 1,969 received). A window that would cross it starts just after instead.
    const toMidnight = DAY_MS - (Date.now() % DAY_MS);
    if (toMidnight < WINDOW_MS + MIDNIGHT_MARGIN_MS) await sleep(toMidnight + MIDNIGHT_MARGIN_MS);
    const [from, begin] = await Promise.all([sample(), getJson<Meter>('/v1/e2e/metrics')]);
    await sleep(WINDOW_MS);
    const [to, end, dropped, flags] = await Promise.all([
      sample(),
      getJson<Meter>('/v1/e2e/metrics'),
      getJson<Record<string, number>>('/v1/e2e/dropped'),
      flagsOf(),
    ]);
    stop.done = true;
    await Promise.all(swimming);

    // Per page.
    const minutes = (to.at - from.at) / MINUTE_MS;
    const model: Record<string, number> = {
      where: MEASURED.page.where,
      progress: MEASURED.page.progress,
      ping: MEASURED.page.ping,
      signal: MEASURED.page.signal,
      avail: MEASURED.page.avail,
    };
    for (const id of ids) {
      const a = from.sessions.find((s) => s.id === id);
      const b = to.sessions.find((s) => s.id === id);
      expect(a && b, `page ${id} stayed seated`).toBeTruthy();
      if (!a || !b) return;
      const rate = (n: number) => n / minutes;
      const seen = Object.fromEntries(
        Object.keys({ ...a.byType, ...b.byType }).map((t) => [
          t,
          rate((b.byType[t] ?? 0) - (a.byType[t] ?? 0)),
        ]),
      );
      const note = `page ${id}: ${JSON.stringify(seen)} a minute`;
      expect(rate(b.received - a.received), note).toBeLessThanOrEqual(SLACK * MEASURED.page.total);
      for (const [type, per] of Object.entries(model)) {
        expect(seen[type] ?? 0, `${type}, ${note}`).toBeLessThanOrEqual(SLACK * per + 1);
      }
    }

    // Hub-wide.
    const requests = end.today.requests - begin.today.requests;
    const playerMinutes = (end.today.playerMs - begin.today.playerMs) / MINUTE_MS;
    expect(playerMinutes).toBeGreaterThan(0);
    expect(
      requests / playerMinutes,
      'request-equivalents per seated player-minute',
    ).toBeLessThanOrEqual(1);
    // The same window on both sides: what the meter counted, and what the seated sessions received.
    const counted = end.today.messages - begin.today.messages;
    const received = to.sessions.reduce(
      (n, s) => n + s.received - (from.sessions.find((f) => f.id === s.id)?.received ?? s.received),
      0,
    );
    expect(
      Math.abs(counted - received) / received,
      `the meter ${counted}, sessions ${received}`,
    ).toBeLessThanOrEqual(0.02);

    // Clean.
    const closed = clients.reduce(
      (n, c) => n + (c.stats.closes[String(CLOSE_RATE_LIMITED)] ?? 0),
      0,
    );
    expect(closed, 'sockets closed for their rate').toBe(0);
    for (const page of pages) {
      expect(await page.evaluate(() => (window.__bs as BsHook).state().net.status)).toBe('online');
    }
    expect(dropped.where ?? 0, 'where messages dropped').toBe(0);
    // A page that plays honestly raises no flag (M14 T2: `worker/honest-pages.test.ts`); any kind
    // but `authority-only` is a failure.
    const real = (r: Record<string, number>) =>
      Object.entries(r).filter(([kind]) => kind !== NOT_A_FAULT);
    const founders = new Map(real(founderFlags));
    const raised = real(flags).filter(([kind, n]) => n > (founders.get(kind) ?? 0));
    expect(raised, `audit flags after the founders (${JSON.stringify(flags)})`).toEqual([]);
  } finally {
    stop.done = true;
    for (const c of clients) c.leave();
  }
});
