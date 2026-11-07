import { describe, expect, it } from 'vitest';
import { AOI_PER_HALF_HEIGHT } from './aoi';
import {
  FULL_RATE,
  RATE_EVERY_MS,
  RateAsker,
  SendRates,
  VIEW_RATE_DIAG,
  wantedRate,
} from './snapshot-rates';

// M11 T15 (ADR 0062): the receiver asks each link for a snapshot rate by its class and distance,
// and the sender keeps to it.

const HH = 133.4;
const DIAG = Math.hypot(1, 16 / 9);

describe('wantedRate', () => {
  it('asks each class its rate', () => {
    const far = 10 * AOI_PER_HALF_HEIGHT * HH;
    expect(wantedRate(0, far, HH)).toBe(10);
    expect(wantedRate(1, far, HH)).toBe(10);
    expect(wantedRate(2, far, HH)).toBe(5);
    expect(wantedRate(3, far, HH)).toBe(2);
    expect(wantedRate(4, far, HH)).toBe(1);
    // A held peer in its grace, with no class.
    expect(wantedRate(null, far, HH)).toBe(1);
  });

  it('asks 10 Hz within 1.15 × the view’s half-diagonal, and 5 Hz within the AoI', () => {
    const view = VIEW_RATE_DIAG * DIAG * HH;
    expect(wantedRate(4, view - 1, HH)).toBe(10);
    expect(wantedRate(3, view + 1, HH)).toBe(5);
    expect(wantedRate(4, AOI_PER_HALF_HEIGHT * HH - 1, HH)).toBe(5);
    expect(wantedRate(4, AOI_PER_HALF_HEIGHT * HH + 1, HH)).toBe(1);
    // The view scales with the creature: a giant's half-height of 2,000 wu sees 4,500 wu off.
    expect(wantedRate(2, 4500, 2000)).toBe(10);
  });
});

describe('RateAsker', () => {
  it('asks on a change only, at most once a second per link, and keeps what it asked', () => {
    const asker = new RateAsker();
    expect(asker.update(0, [['a', 10]])).toEqual([]);
    expect(asker.wanted('a')).toBe(FULL_RATE);
    expect(asker.update(100, [['a', 1]])).toEqual([['a', 1]]);
    expect(asker.wanted('a')).toBe(1);
    // A change within the second waits for it.
    expect(asker.update(500, [['a', 10]])).toEqual([]);
    expect(asker.wanted('a')).toBe(1);
    expect(asker.update(100 + RATE_EVERY_MS, [['a', 10]])).toEqual([['a', 10]]);
    // Each link has its own second.
    expect(
      asker.update(1200, [
        ['a', 5],
        ['b', 2],
      ]),
    ).toEqual([['b', 2]]);
  });

  it('asks 10 Hz within a second of a peer crossing into the view', () => {
    const asker = new RateAsker();
    const view = VIEW_RATE_DIAG * DIAG * HH;
    // A P2 peer at 5 Hz swims in from the AoI's edge at 200 wu/s, the session's tick every 100 ms.
    let asked: number | null = null;
    let crossed: number | null = null;
    for (let t = 0; t <= 5000; t += 100) {
      const d = 340 - (200 * t) / 1000;
      if (crossed === null && d <= view) crossed = t;
      for (const [, hz] of asker.update(t, [['a', wantedRate(2, d, HH)]])) {
        if (hz === 10) asked = t;
      }
      if (asked !== null) break;
    }
    expect(crossed).not.toBeNull();
    expect(asked).not.toBeNull();
    expect((asked as number) - (crossed as number)).toBeLessThan(1000);
  });

  it('forgets a link, which starts again at 10 Hz', () => {
    const asker = new RateAsker();
    asker.update(0, [['a', 2]]);
    asker.forget('a');
    expect(asker.wanted('a')).toBe(FULL_RATE);
    expect(asker.update(10, [['a', 2]])).toEqual([['a', 2]]);
  });
});

describe('SendRates', () => {
  /** How many of `frames` snapshot frames (10 a second) go to `id`. */
  const count = (rates: SendRates, id: string, from: number, frames: number) => {
    let n = 0;
    for (let f = from; f < from + frames; f++) {
      rates.frame(f);
      if (rates.due(id)) n++;
    }
    return n;
  };

  it('sends every frame until asked, then at the asked rate', () => {
    const rates = new SendRates();
    expect(rates.hz('a')).toBe(10);
    expect(count(rates, 'a', 0, 10)).toBe(10);
    rates.set('a', 2);
    expect(rates.hz('a')).toBe(2);
    expect(count(rates, 'a', 10, 50)).toBe(10);
    rates.set('a', 5);
    expect(count(rates, 'a', 60, 10)).toBe(5);
    rates.set('a', 1);
    expect(count(rates, 'a', 70, 30)).toBe(3);
  });

  it('sends the next frame at once when a rate rises', () => {
    const rates = new SendRates();
    rates.frame(0);
    rates.set('a', 1);
    expect(count(rates, 'a', 1, 4)).toBe(1);
    rates.set('a', 10);
    rates.frame(5);
    expect(rates.due('a')).toBe(true);
  });

  it('forgets a link, which goes back to 10 Hz', () => {
    const rates = new SendRates();
    rates.set('a', 1);
    rates.forget('a');
    expect(rates.hz('a')).toBe(10);
  });
});
