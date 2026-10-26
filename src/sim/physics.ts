import { currentAt } from './currents';
import { IDLE, type Input, steerToAngle } from './input';
import { clamp, cos, pow, sin, wrapAngle } from './math';
import { DT, RULES } from './rules';
import type { CreatureState, StepEvent, World } from './types';

/** Soft wall: an inward push that grows towards an edge and beats full thrust. */
function wallAccel(p: number, size: number): number {
  const wall = RULES.world.wallMargin;
  if (p < wall) return ((wall - p) * RULES.movement.wallPush) / wall;
  if (p > size - wall) return ((size - wall - p) * RULES.movement.wallPush) / wall;
  return 0;
}

/**
 * One tick of steering, thrust, drag and the soft wall for a living creature (DESIGN §4).
 * Velocity is integrated before position (semi-implicit Euler). The water's current carries the
 * creature on top of its own velocity, so a passive creature drifts with the field.
 */
export function applyMovement(
  world: World,
  creature: CreatureState,
  input: Input = IDLE,
): StepEvent[] {
  if (!creature.alive) return [];
  const m = RULES.movement;
  const scale = creature.biomass / RULES.starter.biomass;
  const events: StepEvent[] = [];

  if (input.throttle > 0) {
    const maxTurn = m.turn * creature.phys.turn * pow(scale, m.turnExp) * DT;
    const diff = wrapAngle(steerToAngle(input.steer) - creature.heading);
    creature.heading = wrapAngle(creature.heading + clamp(diff, -maxTurn, maxTurn));
  }
  const dirX = cos(creature.heading);
  const dirY = sin(creature.heading);

  if (input.dash && world.tick >= creature.dashReadyTick) {
    const cost = m.dashEnergyPerBiomass * creature.biomass;
    if (creature.energy >= cost) {
      const speed =
        m.dashSpeed * pow(scale, m.dashExp) * Math.sqrt(creature.phys.thrust / creature.phys.drag);
      creature.vx += dirX * speed;
      creature.vy += dirY * speed;
      creature.energy -= cost;
      creature.dashReadyTick = world.tick + m.dashCooldownTicks;
      events.push({ type: 'dash', creature: creature.id });
    }
  }

  const thrust =
    m.thrust * creature.phys.thrust * (input.throttle / m.maxThrottle) * pow(scale, m.thrustExp);
  const drag = m.drag * creature.phys.drag;
  let ax = dirX * thrust - drag * creature.vx;
  let ay = dirY * thrust - drag * creature.vy;

  ax += wallAccel(creature.x, world.size);
  ay += wallAccel(creature.y, world.size);

  creature.vx += ax * DT;
  creature.vy += ay * DT;
  const current = currentAt(world, creature.x, creature.y);
  creature.x += (creature.vx + current.x) * DT;
  creature.y += (creature.vy + current.y) * DT;

  // Backstop: the world is closed even for a dash straight into a corner.
  if (creature.x < 0 || creature.x > world.size) {
    creature.x = clamp(creature.x, 0, world.size);
    creature.vx = 0;
  }
  if (creature.y < 0 || creature.y > world.size) {
    creature.y = clamp(creature.y, 0, world.size);
    creature.vy = 0;
  }
  return events;
}
