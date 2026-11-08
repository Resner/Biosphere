import { describe, expect, it } from 'vitest';
import type { ClientMsg } from '../net/protocol';
import {
  RIDE_AGAIN_MS,
  RIDE_ALONE_MS,
  RIDE_FADE_MS,
  RIDE_MS,
  RIDE_NO_TEXT,
  RIDE_OFFER_MS,
  RIDE_REPORT_LAG_MS,
  Ride,
} from './ride';

const FROM = { x: 1000, y: 2000, radius: 10 };
const ARRIVAL = { t: 'spawn', x: 41_000, y: 2000, why: 'ride', protect: true } as const;

/** Plays the transition tick by tick (30 Hz) from `start`; returns the body and every step's result. */
function play(ride: Ride, start: number, ms: number) {
  const body = { x: FROM.x, y: FROM.y, vx: 0, vy: 0 };
  const steps: string[] = [];
  let t = start;
  for (; t <= start + ms + 40; t += 1000 / 30) {
    const r = ride.carry(body, t);
    if (r) steps.push(r);
    if (r === 'arrived') break;
  }
  return { body, steps, end: t };
}

describe('the offer', () => {
  it('shows after the wait alone, for 12 s, and again 2 minutes later while still alone', () => {
    const ride = new Ride();
    // The hub's wait starts from the report that turning alone sends, at most 2 s later.
    expect(RIDE_REPORT_LAG_MS).toBe(2000);
    const WAIT = RIDE_ALONE_MS + RIDE_REPORT_LAG_MS;
    expect(ride.offer(0, true)).toBe(false);
    expect(ride.offer(WAIT - 1, true)).toBe(false);
    expect(ride.offer(WAIT, true)).toBe(true);
    expect(ride.offer(WAIT + RIDE_OFFER_MS - 1, true)).toBe(true);
    expect(ride.offer(WAIT + RIDE_OFFER_MS, true)).toBe(false);
    expect(ride.offer(WAIT + RIDE_AGAIN_MS - 1, true)).toBe(false);
    expect(ride.offer(WAIT + RIDE_AGAIN_MS, true)).toBe(true);
    expect(ride.offer(WAIT + RIDE_AGAIN_MS + RIDE_OFFER_MS, true)).toBe(false);
    expect(ride.alone).toBe(true);
  });

  it('starts the wait again when company comes, and takes `debug.aloneMs`', () => {
    const ride = new Ride();
    ride.aloneMs = 3000;
    ride.offer(0, true);
    expect(ride.offer(2000, false)).toBe(false);
    expect(ride.alone).toBe(false);
    expect(ride.offer(2500, true)).toBe(false);
    expect(ride.offer(2500 + 3000 + RIDE_REPORT_LAG_MS - 1, true)).toBe(false);
    expect(ride.offer(2500 + 3000 + RIDE_REPORT_LAG_MS, true)).toBe(true);
  });
});

describe('the request', () => {
  it('sends one `ride` per press, none while it is asked or played', () => {
    const ride = new Ride();
    const sent: ClientMsg[] = [];
    const send = (m: ClientMsg) => sent.push(m) > 0;
    expect(ride.ask(send)).toBe(true);
    expect(ride.ask(send)).toBe(false);
    expect(sent).toEqual([{ t: 'ride' }]);
    expect(ride.phase).toBe('asking');
    ride.receive(ARRIVAL, 0, FROM, false);
    expect(ride.ask(send)).toBe(false);
    expect(sent).toHaveLength(1);
  });

  it('sends nothing without a link', () => {
    const ride = new Ride();
    expect(ride.ask(() => false)).toBe(false);
    expect(ride.phase).toBe('idle');
  });

  it('tells each refusal and lets the player ask again', () => {
    const ride = new Ride();
    const sent: ClientMsg[] = [];
    for (const [why, text] of Object.entries(RIDE_NO_TEXT)) {
      ride.ask((m) => sent.push(m) > 0);
      expect(ride.receive({ t: 'ride-no', why } as never, 0, FROM, false)).toBe(text);
      expect(ride.phase).toBe('idle');
      expect(ride.last).toBe(why);
    }
    expect(sent).toHaveLength(5);
    expect(RIDE_NO_TEXT.company).toBe('Someone is near');
  });

  it('leaves a placed spawn to the life', () => {
    const ride = new Ride();
    expect(ride.receive({ ...ARRIVAL, why: 'placed' }, 0, FROM, false)).toBeNull();
    expect(ride.phase).toBe('idle');
  });
});

describe('the transition', () => {
  it('takes 1.2 s, holds input, turns once, and ends at the arrival', () => {
    const ride = new Ride();
    ride.ask(() => true);
    ride.receive(ARRIVAL, 500, FROM, false);
    expect(ride.phase).toBe('riding');
    expect(ride.holding).toBe(true);
    expect(ride.reportAt()).toEqual({ x: ARRIVAL.x, y: ARRIVAL.y });
    const before = { x: FROM.x, y: FROM.y, vx: 0, vy: 0 };
    ride.carry(before, 500 + RIDE_MS * 0.4);
    // Swept along toward the arrival, still at the old place.
    expect(before.x).toBeGreaterThan(FROM.x);
    expect(before.x - FROM.x).toBeLessThan(500);
    const { body, steps, end } = play(ride, 500, RIDE_MS);
    expect(steps.filter((s) => s === 'turn')).toHaveLength(1);
    expect(steps.at(-1)).toBe('arrived');
    expect(end - 500).toBeGreaterThanOrEqual(RIDE_MS);
    expect(end - 500).toBeLessThan(RIDE_MS + 40);
    expect(body).toEqual({ x: ARRIVAL.x, y: ARRIVAL.y, vx: 0, vy: 0 });
    expect(ride.phase).toBe('arrived');
    expect(ride.holding).toBe(false);
    expect(ride.reportAt()).toBeNull();
    expect(ride.look(end)).toBeNull();
  });

  it('turns by the arrival half-way, within a few radii of it', () => {
    const ride = new Ride();
    ride.receive(ARRIVAL, 0, FROM, false);
    const body = { x: FROM.x, y: FROM.y, vx: 0, vy: 0 };
    for (let t = 0; t < RIDE_MS * 0.5; t += 1000 / 30) expect(ride.carry(body, t)).toBe('moved');
    expect(ride.carry(body, RIDE_MS * 0.5)).toBe('turn');
    expect(Math.hypot(body.x - ARRIVAL.x, body.y - ARRIVAL.y)).toBeLessThanOrEqual(6 * FROM.radius);
    expect(ride.carry(body, RIDE_MS * 0.6)).toBe('moved');
  });

  it('streaks and washes the picture, strongest at the turn', () => {
    const ride = new Ride();
    ride.receive(ARRIVAL, 0, FROM, false);
    expect(ride.look(0)).toMatchObject({ wash: 0, dirX: 1, dirY: 0 });
    expect(ride.look(RIDE_MS * 0.3)?.sweep).toBe(1);
    expect(ride.look(RIDE_MS * 0.5)?.wash).toBe(1);
    expect(ride.look(RIDE_MS)?.wash).toBe(0);
  });

  it('is a 0.4 s cross-fade under Reduce motion: no sweep, at the arrival after it', () => {
    const ride = new Ride();
    ride.receive(ARRIVAL, 0, FROM, true);
    expect(ride.look(RIDE_FADE_MS * 0.25)?.sweep).toBe(0);
    expect(ride.look(RIDE_FADE_MS * 0.5)?.wash).toBe(1);
    const still = { x: FROM.x, y: FROM.y, vx: 0, vy: 0 };
    ride.carry(still, RIDE_FADE_MS * 0.4);
    expect(still).toMatchObject({ x: FROM.x, y: FROM.y });
    const { body, end } = play(ride, 0, RIDE_FADE_MS);
    expect(end).toBeGreaterThanOrEqual(RIDE_FADE_MS);
    expect(end).toBeLessThan(RIDE_FADE_MS + 40);
    expect(body).toMatchObject({ x: ARRIVAL.x, y: ARRIVAL.y });
    expect(ride.phase).toBe('arrived');
  });

  it('stops the offer while it plays, and a new life forgets the ride', () => {
    const ride = new Ride();
    ride.aloneMs = 0;
    expect(ride.offer(0, true)).toBe(false);
    ride.receive(ARRIVAL, 0, FROM, false);
    expect(ride.offer(10, true)).toBe(false);
    ride.reset();
    expect(ride.view()).toEqual({ offered: false, phase: 'idle', last: 'ride' });
  });
});
