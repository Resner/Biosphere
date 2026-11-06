import { describe, expect, it } from 'vitest';
import { fighterOf } from '../src/genome/fighter';
import { buildCreature } from '../src/genome/stats';
import { decodeSnapshot, encodeSnapshot, type Snapshot } from '../src/net/protocol';
import { type PhysStats, STARTER_PHYS } from '../src/sim/body';
import { currentAt } from '../src/sim/currents';
import { angleToSteer } from '../src/sim/input';
import { atan2 } from '../src/sim/math';
import { applyMovement } from '../src/sim/physics';
import { createRng, type Rng } from '../src/sim/prng';
import { RULES, TICK_HZ } from '../src/sim/rules';
import { maxEnergy } from '../src/sim/vitals';
import { createWorld, spawnCreature } from '../src/sim/world';
import { heavyTest } from '../tests/heavy';
import { wildGenome } from '../tests/wild';
import {
  dashSpeedOf,
  jumped,
  MOVE_SLACK_WU,
  moveBound,
  type PathPoint,
  SPEED_MARGIN,
  swimSpeed,
} from './movement';

// M10 T11 (ADR 0059): the movement check at lock-in. Honest swimming through the sim's own physics
// never trips the bound; a jump does.

const M = RULES.movement;
const SIZE = RULES.world.size;
const WALL = RULES.world.wallMargin;

describe('the bound', () => {
  it('is (1.25 × top speed + dash speed + the strongest current) × the time, plus 8 wu', () => {
    const top = M.thrust / M.drag;
    expect(swimSpeed(STARTER_PHYS, 100)).toBeCloseTo(top, 9);
    expect(dashSpeedOf(STARTER_PHYS, 100)).toBeCloseTo(M.dashSpeed, 9);
    expect(SPEED_MARGIN).toBe(1.25);
    expect(MOVE_SLACK_WU).toBe(8);
    const speed = 1.25 * top + M.dashSpeed + RULES.currents.maxSpeed;
    expect(moveBound(STARTER_PHYS, 100, 0.5)).toBeCloseTo(speed * 0.5 + 8, 9);
    expect(moveBound(STARTER_PHYS, 100, 0)).toBe(8);
    // A bigger body swims and dashes slower.
    expect(moveBound(STARTER_PHYS, 5000, 1)).toBeLessThan(moveBound(STARTER_PHYS, 100, 1));
  });
});

const point = (tick: number, x: number, y = 4000): PathPoint => ({ tick, x, y });

describe('jumps trip it', () => {
  it('a 200 wu jump between two snapshots 200 ms apart', () => {
    expect(jumped([point(100, 1000), point(106, 1200)], STARTER_PHYS, 100)).toBe(true);
    expect(jumped([point(100, 1000), point(106, 1040)], STARTER_PHYS, 100)).toBe(false);
  });

  it('a snapshot 150 wu from its neighbour 100 ms before it', () => {
    expect(jumped([point(97, 850), point(100, 1000)], STARTER_PHYS, 100)).toBe(true);
  });

  it('orders the path by tick, whatever order it comes in', () => {
    // In order 0, 6, 12 each step is 30 wu; as given, 0 → 12 → 6 would look like nothing.
    const far = [point(0, 1000), point(12, 1400), point(6, 1200)];
    expect(jumped(far, STARTER_PHYS, 100)).toBe(true);
    const near = [point(12, 1060), point(0, 1000), point(6, 1030)];
    expect(jumped(near, STARTER_PHYS, 100)).toBe(false);
  });

  it('takes 8 wu between snapshots of the same tick, and no path shorter than two', () => {
    expect(jumped([point(50, 1000), point(50, 1007)], STARTER_PHYS, 100)).toBe(false);
    expect(jumped([point(50, 1000), point(50, 1009)], STARTER_PHYS, 100)).toBe(true);
    expect(jumped([point(50, 1000)], STARTER_PHYS, 100)).toBe(false);
    expect(jumped([], STARTER_PHYS, 100)).toBe(false);
  });
});

/** Where a path starts and how it steers: open water in a strong current, or against a wall or a corner. */
type Scene = 'current' | 'wall' | 'corner' | 'wander';
const SCENES: Scene[] = ['current', 'wall', 'corner', 'wander'];

/** The strongest current among a few random points of the world, and that point. */
function strongest(rng: Rng, world: ReturnType<typeof createWorld>) {
  let best = { x: SIZE / 2, y: SIZE / 2, speed: -1 };
  for (let k = 0; k < 48; k++) {
    const x = WALL * 3 + rng.next() * (SIZE - WALL * 6);
    const y = WALL * 3 + rng.next() * (SIZE - WALL * 6);
    const c = currentAt(world, x, y);
    const speed = Math.hypot(c.x, c.y);
    if (speed > best.speed) best = { x, y, speed };
  }
  return best;
}

/**
 * One honest path: full throttle and a dash at every cooldown (energy kept full, as a well-fed
 * creature's is), through the sim's own movement, currents and soft walls. Every tick's snapshot,
 * as the wire quantises it.
 */
function honestPath(seed: number, phys: PhysStats, biomass: number, scene: Scene): Snapshot[] {
  const rng = createRng([seed, 11, 7, 2026], 'honest-path');
  const world = createWorld({ seed: `honest-${seed}` });
  world.tick = rng.int(0, RULES.currents.timePeriodTicks);
  let x = WALL * 4 + rng.next() * (SIZE - WALL * 8);
  let y = WALL * 4 + rng.next() * (SIZE - WALL * 8);
  if (scene === 'current') ({ x, y } = strongest(rng, world));
  if (scene === 'wall') x = rng.next() * WALL;
  if (scene === 'corner') {
    x = SIZE - rng.next() * WALL;
    y = SIZE - rng.next() * WALL;
  }
  const c = spawnCreature(world, { id: 'a', x, y, biomass, phys });
  c.heading = rng.next() * 2 * Math.PI;
  // Into the wall first, then away from it once in it.
  let steer = scene === 'wall' ? angleToSteer(Math.PI) : rng.int(0, 255);
  if (scene === 'corner') steer = angleToSteer(Math.PI / 4);
  const turnAt = scene === 'wall' || scene === 'corner' ? rng.int(60, 100) : rng.int(10, 60);
  const out: Snapshot[] = [];
  for (let t = 0; t < 150; t++) {
    c.energy = maxEnergy(c.biomass);
    if (scene === 'current') {
      const w = currentAt(world, c.x, c.y);
      steer = angleToSteer(atan2(w.y, w.x));
    } else if (t === turnAt) {
      steer =
        scene === 'wall' ? 0 : scene === 'corner' ? angleToSteer(-Math.PI * 0.75) : rng.int(0, 255);
    } else if (scene === 'wander' && rng.next() < 0.05) {
      steer = rng.int(0, 255);
    }
    applyMovement(world, c, { steer, throttle: M.maxThrottle, dash: true });
    world.tick++;
    const bytes = encodeSnapshot({
      seq: t,
      tick: world.tick,
      x: c.x,
      y: c.y,
      heading: c.heading,
      vx: c.vx,
      vy: c.vy,
      biomass: c.biomass,
      energy: 1,
      health: 1,
      alive: true,
      dashing: false,
      ready: false,
      egg: false,
      spawnProtected: false,
      fighting: false,
      genomeRef: 0,
    });
    out.push(decodeSnapshot(bytes) as Snapshot);
  }
  return out;
}

/** Every `stride`-th snapshot from `offset`: a target's view of the path at that spacing. */
const every = (path: readonly Snapshot[], stride: number, offset: number) =>
  path.filter((_, i) => i >= offset && (i - offset) % stride === 0);

describe('no false alarms', () => {
  heavyTest('1,000 seeded honest paths never trip the bound, at 100 and 5,000 biomass', () => {
    let worst = 0;
    let paths = 0;
    let walled = 0;
    let dashes = 0;
    for (let seed = 0; seed < 1000; seed++) {
      const biomass = seed % 2 === 0 ? 100 : 5000;
      // A quarter swim as the starter cell; the rest as wild bodies, to the ends of the speed band.
      const phys =
        seed % 4 < 1 ? STARTER_PHYS : fighterOf(buildCreature(wildGenome([seed, 3, 5, 8]))).phys;
      const scene = SCENES[Math.floor(seed / 2) % SCENES.length] as Scene;
      const path = honestPath(seed, phys, biomass, scene);
      if (path.some((s) => Math.min(s.x, s.y, SIZE - s.x, SIZE - s.y) < WALL)) walled++;
      // A dash at every cooldown: the speed jumps past the top speed that often.
      const top = swimSpeed(phys, biomass);
      dashes += path.filter((s) => Math.hypot(s.vx, s.vy) > top * 1.3).length > 0 ? 1 : 0;
      for (const stride of [1, 2, 3, 6, 9, 15, 30, 60]) {
        const seen = every(path, stride, seed % stride);
        expect(jumped(seen, phys, biomass), `seed ${seed} ${scene} stride ${stride}`).toBe(false);
      }
      for (let i = 1; i < path.length; i++) {
        for (const back of [1, 3, 6, 30, 60]) {
          const a = path[i - back];
          const b = path[i] as Snapshot;
          if (!a) continue;
          const d = Math.hypot(b.x - a.x, b.y - a.y);
          worst = Math.max(worst, d / moveBound(phys, biomass, (b.tick - a.tick) / TICK_HZ));
        }
      }
      paths++;
    }
    expect(paths).toBe(1000);
    // The soft walls were met by every wall and corner path, and every path dashed.
    expect(walled).toBeGreaterThanOrEqual(500);
    expect(dashes).toBe(1000);
    // Honest swimming keeps clear of the bound, not just under it.
    expect(worst).toBeLessThan(0.9);
  });
});
