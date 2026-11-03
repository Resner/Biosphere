import { describe, expect, it } from 'vitest';
import { TELEGRAPH, Telegraphs, windupGlow } from './telegraph';

describe('windupGlow', () => {
  it('rises over the windup’s 8 ticks and is gone once the strike has landed', () => {
    const w = TELEGRAPH.windupTicks;
    expect(w).toBe(8);
    let last = 0;
    for (let left = w; left >= 1; left--) {
      const g = windupGlow(left);
      expect(g, `${left} left`).toBeGreaterThan(last);
      last = g;
    }
    expect(windupGlow(w)).toBeCloseTo(1 / w, 9);
    expect(windupGlow(1)).toBe(1);
    // Between frames it rises smoothly.
    expect(windupGlow(4.5)).toBeGreaterThan(windupGlow(5));
    expect(windupGlow(4.5)).toBeLessThan(windupGlow(4));
    // No windup, or one not begun: nothing.
    expect(windupGlow(null)).toBe(0);
    expect(windupGlow(w + 1)).toBe(0);
    expect(windupGlow(Number.NaN)).toBe(0);
  });
});

describe('Telegraphs', () => {
  it('glows the front and each weapon tip of a winding-up body, brighter as the strike nears', () => {
    const t = new Telegraphs();
    t.begin();
    // A body at the origin facing east, a weapon reaching 2 radii across ±0.5 rad.
    t.glow(0, 0, 0, 10, 2, 0.5, windupGlow(6));
    const early = t.end().map((m) => ({ ...m }));
    expect(early.map((m) => m.kind)).toEqual(['glow', 'glow', 'glow']);
    const front = early[0];
    expect(front?.x).toBeCloseTo(TELEGRAPH.frontRadii * 10, 9);
    expect(front?.y).toBeCloseTo(0, 9);
    // The tips sit out at the reach, either side of the heading.
    expect(early[1]?.y).toBeLessThan(0);
    expect(early[2]?.y).toBeGreaterThan(0);
    expect(early[1]?.x).toBeGreaterThan(15);
    t.begin();
    t.glow(0, 0, 0, 10, 2, 0.5, windupGlow(1));
    const late = t.end();
    expect(late[0]?.value).toBeGreaterThan(front?.value ?? 1);
    expect(t.info().glows).toBe(3);
    // A body with no weapon glows at its front only; none at all once the strike has landed.
    t.begin();
    t.glow(0, 0, 0, 10, 1, 0, windupGlow(3));
    t.glow(50, 0, 0, 10, 2, 0, windupGlow(null));
    expect(t.end()).toHaveLength(1);
  });

  it('flashes a hit for 0.3 s, sparks a block and wobbles the staggered attacker', () => {
    const t = new Telegraphs();
    t.flash('b');
    expect(t.hurt('b')).toBeCloseTo(TELEGRAPH.flashPeak, 9);
    t.update(TELEGRAPH.flashSeconds / 2);
    expect(t.hurt('b')).toBeGreaterThan(0);
    expect(t.hurt('b')).toBeLessThan(TELEGRAPH.flashPeak);
    t.update(TELEGRAPH.flashSeconds);
    expect(t.hurt('b')).toBe(0);

    t.spark(5, 5, 10);
    t.begin();
    const marks = t.end();
    expect(marks.map((m) => m.kind)).toEqual(['spark']);
    expect(marks[0]?.size).toBeCloseTo(TELEGRAPH.sparkRadii * 10, 9);
    t.update(TELEGRAPH.sparkSeconds);
    t.begin();
    expect(t.end()).toHaveLength(0);

    t.wobble('a');
    t.update(0.03);
    expect(Math.abs(t.wobbleOf('a', false))).toBeGreaterThan(0);
    // Reduce motion drops the wobble; the flash stays.
    expect(t.wobbleOf('a', true)).toBe(0);
    t.update(TELEGRAPH.wobbleSeconds);
    expect(t.wobbleOf('a', false)).toBe(0);
    expect(t.info()).toMatchObject({ flashed: 1, sparked: 1, wobbled: 1 });
  });

  it('flashes a remote whose snapshot health drops, not one that heals or barely changes', () => {
    const t = new Telegraphs();
    t.watchHealth('c', 1);
    t.watchHealth('c', 0.99);
    t.watchHealth('c', 0.98);
    expect(t.hurt('c')).toBe(0);
    t.watchHealth('c', 0.9);
    expect(t.hurt('c')).toBeGreaterThan(0);
    t.update(1);
    // Healing raises the mark; a small dip below it does nothing.
    t.watchHealth('c', 0.95);
    t.watchHealth('c', 0.93);
    expect(t.hurt('c')).toBe(0);
  });

  it('rings a creature fighting elsewhere, faintly', () => {
    const t = new Telegraphs();
    t.begin();
    t.ring(1, 2, 10);
    const [ring] = t.end();
    expect(ring).toMatchObject({ kind: 'ring', x: 1, y: 2, size: TELEGRAPH.ringRadii * 10 });
    expect(ring?.value).toBeLessThanOrEqual(0.5);
  });
});
