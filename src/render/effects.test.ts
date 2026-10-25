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

  it('raises the vignette on damage and keeps it while damage continues', () => {
    const fx = new Effects();
    expect(fx.vignette).toBe(0);
    for (let i = 0; i < 90; i++) {
      fx.onEvent({ type: 'damage', creature: 'p', amount: 0.3, cause: 'starved' }, AT);
      fx.update(1 / 30);
      expect(fx.vignette).toBeGreaterThanOrEqual(FX.vignetteFloor * 0.5);
    }
    expect(fx.snapshot().damage).toBe(90);
  });

  it('fades the vignette out after the damage stops', () => {
    const fx = new Effects();
    fx.onEvent({ type: 'damage', creature: 'p', amount: 1, cause: 'toxin' }, AT);
    const start = fx.vignette;
    expect(start).toBeGreaterThanOrEqual(FX.vignetteFloor);
    fx.update(0.2);
    expect(fx.vignette).toBeLessThan(start);
    fx.update(3);
    expect(fx.vignette).toBeLessThan(0.01);
  });

  it('stronger hits show a stronger vignette, up to 1', () => {
    const weak = new Effects();
    const strong = new Effects();
    weak.onEvent({ type: 'damage', creature: 'p', amount: 0.1, cause: 'toxin' }, AT);
    strong.onEvent({ type: 'damage', creature: 'p', amount: 50, cause: 'toxin' }, AT);
    expect(strong.vignette).toBeGreaterThan(weak.vignette);
    expect(strong.vignette).toBeLessThanOrEqual(1);
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
    fx.startDissolve();
    fx.update(0.3);
    fx.reset();
    expect(fx.snapshot()).toMatchObject({ eat: 0, dash: 0, damage: 0, rings: 0, vignette: 0 });
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
