// How a life client swims (M14 T13): the pacing bot's policy (`tools/pacing-report.ts`) as an object
// that steers one creature a tick at a time, and swims to a goal (a partner or an opponent) when it
// has one. Food first, away from toxic clouds and unsafe depths, as a player reads the depth gauge.

import { depthAt } from '../src/sim/bathymetry';
import { foodForTier } from '../src/sim/food';
import { plumesNear } from '../src/sim/hazards';
import { angleToSteer, type Input } from '../src/sim/input';
import { atan2 } from '../src/sim/math';
import { hashU32 } from '../src/sim/prng';
import type { CreatureState, World } from '../src/sim/types';

/** How far the bot sees food and clouds (wu). */
const SENSE = 400;
/** How far from a cloud's edge it turns away, on top of its own radius. */
const PLUME_MARGIN = 60;
/** The depths it stays within: clear of UV above (the shallows end at 0.25, and the spawn disc's twilight starts just above it) and pressure below. */
const SAFE_DEPTH: readonly [number, number] = [0.255, 0.68];
/** The policy looks again every this many ticks. */
const LOOK_EVERY = 6;
const THROTTLE = 15;

const safeDepth = (world: World, x: number, y: number): boolean => {
  const d = depthAt(world.seed32, x, y, world.size);
  return d >= SAFE_DEPTH[0] && d <= SAFE_DEPTH[1];
};

export interface Goal {
  x: number;
  y: number;
  /** Dash when this far or more from the goal (wu); omitted: never. */
  dashFrom?: number;
}

export class Forager {
  private target: { x: number; y: number } | null = null;
  private flee: { x: number; y: number } | null = null;
  private wander = 0;

  constructor(private readonly salt: number) {
    this.wander = (hashU32(salt, 1) % 628) / 100;
  }

  /** The input for this tick: to `goal` if there is one and nothing threatens, else to the nearest food. */
  input(world: World, me: CreatureState, goal: Goal | null): Input {
    if (world.tick % LOOK_EVERY === 0) this.look(world, me);
    const adrift = !safeDepth(world, me.x, me.y);
    let aim: number;
    if (this.flee) aim = atan2(me.y - this.flee.y, me.x - this.flee.x);
    else if (adrift) aim = atan2(world.size / 2 - me.y, world.size / 2 - me.x);
    else if (goal) aim = atan2(goal.y - me.y, goal.x - me.x);
    else if (this.target) aim = atan2(this.target.y - me.y, this.target.x - me.x);
    else aim = this.wander;
    const far =
      goal?.dashFrom !== undefined && Math.hypot(goal.x - me.x, goal.y - me.y) >= goal.dashFrom;
    return { steer: angleToSteer(aim), throttle: THROTTLE, dash: far && !this.flee && !adrift };
  }

  private look(world: World, me: CreatureState): void {
    let bestD = Number.POSITIVE_INFINITY;
    this.target = null;
    const clouds = plumesNear(world, me.x, me.y, SENSE);
    const margin = Math.sqrt(me.biomass) + PLUME_MARGIN;
    this.flee = null;
    let fleeD = Number.POSITIVE_INFINITY;
    for (const p of clouds) {
      const d = Math.hypot(p.x - me.x, p.y - me.y) - p.radius;
      if (d < margin && d < fleeD) {
        fleeD = d;
        this.flee = { x: p.x, y: p.y };
      }
    }
    for (const f of foodForTier(world, me.x, me.y, SENSE, 0)) {
      const d = (f.x - me.x) ** 2 + (f.y - me.y) ** 2;
      if (d >= bestD) continue;
      if (clouds.some((p) => Math.hypot(p.x - f.x, p.y - f.y) < p.radius + margin)) continue;
      if (!safeDepth(world, f.x, f.y)) continue;
      bestD = d;
      this.target = f;
    }
    if (this.target === null && world.tick % (LOOK_EVERY * 30) === 0) {
      this.wander = (hashU32(world.tick, this.salt) % 628) / 100;
    }
  }
}
