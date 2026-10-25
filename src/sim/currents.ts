import { cos, sin, TAU } from './math';
import { hashU32 } from './prng';
import { RULES, TICK_HZ } from './rules';
import type { Vec2, World } from './types';

// The field is a sum of shear waves, each flowing along its wave fronts, so it is divergence-free
// (curl of a stream function). Three waves of amplitude maxSpeed/3 bound the speed by maxSpeed and
// the gradient by maxSpeed * wavenumber (about 0.037 per wu).
const WAVES = 3;
const SALT = { angle: 1, phase: 2 } as const;
const WAVENUMBER = TAU / RULES.currents.spatialPeriod;
const AMPLITUDE = RULES.currents.maxSpeed / WAVES;
/** Phase advance per second of simulated time. */
const OMEGA = TAU / (RULES.currents.timePeriodTicks / TICK_HZ);

interface Wave {
  /** Unit vector along the flow (perpendicular to the wave vector). */
  fx: number;
  fy: number;
  /** Unit wave vector. */
  nx: number;
  ny: number;
  phase: number;
  /** +1 or -1: the direction the pattern travels in time. */
  sign: number;
}

const unit = (hash: number): number => (hash >>> 0) / 4294967296;

function wavesFor(world: World): Wave[] {
  const waves: Wave[] = [];
  for (let i = 0; i < WAVES; i++) {
    const angle = (i + 0.25 + 0.5 * unit(hashU32(...world.seed32, i, SALT.angle))) * (TAU / WAVES);
    const nx = cos(angle);
    const ny = sin(angle);
    waves.push({
      fx: -ny,
      fy: nx,
      nx,
      ny,
      phase: unit(hashU32(...world.seed32, i, SALT.phase)) * TAU,
      sign: i % 2 === 0 ? 1 : -1,
    });
  }
  return waves;
}

/** Position in the slow cycle, in radians; exact at any tick because it wraps on the period. */
const timePhase = (tick: number): number =>
  ((tick % RULES.currents.timePeriodTicks) / RULES.currents.timePeriodTicks) * TAU;

/** Water velocity in wu/s at a point, at `world.tick`. Zero when currents are off. */
export function currentAt(world: World, x: number, y: number): Vec2 {
  if (!world.options.currents) return { x: 0, y: 0 };
  const t = timePhase(world.tick);
  let vx = 0;
  let vy = 0;
  for (const w of wavesFor(world)) {
    const a = AMPLITUDE * cos(WAVENUMBER * (w.nx * x + w.ny * y) + w.phase + w.sign * t);
    vx += a * w.fx;
    vy += a * w.fy;
  }
  return { x: vx, y: vy };
}

/**
 * How far a point that sits still in space has been carried since tick 0: the time integral of
 * the field at that point, in closed form. Bounded by 2 * maxSpeed / OMEGA, and periodic.
 */
export function currentDriftAt(world: World, x: number, y: number): Vec2 {
  if (!world.options.currents) return { x: 0, y: 0 };
  const t = timePhase(world.tick);
  let dx = 0;
  let dy = 0;
  for (const w of wavesFor(world)) {
    const base = WAVENUMBER * (w.nx * x + w.ny * y) + w.phase;
    const d = (AMPLITUDE * w.sign * (sin(base + w.sign * t) - sin(base + 0))) / OMEGA;
    dx += d * w.fx;
    dy += d * w.fy;
  }
  return { x: dx, y: dy };
}
