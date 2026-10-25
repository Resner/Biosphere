import { describe, expect, it } from 'vitest';
import { IDLE, type Input } from './input';
import { length } from './math';
import { applyMovement } from './physics';
import { RULES } from './rules';
import type { CreatureState, StepEvent, World } from './types';
import { createWorld, spawnCreature } from './world';

const setup = (x = 4096, y = 4096, biomass = 100): [World, CreatureState] => {
  const world = createWorld({ seed: 'phys', currents: false, hazards: false });
  return [world, spawnCreature(world, { id: 'a', x, y, biomass })];
};

/** Runs the movement rule alone, advancing the tick by hand. */
const run = (world: World, creature: CreatureState, ticks: number, input: Input): StepEvent[] => {
  const events: StepEvent[] = [];
  for (let i = 0; i < ticks; i++) {
    events.push(...applyMovement(world, creature, input));
    world.tick++;
  }
  return events;
};

const full: Input = { steer: 0, throttle: 15, dash: false };

describe('applyMovement', () => {
  it('accelerates a starter east by the closed-form distance', () => {
    const [world, c] = setup();
    run(world, c, 60, full);
    expect(c.x - 4096).toBeGreaterThan(98.7 * 0.95);
    expect(c.x - 4096).toBeLessThan(98.7 * 1.05);
    expect(c.y).toBeCloseTo(4096, 9);
  });

  it('settles near the 64 wu/s top speed', () => {
    const [world, c] = setup();
    run(world, c, 300, full);
    expect(length(c.vx, c.vy)).toBeGreaterThan(62);
    expect(length(c.vx, c.vy)).toBeLessThan(64);
  });

  it('coasts to a stop under drag', () => {
    const [world, c] = setup();
    c.vx = 60;
    run(world, c, 90, IDLE);
    expect(length(c.vx, c.vy)).toBeLessThan(0.1);
  });

  it('turns toward the steer angle at 5 rad/s and thrusts along the heading', () => {
    const [world, c] = setup();
    run(world, c, 1, { steer: 128, throttle: 15, dash: false });
    expect(c.heading).toBeCloseTo(5 / 30, 12);
    run(world, c, 29, { steer: 128, throttle: 15, dash: false });
    expect(Math.abs(c.heading)).toBeCloseTo(Math.PI, 9);
    // thrust follows the heading, so the creature still has its sideways drift component.
    expect(c.vy).toBeGreaterThan(0);
  });

  it('turns the short way round', () => {
    const [world, c] = setup();
    run(world, c, 5, { steer: 192, throttle: 15, dash: false });
    expect(c.heading).toBeLessThan(0);
  });

  it('keeps its heading while the throttle is zero', () => {
    const [world, c] = setup();
    c.heading = 1;
    run(world, c, 10, { steer: 200, throttle: 0, dash: false });
    expect(c.heading).toBe(1);
  });

  it('dashes along the heading for 6 energy, then ignores a second dash within 75 ticks', () => {
    const [world, c] = setup();
    const dash: Input = { steer: 0, throttle: 0, dash: true };
    const first = run(world, c, 1, dash);
    expect(first).toEqual([{ type: 'dash', creature: 'a' }]);
    expect(c.energy).toBeCloseTo(120 - 6, 12);
    expect(c.vx).toBeCloseTo(120 * (1 - 2.2 / 30), 9); // the tick's drag applies too
    expect(c.dashReadyTick).toBe(75);
    const vx = c.vx;
    expect(run(world, c, 74, dash)).toEqual([]);
    expect(c.energy).toBeCloseTo(114, 12);
    expect(c.vx).toBeLessThan(vx);
    expect(run(world, c, 1, dash)).toHaveLength(1);
  });

  it('cannot dash without the energy for it', () => {
    const [world, c] = setup();
    c.energy = 5;
    expect(run(world, c, 1, { steer: 0, throttle: 0, dash: true })).toEqual([]);
    expect(c.energy).toBe(5);
    expect(c.vx).toBe(0);
  });

  it('ignores a dead creature', () => {
    const [world, c] = setup();
    c.alive = false;
    c.vx = 10;
    expect(run(world, c, 5, { steer: 0, throttle: 15, dash: true })).toEqual([]);
    expect(c.x).toBe(4096);
    expect(c.vx).toBe(10);
  });

  it('never leaves the world at any edge', () => {
    for (const [steer, sx, sy] of [
      [128, 100, 4096],
      [0, 8092, 4096],
      [64, 4096, 8092],
      [192, 4096, 100],
    ] as const) {
      const [world, c] = setup(sx, sy);
      const input: Input = { steer, throttle: 15, dash: true };
      for (let i = 0; i < 300; i++) {
        applyMovement(world, c, input);
        world.tick++;
        expect(c.x).toBeGreaterThanOrEqual(0);
        expect(c.x).toBeLessThanOrEqual(world.size);
        expect(c.y).toBeGreaterThanOrEqual(0);
        expect(c.y).toBeLessThanOrEqual(world.size);
      }
    }
  });

  it('is gentler away from the wall: no push outside the margin', () => {
    const [world, c] = setup(RULES.world.wallMargin + 1, 4096);
    run(world, c, 1, IDLE);
    expect(c.vx).toBe(0);
  });

  it('thrusts less when larger', () => {
    const [w1, small] = setup(4096, 4096, 100);
    const [w2, big] = setup(4096, 4096, 400);
    run(w1, small, 30, full);
    run(w2, big, 30, full);
    expect(big.x - 4096).toBeLessThan(small.x - 4096);
  });
});
