import { describe, expect, it } from 'vitest';
import { ClockSync, PondClock } from './clock';

const RTTS = [80, 60, 120, 40, 90, 50, 70, 100];
const OFFSET = 5000;

/** A pong for a ping sent at `sent`: `fwd` ms out, the rest back, hub clock = local + OFFSET. */
function feed(clock: PondClock, sent: number, rtt: number, fwd = rtt / 2): number {
  const recv = sent + rtt;
  clock.addSample(sent, recv, sent + fwd + OFFSET);
  return recv;
}

describe('PondClock', () => {
  it('estimates the offset from the lowest-RTT sample', () => {
    const clock = new PondClock();
    let t = 1000;
    for (const rtt of RTTS) t = feed(clock, t, rtt, rtt * 0.6) + 100;
    expect(clock.rtt).toBe(40);
    // The 40 ms sample is asymmetric (24 out, 16 back), so it is off by 4 ms.
    expect(Math.abs((clock.offset ?? 0) - OFFSET)).toBeLessThan(20);
    expect(clock.hubNow(10_000)).toBeCloseTo(10_000 + (clock.offset ?? 0), 6);
  });

  it('keeps a lower-RTT old sample under 2 minutes, drops it after', () => {
    const clock = new PondClock();
    feed(clock, 0, 40);
    feed(clock, 60_000, 90);
    expect(clock.rtt).toBe(40);
    feed(clock, 125_000, 90);
    expect(clock.rtt).toBe(90);
  });

  it('takes a new sample with an equal or lower RTT', () => {
    const clock = new PondClock();
    feed(clock, 0, 80);
    feed(clock, 1000, 30);
    expect(clock.rtt).toBe(30);
  });

  it('ignores negative or non-finite samples', () => {
    const clock = new PondClock();
    clock.addSample(100, 50, 1000);
    clock.addSample(0, 10, Number.NaN);
    expect(clock.offset).toBeNull();
    expect(clock.hubNow(5)).toBe(5);
  });

  it('computes pondTick as floor((hubNow - epoch) * 30 / 1000)', () => {
    const clock = new PondClock();
    feed(clock, 0, 20);
    const epoch = 2000;
    // local 1000 → hub 6000 (+5000) → 4000 ms since epoch → tick 120.
    expect(clock.pondTick(1000, epoch)).toBe(120);
    expect(clock.pondTick(1034, epoch)).toBe(121);
    expect(clock.pondTick(0, 6000)).toBe(-30);
  });
});

describe('ClockSync', () => {
  const setup = () => {
    const clock = new PondClock();
    feed(clock, 0, 20);
    return { clock, sync: new ClockSync(clock, 0) };
  };

  it('does nothing when the drift is under one tick', () => {
    const { sync } = setup();
    // local 1000 ms → hub 6000 ms → tick 180.
    expect(sync.correct(180, 1000)).toEqual({ speed: 1 });
    expect(sync.correct(180.9, 1000)).toEqual({ speed: 1 });
    expect(sync.correct(179.5, 1000)).toEqual({ speed: 1 });
  });

  it('slews ±2% for a drift of 1 to 3 ticks', () => {
    const { sync } = setup();
    expect(sync.correct(178, 1000)).toEqual({ speed: 1.02 }); // behind
    expect(sync.correct(182, 1000)).toEqual({ speed: 0.98 }); // ahead
    expect(sync.correct(177, 1000)).toEqual({ speed: 1.02 }); // exactly 3 behind
  });

  it('snaps when the drift is larger than 3 ticks', () => {
    const { sync } = setup();
    const r = sync.correct(170, 1000);
    expect(r.speed).toBe(1);
    expect(r.snapTo).toBeCloseTo(180, 6);
  });

  it('converges from 2 ticks behind and stays within 1 tick', () => {
    const { sync } = setup();
    let tick = 178;
    let local = 1000;
    const frame = 1000 / 60;
    for (let i = 0; i < 6000; i++) {
      const { speed, snapTo } = sync.correct(tick, local);
      expect(snapTo).toBeUndefined();
      tick += (speed * 30) / 60;
      local += frame;
    }
    const target = new PondClock();
    feed(target, 0, 20);
    expect(Math.abs(target.pondTickExact(local, 0) - tick)).toBeLessThan(1);
  });

  it('keeps the drift within 1 tick over 5 s of 50 ppm fast local time', () => {
    const { sync } = setup();
    let tick = 180;
    let trueMs = 1000;
    const frame = 1000 / 60;
    let worst = 0;
    for (let i = 0; i < 300; i++) {
      const local = trueMs * (1 + 50e-6);
      const { speed } = sync.correct(tick, local);
      tick += (speed * 30) / 60;
      trueMs += frame;
      worst = Math.max(worst, Math.abs(tick - ((trueMs + OFFSET) * 30) / 1000));
    }
    expect(worst).toBeLessThan(1);
  });
});
