import { describe, expect, it } from 'vitest';
import { currentAt } from './currents';
import { length } from './math';
import { createRng, seedFromString } from './prng';
import { DT, RULES } from './rules';
import { step } from './step';
import { createWorld, spawnCreature } from './world';

const pond = (seed = 'cur') => createWorld({ seed, hazards: false });

describe('currentAt', () => {
  it('is zero when currents are off', () => {
    const w = createWorld({ seed: 'cur', currents: false });
    expect(currentAt(w, 1000, 1000)).toEqual({ x: 0, y: 0 });
  });

  it('is deterministic and varies with the seed and the tick', () => {
    const a = currentAt(pond(), 1234, 987);
    expect(currentAt(pond(), 1234, 987)).toEqual(a);
    expect(currentAt(pond('other'), 1234, 987)).not.toEqual(a);
    const w = pond();
    w.tick = 900;
    expect(currentAt(w, 1234, 987)).not.toEqual(a);
  });

  it('repeats after the time period', () => {
    const w = pond();
    const a = currentAt(w, 500, 700);
    w.tick = RULES.currents.timePeriodTicks;
    const b = currentAt(w, 500, 700);
    expect(b.x).toBeCloseTo(a.x, 9);
    expect(b.y).toBeCloseTo(a.y, 9);
  });

  it('never exceeds 12 wu/s and is smooth over 1 wu', () => {
    const rng = createRng(seedFromString('cur-samples'), 'test');
    const w = pond();
    for (let i = 0; i < 20000; i++) {
      w.tick = rng.int(0, 7200);
      const x = rng.range(0, w.size);
      const y = rng.range(0, w.size);
      const c = currentAt(w, x, y);
      expect(length(c.x, c.y)).toBeLessThanOrEqual(RULES.currents.maxSpeed);
      const angle = rng.range(0, 6.2831853);
      const n = currentAt(w, x + Math.cos(angle), y + Math.sin(angle));
      expect(length(n.x - c.x, n.y - c.y)).toBeLessThan(0.05);
    }
  });

  it('carries a passive creature by the field integral', () => {
    const w = pond();
    const c = spawnCreature(w, { id: 'a', x: 3000, y: 3000 });
    const ticks = 900;
    // Reference: midpoint rule with 20 substeps per tick on a scratch world.
    const ref = pond();
    let rx = 3000;
    let ry = 3000;
    const sub = 20;
    for (let i = 0; i < ticks * sub; i++) {
      ref.tick = (i + 0.5) / sub;
      const v = currentAt(ref, rx, ry);
      rx += (v.x * DT) / sub;
      ry += (v.y * DT) / sub;
    }
    for (let i = 0; i < ticks; i++) step(w, {});
    const moved = length(rx - 3000, ry - 3000);
    expect(moved).toBeGreaterThan(20);
    expect(length(c.x - rx, c.y - ry)).toBeLessThan(moved * 0.01);
  });
});
