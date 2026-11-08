import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Identity } from '../src/ledger/identity';
import type { HubMsg } from '../src/net/protocol';
import type { RowCounter } from './metered-sql';
import type { Metrics } from './metrics';
import { FREE, PAID } from './plan';
import {
  type Client,
  closeSockets,
  flush,
  freshLine,
  login,
  nextOf,
  signIn,
  stub,
} from './test-hub';
import { DAY_MS, type UsageMeter } from './usage';

// M13 T9 (ADR 0067): admission by plan. Three reasons, a measured wait, seats kept, the TURN guard.
// Each test lives in a month of its own (a mocked `Date.now`), so the meter's day and month start
// empty, and the line's memory starts fresh (`freshLine`).

interface Inside {
  usage: UsageMeter & { storedBytes?: () => number };
  env: Record<string, string | undefined>;
  rowCount: RowCounter;
  turn: { reset(): void };
  metrics(): Metrics;
  rearm(): Promise<void>;
}

const inside = <T>(fn: (o: Inside) => T): Promise<T> =>
  runInDurableObject(stub(), (o) => fn(o as unknown as Inside));

const set = (vars: Record<string, string | undefined>) =>
  inside((o) => {
    Object.assign(o.env, vars);
  });
const admissionNow = async () => (await inside((o) => o.metrics())).admission;

let monthNo = 0;
let wall = 0;
/** Seconds from `wall` to the next 00:00 UTC. */
const toMidnight = () => (Math.floor(wall / DAY_MS) * DAY_MS + DAY_MS - wall) / 1000;

beforeEach(async () => {
  monthNo++;
  wall = Date.UTC(2036, monthNo, 15, 10, 0, 0);
  vi.spyOn(Date, 'now').mockImplementation(() => wall);
  await freshLine();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeSockets();
  await inside(async (o) => {
    for (const k of ['MAX_SESSIONS', 'DAILY_REQUEST_BUDGET', 'PLAN', 'CF_TURN_KEY_ID'])
      delete o.env[k];
    delete o.env.CF_TURN_KEY_API_TOKEN;
    delete o.usage.storedBytes;
    o.turn.reset();
    await o.rearm();
  });
});

/** Signs in and expects a place in line rather than a welcome. */
async function queueUp(id?: Identity) {
  const { c, id: who } = await signIn(id);
  const msg = await c.next();
  if (msg.t !== 'queued') throw new Error(`expected queued, got ${msg.t}`);
  return { c, id: who, msg };
}

/** Closes a seated socket, as a page that leaves does, once the hub has seen it. */
async function leave(c: Client): Promise<void> {
  c.ws.close(1000, 'bye');
  await c.closed;
}

/** Each guard tripped on the live object: a cap of 1 (with someone seated), 90% of the day's requests, a database at 90% of the plan's. */
const GUARDS = {
  full: () => set({ MAX_SESSIONS: '1' }),
  budget: async () => {
    await set({ DAILY_REQUEST_BUDGET: '1000' });
    await inside((o) => {
      for (let i = 0; i < 18_000; i++) o.usage.message(wall);
    });
  },
  storage: () =>
    inside((o) => {
      o.usage.storedBytes = () => 0.9 * FREE.storageBytes;
    }),
} as const;

describe('full', () => {
  it('queues the 4th of a cap of 3 for 30 s, and says so in the metrics', async () => {
    await set({ MAX_SESSIONS: '3' });
    await Promise.all([login(), login(), login()]);
    const { msg } = await queueUp();
    expect(msg).toEqual({ t: 'queued', position: 1, etaS: 30, why: 'full' });
    expect(await admissionNow()).toEqual({
      open: false,
      why: 'full',
      turn: true,
      seatEveryS: 30,
      waits: null,
    });
  });

  it('measures the wait from the seats freed: place × 20 s after seats free every 20 s', async () => {
    await set({ MAX_SESSIONS: '3' });
    const seated = [await login(), await login(), await login()];
    for (const { c } of seated) {
      wall += 20_000;
      await leave(c);
      await login();
    }
    expect((await queueUp()).msg).toMatchObject({ position: 1, why: 'full' });
    const second = (await queueUp()).msg;
    expect(second).toMatchObject({ position: 2, why: 'full' });
    if (second.t !== 'queued') return;
    expect(Math.abs(second.etaS - 40)).toBeLessThanOrEqual(1);
    const third = (await queueUp()).msg;
    if (third.t !== 'queued') return;
    expect(Math.abs(third.etaS - 60)).toBeLessThanOrEqual(1);
    expect((await admissionNow()).seatEveryS).toBe(20);
  });

  it('tells the first in line its measured wait', async () => {
    await set({ MAX_SESSIONS: '3' });
    const seated = [await login(), await login(), await login()];
    for (const { c } of seated.slice(0, 2)) {
      wall += 20_000;
      await leave(c);
      await login();
    }
    const { msg } = await queueUp();
    if (msg.t !== 'queued') return;
    expect(Math.abs(msg.etaS - 20)).toBeLessThanOrEqual(1);
  });

  it('seats the line in order, and counts each wait in the metrics', async () => {
    await set({ MAX_SESSIONS: '1' });
    const a = await login();
    const line = [await queueUp(), await queueUp(), await queueUp()];
    expect(line.map((w) => w.msg)).toMatchObject([
      { position: 1 },
      { position: 2 },
      { position: 3 },
    ]);
    let holder = a.c;
    for (const [i, w] of line.entries()) {
      wall += 10_000;
      await leave(holder);
      await nextOf(w.c, 'welcome');
      // Everyone behind moves up one place.
      for (const behind of line.slice(i + 1))
        expect(await nextOf(behind.c, 'queued')).toMatchObject({
          position: line.indexOf(behind) - i,
        });
      holder = w.c;
    }
    const { waits } = await admissionNow();
    expect(waits).toEqual({ n: 3, p50: 20, p95: 30 });
  });
});

describe('budget', () => {
  it('queues past 90% of the day’s requests until the next 00:00 UTC', async () => {
    await GUARDS.budget();
    const first = (await queueUp()).msg;
    expect(first).toMatchObject({ position: 1, why: 'budget' });
    if (first.t !== 'queued') return;
    expect(Math.abs(first.etaS - toMidnight())).toBeLessThanOrEqual(1);
    const second = (await queueUp()).msg;
    if (second.t !== 'queued') return;
    // Behind the first: one interval more (30 s before two seats have freed).
    expect(Math.abs(second.etaS - toMidnight() - 30)).toBeLessThanOrEqual(1);
    expect(await admissionNow()).toMatchObject({ open: false, why: 'budget' });
  });

  it.each([
    {
      label: 'rows written',
      push: (o: Inside) => (o.rowCount.written += 0.9 * FREE.rowsWrittenPerDay),
    },
    { label: 'rows read', push: (o: Inside) => (o.rowCount.read += 0.9 * FREE.rowsReadPerDay) },
  ])('queues at 90 percent of the day’s $label', async ({ push }) => {
    expect((await queueUpOrSeat()).t).toBe('welcome');
    await inside(push);
    const { msg } = await queueUp();
    expect(msg).toMatchObject({ position: 1, why: 'budget' });
    if (msg.t !== 'queued') return;
    expect(Math.abs(msg.etaS - toMidnight())).toBeLessThanOrEqual(1);
    expect((await admissionNow()).why).toBe('budget');
  });

  it('seats the line in order at 00:00 UTC on the queue tick', async () => {
    await set({ MAX_SESSIONS: '2' });
    await login();
    await GUARDS.budget();
    const line = [await queueUp(), await queueUp(), await queueUp()];
    wall = Math.floor(wall / DAY_MS) * DAY_MS + DAY_MS + 1_000;
    await runDurableObjectAlarm(stub());
    // One seat was free: the first takes it, and the others wait for the cap now.
    await nextOf(line[0]?.c as Client, 'welcome');
    expect(await nextOf(line[1]?.c as Client, 'queued')).toMatchObject({
      position: 1,
      why: 'full',
    });
    expect(await nextOf(line[2]?.c as Client, 'queued')).toMatchObject({
      position: 2,
      why: 'full',
    });
  });
});

/** Signs in and answers the first thing the hub says (a welcome or a place in line). */
async function queueUpOrSeat(): Promise<HubMsg> {
  const { c } = await signIn();
  return c.next();
}

describe('storage', () => {
  it('queues with no estimate once the database reaches 90% of the plan’s storage', async () => {
    await GUARDS.storage();
    const { msg } = await queueUp();
    expect(msg).toEqual({ t: 'queued', position: 1, etaS: 0, why: 'storage' });
    expect(await admissionNow()).toMatchObject({ open: false, why: 'storage' });
  });

  it('checks storage before the budget and the budget before the cap', async () => {
    await login();
    await GUARDS.full();
    expect((await admissionNow()).why).toBe('full');
    await GUARDS.budget();
    expect((await admissionNow()).why).toBe('budget');
    await GUARDS.storage();
    expect((await admissionNow()).why).toBe('storage');
  });
});

describe('seats are kept', () => {
  it.each(Object.keys(GUARDS) as (keyof typeof GUARDS)[])(
    'drops and re-queues nobody seated when %s trips',
    async (guard) => {
      const a = await login();
      const b = await login();
      await GUARDS[guard]();
      await queueUp();
      wall += 15_000;
      await runDurableObjectAlarm(stub());
      for (const { c } of [a, b]) {
        expect(await flush(c)).toEqual([]);
        c.send({ t: 'history' });
        expect((await nextOf(c, 'history')).t).toBe('history');
      }
    },
  );

  it.each(Object.keys(GUARDS) as (keyof typeof GUARDS)[])(
    'seats a reload within 2 minutes past %s, and lines up one after',
    async (guard) => {
      const a = await login();
      if (guard === 'full') {
        // The cap is 1 and someone else waits: a's seat goes to it when a leaves.
        await set({ MAX_SESSIONS: '1' });
        const waiting = await queueUp();
        await leave(a.c);
        await nextOf(waiting.c, 'welcome');
      } else {
        await GUARDS[guard]();
        await leave(a.c);
      }
      wall += 119_000;
      const back = await login(a.id);
      expect(back.life.t).toBe('life');
      await leave(back.c);
      wall += 121_000;
      const late = await queueUp(a.id);
      expect(late.msg).toMatchObject({ position: 1, why: guard });
    },
  );
});

describe('the wait is honest', () => {
  it('seats each waiter within 30% of the first estimate it heard, with departures every 20 s', async () => {
    await set({ MAX_SESSIONS: '3' });
    const t0 = wall;
    const seated: Client[] = [];
    for (let i = 0; i < 3; i++) seated.push((await login()).c);
    const line: { c: Client; joined: number; eta: number; checked: boolean }[] = [];
    for (let i = 0; i < 2; i++) {
      const { c, msg } = await queueUp();
      line.push({ c, joined: wall, eta: msg.t === 'queued' ? msg.etaS : -1, checked: false });
    }
    const offsets = [3, 9, 14, 18, 6, 11];
    let checked = 0;
    for (let k = 1; k <= 15; k++) {
      wall = t0 + k * 20_000;
      await leave(seated.shift() as Client);
      const next = line.shift();
      if (!next) throw new Error('the line ran dry');
      await nextOf(next.c, 'welcome');
      seated.push(next.c);
      if (next.checked) {
        const waited = (wall - next.joined) / 1000;
        expect(
          Math.abs(waited - next.eta),
          `waited ${waited} s, told ${next.eta} s`,
        ).toBeLessThanOrEqual(0.3 * next.eta);
        checked++;
      }
      if (k >= 2) {
        wall += (offsets[k % offsets.length] as number) * 1000;
        const { c, msg } = await queueUp();
        line.push({ c, joined: wall, eta: msg.t === 'queued' ? msg.etaS : -1, checked: true });
      }
    }
    expect(checked).toBeGreaterThanOrEqual(10);
  });
});

describe('TURN', () => {
  const TURN_ENTRY = { urls: ['turn:turn.cloudflare.com:3478'], username: 'u', credential: 'c' };
  const STUN = ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'];
  /** KB at the free plan's 90%: 900 GB of 1,000,000 KB. */
  const LIMIT_KB = 0.9 * FREE.turnGbPerMonth * 1_000_000;
  const relayed = (now: number, kb: number) =>
    inside((o) => o.usage.relayed(now, { links: 1, relayed: 1, kb }));

  beforeEach(async () => {
    await set({ CF_TURN_KEY_ID: 'key-id', CF_TURN_KEY_API_TOKEN: 'token-0123456789' });
    await inside((o) => o.turn.reset());
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json({ iceServers: [{ urls: STUN }, TURN_ENTRY] }),
    );
  });

  it('carries TURN just below 90% of the month’s allowance, yesterday counted twice, and STUN only at it', async () => {
    // Yesterday (the 14th, this month): 200 GB, which the guard counts in the month and once more.
    await relayed(wall - DAY_MS, 200_000_000);
    await relayed(wall, LIMIT_KB - 400_000_000 - 10_000_000);
    const below = await signIn();
    expect(await nextOf(below.c, 'welcome')).toMatchObject({ turn: true });
    expect(await admissionNow()).toMatchObject({ turn: true });
    await relayed(wall, 10_000_000);
    const at = await signIn();
    const welcome = await nextOf(at.c, 'welcome');
    expect(welcome).toMatchObject({ turn: false, ice: [{ urls: STUN[0] }, { urls: STUN[1] }] });
    expect(await admissionNow()).toMatchObject({ turn: false, open: true });
  });
});

describe('plans', () => {
  it('reads the paid plan’s allowances with PLAN=paid', async () => {
    await set({ PLAN: 'paid' });
    const metrics = await inside((o) => o.metrics());
    expect(metrics.plan).toBe('paid');
    expect(metrics.limits).toEqual(PAID);
    // The free plan's 90% of rows written is well within the paid plan's.
    await inside((o) => {
      o.rowCount.written += 0.9 * FREE.rowsWrittenPerDay;
    });
    expect((await admissionNow()).why).toBeNull();
    await inside((o) => {
      o.rowCount.written += 0.9 * (PAID.rowsWrittenPerDay - FREE.rowsWrittenPerDay);
    });
    expect((await admissionNow()).why).toBe('budget');
  });

  it.each([['gold'], [undefined]])('reads the free plan for PLAN=%s', async (plan) => {
    await set({ PLAN: plan });
    const metrics = await inside((o) => o.metrics());
    expect(metrics.plan).toBe('free');
    expect(metrics.limits).toEqual(FREE);
  });
});
