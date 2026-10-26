import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HubMsg } from '../src/net/protocol';
import { type Client, closeSockets, flush, login, nextOf, signIn, stub } from './test-hub';

interface Limits {
  env: { MAX_SESSIONS?: string; DAILY_REQUEST_BUDGET?: string };
  usage: { message(now: number): void };
}

const DAY = 86_400_000;
let wall = 0;

/** Sets the object's admission limits for one test. */
const configure = (limits: Limits['env']) =>
  runInDurableObject(stub(), (authority) => {
    Object.assign((authority as unknown as Limits).env, limits);
  });

const alarmAt = () => runInDurableObject(stub(), (_a, state) => state.storage.getAlarm());

beforeEach(() => {
  wall = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => wall);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeSockets();
  await runInDurableObject(stub(), (authority) =>
    (authority as unknown as { rearm(): Promise<void> }).rearm(),
  );
  await configure({ MAX_SESSIONS: '200', DAILY_REQUEST_BUDGET: '100000' });
});

/** Signs in and expects a place in line rather than a welcome. */
async function queueUp() {
  const { c, id } = await signIn();
  const msg = await c.next();
  if (msg.t !== 'queued') throw new Error(`expected queued, got ${msg.t}`);
  return { c, id, msg };
}

const types = (msgs: HubMsg[]) => msgs.map((m) => m.t);

describe('admission queue', () => {
  beforeEach(() => configure({ MAX_SESSIONS: '3' }));

  it('queues the 4th and 5th session with their place and an estimate', async () => {
    const seated = [await login(), await login(), await login()];
    await Promise.all(seated.map(({ c }) => flush(c)));
    const fourth = await queueUp();
    const fifth = await queueUp();
    expect(fourth.msg).toEqual({ t: 'queued', position: 1, etaS: 30 });
    expect(fifth.msg).toEqual({ t: 'queued', position: 2, etaS: 60 });
    // Nobody in the pond hears of them.
    for (const { c } of seated) {
      expect(types(await flush(c))).not.toContain('member');
    }
  });

  it('answers everything but a ping or a leave with refused queued', async () => {
    await Promise.all([login(), login(), login()]);
    const { c } = await queueUp();
    c.send({ t: 'history' });
    c.send({ t: 'death', cause: 'starved', ticks: 1 });
    c.send({ t: 'progress', n: 1, ticks: 1, biomass: 1, energy: 1, health: 1 });
    expect(await flush(c)).toEqual([
      { t: 'refused', reason: 'queued' },
      { t: 'refused', reason: 'queued' },
      { t: 'refused', reason: 'queued' },
    ]);
    c.send({ t: 'leave' });
    expect(await c.closed).toBe(1000);
  });

  it('seats the first in line when a place frees and moves the next one up', async () => {
    const [a] = [await login(), await login(), await login()];
    const fourth = await queueUp();
    const fifth = await queueUp();
    a.c.ws.close(1000, 'bye');
    await a.c.closed;
    await nextOf(fourth.c, 'welcome');
    expect((await nextOf(fourth.c, 'life')).t).toBe('life');
    expect(await nextOf(fifth.c, 'queued')).toEqual({ t: 'queued', position: 1, etaS: 30 });
    // Seated, the fourth session can play: a history request is answered.
    fourth.c.send({ t: 'history' });
    expect((await nextOf(fourth.c, 'history')).lives).toEqual([]);
  });

  it('removes a session that leaves the queue and updates the places behind it', async () => {
    await Promise.all([login(), login(), login()]);
    const fourth = await queueUp();
    const fifth = await queueUp();
    const sixth = await queueUp();
    fourth.c.ws.close(1000, 'bye');
    await fourth.c.closed;
    expect(await nextOf(fifth.c, 'queued')).toMatchObject({ position: 1 });
    expect(await nextOf(sixth.c, 'queued')).toMatchObject({ position: 2 });
  });

  it('keeps arrival order when a later session reconnects, and holds a place across tabs', async () => {
    await Promise.all([login(), login(), login()]);
    const fourth = await queueUp();
    const fifth = await queueUp();
    // The fourth player opens another tab: the new socket inherits the place.
    const again = await signIn(fourth.id);
    expect(await fourth.c.closed).toBe(4001);
    expect(await again.c.next()).toMatchObject({ t: 'queued', position: 1 });
    expect(fifth.c.inbox).toEqual([]);
  });

  it('does not queue a player who already has a seat and reconnects', async () => {
    const [a] = [await login(), await login(), await login()];
    const again = await login(a.id);
    expect(again.life.t).toBe('life');
    expect(await a.c.closed).toBe(4001);
  });

  it('waits behind a session that took the freed seat', async () => {
    const [a] = [await login(), await login(), await login()];
    const fourth = await queueUp();
    a.c.ws.close(1000, 'bye');
    await a.c.closed;
    await nextOf(fourth.c, 'welcome');
    // The seat is taken again, so a newcomer waits.
    expect((await queueUp()).msg.position).toBe(1);
  });

  it('holds an alarm only while somebody waits', async () => {
    const seated = [await login(), await login(), await login()];
    expect(await alarmAt()).toBeNull();
    const fourth = await queueUp();
    expect(await alarmAt()).toBe(wall + 15_000);
    seated[0]?.c.ws.close(1000, 'bye');
    await nextOf(fourth.c, 'welcome');
    await runDurableObjectAlarm(stub());
    expect(await alarmAt()).toBeNull();
  });

  it('promotes on the alarm tick when only the clock changed', async () => {
    await configure({ MAX_SESSIONS: '1', DAILY_REQUEST_BUDGET: '1000' });
    await login();
    const { c } = await queueUp();
    // Raising the cap is noticed on the next tick, with no seat freed.
    await configure({ MAX_SESSIONS: '2' });
    wall += 15_000;
    await runDurableObjectAlarm(stub());
    await nextOf(c, 'welcome');
  });
});

describe('request budget', () => {
  it('queues new sessions past 90% of the day and promotes them after midnight UTC', async () => {
    await configure({ DAILY_REQUEST_BUDGET: '1000' });
    const seated: Client = (await login()).c;
    // 18,000 messages are 900 requests.
    await runInDurableObject(stub(), (authority) => {
      const { usage } = authority as unknown as Limits;
      for (let i = 0; i < 18_000; i++) usage.message(wall);
    });
    const { c } = await queueUp();
    expect(await flush(seated)).toEqual([]);
    wall = Math.floor(wall / DAY) * DAY + DAY + 1000;
    await runDurableObjectAlarm(stub());
    await nextOf(c, 'welcome');
  });
});
