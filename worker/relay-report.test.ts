import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RelayReport } from '../src/net/protocol';
import type { Metrics } from './metrics';
import {
  CALM,
  type Client,
  closeSockets,
  hatch,
  login,
  nextOf,
  sql,
  stub,
  useFakeBeacons,
} from './test-hub';
import { DAY_MS, type UsageMeter } from './usage';

// M13 T4 (ADR 0067): a page's `progress` carries its relay report, which the meter counts, its KB
// clamped to 4 KB/s per reported link over the seconds since the session's last counted report (at
// most 60 s). Each test lives on a day of its own (a mocked `Date.now`).

interface Inside {
  usage: UsageMeter;
  metrics(): Metrics;
}

const inside = <T>(fn: (o: Inside) => T): Promise<T> =>
  runInDurableObject(stub(), (o) => fn(o as unknown as Inside));

let dayNo = 0;
let wall = 0;

beforeEach(async () => {
  await useFakeBeacons();
  dayNo++;
  wall = Date.UTC(2033, 0, 1, 10, 0, 0) + dayNo * 3 * DAY_MS;
  vi.spyOn(Date, 'now').mockImplementation(() => wall);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeSockets();
});

const relayToday = () => inside((o) => o.usage.today(wall).relay);

/** A hatched player, so its reports are taken. */
async function player(): Promise<Client> {
  const { c, id } = await login();
  await hatch(c, id);
  return c;
}

let n = 0;
/** Sends a `progress` (with `relay` when given) and waits for its `ack`. */
async function progress(c: Client, relay?: RelayReport): Promise<void> {
  n++;
  c.send({ t: 'progress', n, ticks: 0, ...CALM, ...(relay ? { relay } : {}) });
  const ack = await nextOf(c, 'ack');
  expect(ack.n).toBe(n);
}

describe('relay reports', () => {
  it('clamps a report of 16,384 KB over 2 links, 10 s after the last, to 80 KB', async () => {
    const c = await player();
    // The first report since the session opened, at once: no time, so no KB.
    await progress(c, { links: 2, relayed: 2, kb: 500 });
    expect(await relayToday()).toEqual({ reports: 1, links: 2, relayed: 2, kb: 0 });
    wall += 10_000;
    await progress(c, { links: 2, relayed: 2, kb: 16_384 });
    expect(await relayToday()).toEqual({ reports: 2, links: 4, relayed: 4, kb: 80 });
  });

  it('allows at most 60 s since the last counted report, and takes a report under the clamp as it is', async () => {
    const c = await player();
    await progress(c, { links: 1, relayed: 0, kb: 0 });
    wall += 600_000;
    await progress(c, { links: 1, relayed: 1, kb: 16_384 });
    expect((await relayToday()).kb).toBe(240);
    wall += 30_000;
    await progress(c, { links: 3, relayed: 1, kb: 7 });
    expect(await relayToday()).toEqual({ reports: 3, links: 5, relayed: 2, kb: 247 });
  });

  it('takes a progress without relay as before, and counts nothing for it', async () => {
    const c = await player();
    await progress(c);
    wall += 10_000;
    await progress(c);
    expect(await relayToday()).toEqual({ reports: 0, links: 0, relayed: 0, kb: 0 });
    // The clamp runs from the last counted report: the session's opening here.
    await progress(c, { links: 1, relayed: 1, kb: 100 });
    expect((await relayToday()).kb).toBe(40);
  });

  it('sums the reports into the day’s row and /v1/metrics', async () => {
    // Earlier tests' days may lie in this month too.
    const before = (await inside((o) => o.metrics())).month.relayKb;
    const a = await player();
    const b = await player();
    wall += 20_000;
    await progress(a, { links: 2, relayed: 1, kb: 30 });
    await progress(b, { links: 3, relayed: 0, kb: 0 });
    wall += 20_000;
    await progress(a, { links: 2, relayed: 1, kb: 50 });
    const expected = { reports: 3, links: 7, relayed: 2, kb: 80 };
    const m = await inside((o) => o.metrics());
    expect(m.today.relay).toEqual(expected);
    expect(m.month.relayKb).toBe(before + 80);
    await inside((o) => o.usage.flush(wall));
    const [row] = await sql<{
      relay_reports: number;
      relay_links: number;
      relay_relayed: number;
      relay_kb: number;
    }>(
      'SELECT relay_reports, relay_links, relay_relayed, relay_kb FROM usage WHERE day = ?',
      m.today.day,
    );
    expect(row).toEqual({ relay_reports: 3, relay_links: 7, relay_relayed: 2, relay_kb: 80 });
    // The next day's month holds this day's row.
    const nextDay = Math.floor(wall / DAY_MS) * DAY_MS + DAY_MS + 1000;
    expect(new Date(nextDay).getUTCMonth()).toBe(new Date(wall).getUTCMonth());
    wall = nextDay;
    expect((await inside((o) => o.metrics())).month.relayKb).toBe(before + 80);
  });
});
