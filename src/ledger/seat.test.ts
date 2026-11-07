import { describe, expect, it } from 'vitest';
import { createRng, seedFromString } from '../sim/prng';
import { parseSignedSeat, SEAT_RENEW_MS, SEAT_TTL_MS, type SignedSeat } from './seat';

const PID = 'A'.repeat(43);
const SIG = 'c'.repeat(86);

const ticket: SignedSeat = {
  seat: {
    v: 1,
    kind: 'seat',
    player: PID,
    name: 'Alice_9',
    world: 'w1',
    t: 1_700_000_000_000,
    until: 1_700_000_000_000 + SEAT_TTL_MS,
  },
  authSig: SIG,
  keyId: 'AbCdEf_-',
};

describe('parseSignedSeat', () => {
  it('takes a well-formed ticket and copies it', () => {
    expect(SEAT_TTL_MS).toBe(900_000);
    expect(SEAT_RENEW_MS).toBe(600_000);
    const raw = JSON.parse(JSON.stringify(ticket)) as SignedSeat;
    const got = parseSignedSeat(raw);
    expect(got).toEqual(ticket);
    expect(got).not.toBe(raw);
    expect(got?.seat).not.toBe(raw.seat);
  });

  it('refuses an unknown field at either level, and a missing one', () => {
    expect(parseSignedSeat({ ...ticket, extra: 1 })).toBeNull();
    expect(parseSignedSeat({ ...ticket, seat: { ...ticket.seat, extra: 1 } })).toBeNull();
    for (const key of Object.keys(ticket)) {
      const { [key as keyof SignedSeat]: _, ...rest } = ticket;
      expect(parseSignedSeat(rest), key).toBeNull();
    }
    for (const key of Object.keys(ticket.seat)) {
      const { [key as keyof SignedSeat['seat']]: _, ...rest } = ticket.seat;
      expect(parseSignedSeat({ ...ticket, seat: rest }), key).toBeNull();
    }
  });

  it('refuses malformed ids, names, times and signatures', () => {
    const seat = (over: object) =>
      parseSignedSeat({ ...ticket, seat: { ...ticket.seat, ...over } });
    for (const over of [
      { v: 2 },
      { kind: 'commit' },
      { player: 'short' },
      { player: `${'A'.repeat(42)}+` },
      { name: 'ab' },
      { name: 'bad name' },
      { world: '' },
      { world: 'w'.repeat(65) },
      { world: 'a/b' },
      { t: -1 },
      { t: 1.5 },
      { until: '1' },
      { until: ticket.seat.t - 1 },
    ]) {
      expect(seat(over), JSON.stringify(over)).toBeNull();
    }
    expect(parseSignedSeat({ ...ticket, authSig: 'short' })).toBeNull();
    expect(parseSignedSeat({ ...ticket, keyId: 'AbCdEf_' })).toBeNull();
    expect(parseSignedSeat({ ...ticket, keyId: 'AbCdEf_+' })).toBeNull();
  });

  it('never throws on 10,000 fuzzed values', () => {
    const rng = createRng(seedFromString('fuzz-seat'), 'net');
    const atoms = [0, -1, 1.5, '', 'x', PID, SIG, null, true, [], {}, 1e308];
    const pick = <T>(xs: readonly T[]): T => xs[rng.int(0, xs.length - 1)] as T;
    let parsed = 0;
    for (let i = 0; i < 10_000; i++) {
      const v = structuredClone(ticket) as unknown as Record<string, Record<string, unknown>>;
      const at = rng.int(0, 1) ? v : (v.seat as Record<string, unknown>);
      const key = pick([...Object.keys(at), 'extra']);
      const r = rng.int(0, 3);
      if (r === 0) delete at[key];
      else if (r === 1) (at as Record<string, unknown>)[key] = pick(atoms);
      const input = r === 3 ? pick(atoms) : v;
      if (parseSignedSeat(input) !== null) parsed++;
    }
    expect(parsed).toBeGreaterThan(0);
    for (const v of [undefined, null, 'x', [], Object.create(null)])
      expect(parseSignedSeat(v)).toBeNull();
  });
});
