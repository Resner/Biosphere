import { describe, expect, it } from 'vitest';
import type { Leaf } from './protocol';
import { parseClientMsg } from './protocol';
import { LEAF_SLACK_WU, WHERE_EVERY_MS, WHERE_MIN_GAP_MS, WhereReporter } from './where';

const LEAF: Leaf = { x: 1024, y: 1024, size: 1024 };
const swim = (now: number, x = 1500, y = 1500, r = 10, aoi = 233) => ({
  inWater: true,
  x,
  y,
  r,
  aoi,
  now,
});
const ashore = (now: number) => ({ inWater: false, x: 0, y: 0, r: 10, aoi: 233, now });

/** A reporter already in the water at t = 0 inside `LEAF`. */
function started(): WhereReporter {
  const w = new WhereReporter();
  expect(w.update(swim(0), null)).toEqual({ t: 'where', x: 1500, y: 1500, r: 10, aoi: 233 });
  return w;
}

describe('WhereReporter', () => {
  it('sends nothing out of the water, and a where on entering it', () => {
    const w = new WhereReporter();
    expect(w.update(ashore(0), null)).toBeNull();
    expect(w.update(ashore(40_000), LEAF)).toBeNull();
    expect(w.update(swim(41_000), LEAF)).toEqual({
      t: 'where',
      x: 1500,
      y: 1500,
      r: 10,
      aoi: 233,
    });
  });

  it('stays quiet inside the leaf for 30 s, then reports', () => {
    const w = started();
    for (let t = 100; t < WHERE_EVERY_MS; t += 100) {
      expect(w.update(swim(t, 1500 + (t % 400), 1500), LEAF)).toBeNull();
    }
    expect(w.update(swim(WHERE_EVERY_MS, 1600, 1500), LEAF)?.t).toBe('where');
    expect(w.update(swim(WHERE_EVERY_MS + 100), LEAF)).toBeNull();
  });

  it('reports when the centre leaves the leaf by more than 64 wu, and only once for it', () => {
    expect(LEAF_SLACK_WU).toBe(64);
    const edge = LEAF.x + LEAF.size;
    for (const [x, y] of [
      [edge + 63, 1500],
      [LEAF.x - 63, 1500],
      [1500, LEAF.y - 63],
    ] as const) {
      expect(started().update(swim(5000, x, y), LEAF)).toBeNull();
    }
    for (const [x, y] of [
      [edge + 65, 1500],
      [LEAF.x - 65, 1500],
      [1500, edge + 65],
    ] as const) {
      const w = started();
      expect(w.update(swim(5000, x, y), LEAF)).toEqual({ t: 'where', x, y, r: 10, aoi: 233 });
      // Until the answer names the new leaf, the old one doesn't trigger again.
      expect(w.update(swim(8000, x + 10, y), LEAF)).toBeNull();
      expect(w.update(swim(9000, x + 10, y), { x: 2048, y: 1024, size: 1024 })).toBeNull();
    }
  });

  it('reports a tier change and an AoI change of more than a quarter', () => {
    const tier = started();
    expect(tier.update(swim(5000, 1500, 1500, 31), LEAF)).toBeNull();
    expect(tier.update(swim(6000, 1500, 1500, 33), LEAF)?.t).toBe('where');
    const aoi = started();
    expect(aoi.update(swim(5000, 1500, 1500, 10, 290), LEAF)).toBeNull();
    expect(aoi.update(swim(6000, 1500, 1500, 10, 176), LEAF)).toBeNull();
    expect(aoi.update(swim(7000, 1500, 1500, 10, 300), LEAF)).toEqual({
      t: 'where',
      x: 1500,
      y: 1500,
      r: 10,
      aoi: 300,
    });
  });

  it('holds a second trigger 1 s after the first until 2 s have passed', () => {
    const w = started();
    expect(w.update(swim(10_000, 1500, 1500, 40), LEAF)?.t).toBe('where');
    // The centre leaves the leaf 1 s later: the report waits.
    expect(w.update(swim(11_000, 2200, 1500, 40), LEAF)).toBeNull();
    expect(w.update(swim(11_500, 1500, 1500, 40), LEAF)).toBeNull();
    expect(w.update(swim(10_000 + WHERE_MIN_GAP_MS - 1, 1500, 1500, 40), LEAF)).toBeNull();
    expect(w.update(swim(10_000 + WHERE_MIN_GAP_MS, 1500, 1500, 40), LEAF)).toEqual({
      t: 'where',
      x: 1500,
      y: 1500,
      r: 40,
      aoi: 233,
    });
    expect(w.update(swim(13_000, 1500, 1500, 40), LEAF)).toBeNull();
  });

  it('sends gone once on a death, never within 2 s of the last message, and none after a respawn', () => {
    const w = started();
    expect(w.update(ashore(1000), LEAF)).toBeNull();
    expect(w.update(ashore(2000), LEAF)).toEqual({ t: 'gone' });
    expect(w.update(ashore(3000), LEAF)).toBeNull();
    expect(w.update(ashore(60_000), LEAF)).toBeNull();
    expect(w.update(swim(61_000), LEAF)?.t).toBe('where');
    // Back in the water before a pending gone went out: a where takes its place.
    expect(w.update(ashore(61_500), LEAF)).toBeNull();
    expect(w.update(swim(62_500), LEAF)).toBeNull();
    expect(w.update(swim(63_000), LEAF)?.t).toBe('where');
    expect(w.update(swim(64_000), LEAF)).toBeNull();
  });

  it('keeps its reports within the wire’s ranges', () => {
    const w = new WhereReporter();
    const msg = w.update({ inWater: true, x: -3, y: 2 ** 30, r: 0.4, aoi: 42_000, now: 0 }, null);
    expect(msg).not.toBeNull();
    expect(parseClientMsg(JSON.stringify(msg))).toEqual(msg);
    const big = new WhereReporter().update(swim(0, 10, 10, 5000, 0.5), null);
    expect(parseClientMsg(JSON.stringify(big))).toEqual(big);
  });
});
