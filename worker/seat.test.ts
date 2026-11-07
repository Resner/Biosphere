import { runInDurableObject } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PubKey } from '../src/ledger/record';
import { SEAT_RENEW_MS, SEAT_TTL_MS, seatValid } from '../src/ledger/seat';
import type { Authority } from './authority';
import type { Clock } from './fights';
import { closeSockets, login, nextOf, ORIGIN, rowsWritten, signIn, sql, stub } from './test-hub';

// Seat tickets on the hub (M11 T7, ADR 0062): the welcome's ticket, its renewal after a `pong`, and
// no row written for either.

const pubkeys = async (): Promise<PubKey[]> => {
  const res = await exports.default.fetch('https://authority.test/v1/pubkeys', {
    headers: { Origin: ORIGIN },
  });
  return ((await res.json()) as { keys: PubKey[] }).keys;
};
const worldSeed = async () =>
  String((await sql<{ seed: string }>('SELECT seed FROM world'))[0]?.seed);

// The hub's clock, moved by hand: tickets are dated on it.
let t = 0;
let saved: Clock | null = null;
beforeEach(async () => {
  t = Date.now();
  await runInDurableObject(stub(), (o: Authority) => {
    saved = o.clock;
    o.clock = { ...o.clock, now: () => t };
  });
});
afterEach(async () => {
  await closeSockets();
  await runInDurableObject(stub(), (o: Authority) => {
    if (saved) o.clock = saved;
  });
});

describe('seat tickets on the hub', () => {
  it('the welcome carries a ticket for the session, which verifies under /v1/pubkeys', async () => {
    const keys = await pubkeys();
    const { c, id } = await signIn();
    const welcome = await nextOf(c, 'welcome');
    const ticket = welcome.ticket;
    expect(ticket?.seat).toEqual({
      v: 1,
      kind: 'seat',
      player: id.playerId,
      name: 'Tester',
      world: welcome.world.seed,
      t,
      until: t + SEAT_TTL_MS,
    });
    expect(welcome.world.seed).toBe(await worldSeed());
    if (!ticket) throw new Error('no ticket');
    const want = { world: welcome.world.seed, player: id.playerId, now: t + 1000 };
    expect(seatValid(ticket, keys, want)).toBe(true);
    expect(seatValid(ticket, keys, { ...want, player: keys[0]?.publicKey ?? '' })).toBe(false);
    expect(seatValid(ticket, keys, { ...want, now: t + SEAT_TTL_MS })).toBe(false);
  });

  it('renews the ticket after a pong 10 minutes on, not after 9, and writes no row', async () => {
    const keys = await pubkeys();
    const { c, id } = await login();
    const world = await worldSeed();
    const before = await rowsWritten();
    const start = t;
    t = start + SEAT_RENEW_MS - 60_000;
    c.send({ t: 'ping', id: 1 });
    expect(await c.next()).toMatchObject({ t: 'pong', id: 1 });
    c.send({ t: 'ping', id: 2 });
    // Nothing between the two pongs: no seat after 9 minutes.
    expect(await c.next()).toMatchObject({ t: 'pong', id: 2 });

    t = start + SEAT_RENEW_MS;
    c.send({ t: 'ping', id: 3 });
    expect(await c.next()).toMatchObject({ t: 'pong', id: 3 });
    const seat = await c.next();
    if (seat.t !== 'seat') throw new Error(`expected a seat, got ${seat.t}`);
    expect(seat.ticket.seat).toMatchObject({ player: id.playerId, name: 'Tester', world, t });
    expect(seatValid(seat.ticket, keys, { world, player: id.playerId, now: t })).toBe(true);

    // The next renewal counts from this ticket, not from the welcome.
    t += SEAT_RENEW_MS - 1;
    c.send({ t: 'ping', id: 4 });
    expect(await c.next()).toMatchObject({ t: 'pong', id: 4 });
    c.send({ t: 'ping', id: 5 });
    expect(await c.next()).toMatchObject({ t: 'pong', id: 5 });
    expect(await rowsWritten()).toBe(before);
  });

  it('a welcome writes no ledger row once the key exists', async () => {
    await pubkeys();
    const before = await rowsWritten();
    const { c } = await signIn();
    expect((await nextOf(c, 'welcome')).ticket).toBeDefined();
    await nextOf(c, 'life');
    expect(await rowsWritten()).toBe(before);
  });
});
