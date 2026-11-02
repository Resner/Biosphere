import { describe, expect, it } from 'vitest';
import { Effects, FX } from './effects';

const AT = { x: 3, y: 4, radius: 10 };

describe('Effects', () => {
  it('counts eats and dashes and shows a ring for each', () => {
    const fx = new Effects();
    fx.onEvent({ type: 'eat', creature: 'p', food: 'f', value: 5 }, AT);
    fx.onEvent({ type: 'dash', creature: 'p' }, AT);
    expect(fx.snapshot()).toMatchObject({ eat: 1, dash: 1, rings: 2 });
    expect(fx.rings.map((ring) => ring.kind)).toEqual(['pop', 'ripple']);
  });

  it('marks a committed mating with a wide, slow ring', () => {
    const fx = new Effects();
    fx.matePulse(AT);
    expect(fx.rings).toEqual([
      { kind: 'ripple', x: 3, y: 4, size: 10 * FX.mateRadii, age: 0, life: FX.mateSeconds },
    ]);
    expect(fx.snapshot()).toMatchObject({ eat: 0, dash: 0 });
  });

  it('marks growth with a ring, and a tier change with a wider, slower one', () => {
    const fx = new Effects();
    fx.growPulse(AT, false);
    fx.growPulse(AT, true);
    expect(fx.rings).toEqual([
      { kind: 'ripple', x: 3, y: 4, size: 10 * FX.growRadii, age: 0, life: FX.growSeconds },
      { kind: 'ripple', x: 3, y: 4, size: 10 * FX.tierRadii, age: 0, life: FX.tierSeconds },
    ]);
    expect(fx.snapshot()).toMatchObject({ grow: 1, tier: 1 });
    expect(FX.tierRadii).toBeGreaterThan(FX.growRadii);
    expect(FX.tierSeconds).toBeGreaterThan(FX.growSeconds);
  });

  it('bursts an egg with one ring per step of rarity, each wider than the last', () => {
    const fx = new Effects();
    fx.burst(AT, 3);
    expect(fx.rings).toHaveLength(3);
    expect(fx.rings[0]?.kind).toBe('pop');
    const sizes = fx.rings.map((ring) => ring.size);
    expect(sizes[1]).toBeGreaterThan(sizes[0] as number);
    expect(sizes[2]).toBeGreaterThan(sizes[1] as number);
    expect(fx.snapshot().bursts).toBe(1);
    fx.burst(AT, 0);
    expect(fx.rings).toHaveLength(3);
    expect(fx.snapshot().bursts).toBe(2);
  });

  it('shrinks the drawn body with a pulse when a mating is paid for (M6 T20)', () => {
    const fx = new Effects();
    expect(fx.drawnRadius(10)).toBe(10);
    fx.costPulse(12);
    expect(fx.snapshot().cost).toBe(1);
    expect(fx.drawnRadius(10)).toBeCloseTo(12, 6);
    const sizes: number[] = [];
    for (let t = 0; t < FX.shrinkSeconds; t += 1 / 60) {
      fx.update(1 / 60);
      sizes.push(fx.drawnRadius(10));
    }
    // It dips below the new size before it settles there: the pulse.
    expect(Math.min(...sizes)).toBeLessThan(10 * 0.97);
    fx.update(0.1);
    expect(fx.drawnRadius(10)).toBe(10);
    fx.costPulse(12);
    fx.reset();
    expect(fx.drawnRadius(10)).toBe(10);
  });

  it('retires rings once their time is up', () => {
    const fx = new Effects();
    fx.onEvent({ type: 'eat', creature: 'p', food: 'f', value: 5 }, AT);
    fx.update(FX.popSeconds * 0.5);
    expect(fx.rings).toHaveLength(1);
    expect(fx.rings[0]?.age).toBeCloseTo(FX.popSeconds * 0.5, 6);
    fx.update(FX.popSeconds);
    expect(fx.rings).toHaveLength(0);
  });

  it('never holds more rings than the pool', () => {
    const fx = new Effects();
    for (let i = 0; i < FX.ringCapacity * 3; i++) {
      fx.onEvent({ type: 'dash', creature: 'p' }, AT);
    }
    expect(fx.rings).toHaveLength(FX.ringCapacity);
    expect(fx.snapshot().dash).toBe(FX.ringCapacity * 3);
  });

  it('counts damage, but only a hit flashes the body (M6c T9)', () => {
    const fx = new Effects();
    for (let i = 0; i < 90; i++) {
      fx.onEvent({ type: 'damage', creature: 'p', amount: 0.3, cause: 'starved' }, AT);
      fx.update(1 / 30);
    }
    expect(fx.snapshot().damage).toBe(90);
    expect(fx.hurt).toBe(0);
  });

  it('a hit flashes the hurt tint for 0.15 s, from its peak on the next frame to exactly 0 (M6c T9)', () => {
    const fx = new Effects();
    fx.hurtFlash(1);
    const start = fx.hurt;
    expect(start).toBeGreaterThanOrEqual(FX.hurtFloor);
    const frames: number[] = [];
    for (let i = 0; i < 60; i++) {
      fx.update(1 / 60);
      frames.push(fx.hurt);
    }
    expect(frames[0]).toBe(start);
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i]).toBeLessThanOrEqual(frames[i - 1] as number);
    }
    const lit = frames.filter((h) => h > 0).length;
    expect(lit / 60).toBeCloseTo(FX.hurtFlashSeconds, 1);
    expect(frames.at(-1)).toBe(0);
  });

  it('a slow frame still shows the flash', () => {
    const fx = new Effects();
    fx.hurtFlash(1);
    fx.update(0.5);
    expect(fx.hurt).toBeGreaterThanOrEqual(FX.hurtFloor);
    fx.update(1 / 60);
    expect(fx.hurt).toBe(0);
  });

  it('a heavier hit flashes stronger, up to 1', () => {
    const weak = new Effects();
    const strong = new Effects();
    weak.hurtFlash(0.1);
    strong.hurtFlash(50);
    expect(weak.hurt).toBeGreaterThanOrEqual(FX.hurtFloor);
    expect(strong.hurt).toBeGreaterThan(weak.hurt);
    expect(strong.hurt).toBeLessThanOrEqual(1);
  });

  it('never paints an edge vignette', () => {
    const fx = new Effects();
    for (const cause of ['uv', 'pressure', 'toxin', 'starved'] as const) {
      fx.onEvent({ type: 'damage', creature: 'p', amount: 5, cause }, AT);
      fx.hurtFlash(5);
      expect(fx.snapshot().vignette, cause).toBe(0);
      expect(fx.snapshot().hurt, cause).toBeGreaterThan(0);
    }
  });

  it('dissolves for at least a second, then reports it finished', () => {
    const fx = new Effects();
    expect(fx.dissolve).toBe(0);
    expect(fx.dissolved).toBe(false);
    fx.startDissolve();
    let seconds = 0;
    while (!fx.dissolved && seconds < 10) {
      fx.update(1 / 60);
      seconds += 1 / 60;
    }
    expect(seconds).toBeGreaterThanOrEqual(1);
    expect(fx.dissolve).toBe(1);
  });

  it('does not count the frame that died: a slow frame cannot shorten the dissolve', () => {
    const fx = new Effects();
    fx.startDissolve();
    fx.update(0.5);
    expect(fx.dissolve).toBe(0);
    fx.update(1.0);
    expect(fx.dissolved).toBe(false);
    fx.update(0.25);
    expect(fx.dissolved).toBe(true);
  });

  it('does not dissolve before startDissolve', () => {
    const fx = new Effects();
    fx.update(5);
    expect(fx.dissolve).toBe(0);
  });

  it('ignores a repeated startDissolve', () => {
    const fx = new Effects();
    fx.startDissolve();
    fx.update(0.5);
    const half = fx.dissolve;
    fx.startDissolve();
    expect(fx.dissolve).toBe(half);
  });

  it('reset clears everything', () => {
    const fx = new Effects();
    fx.onEvent({ type: 'eat', creature: 'p', food: 'f', value: 5 }, AT);
    fx.onEvent({ type: 'damage', creature: 'p', amount: 1, cause: 'toxin' }, AT);
    fx.hurtFlash(1);
    fx.startDissolve();
    fx.update(0.05);
    fx.reset();
    expect(fx.snapshot()).toMatchObject({
      eat: 0,
      dash: 0,
      damage: 0,
      grow: 0,
      tier: 0,
      rings: 0,
      hurt: 0,
      vignette: 0,
    });
    expect(fx.dissolve).toBe(0);
    expect(fx.dissolved).toBe(false);
  });

  it('does not skip the dissolve after a long hidden gap', () => {
    const fx = new Effects();
    fx.startDissolve();
    fx.update(0.1);
    const before = fx.dissolve;
    fx.resume();
    fx.update(5);
    expect(fx.dissolve - before).toBeLessThanOrEqual(0.1 / FX.dissolveSeconds + 1e-9);
    expect(fx.dissolved).toBe(false);
    // Only the first update after resume is capped.
    fx.update(5);
    expect(fx.dissolved).toBe(true);
  });
});
