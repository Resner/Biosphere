import { applyFeeding } from './food';
import { IDLE, type Input } from './input';
import { applyMovement } from './physics';
import type { StepEvent, World } from './types';

/**
 * Advances the world by one tick. Per creature, in id order: movement, feeding (metabolism,
 * hazards and death join in T5). A creature without an entry in `inputs` idles.
 */
export function step(world: World, inputs: Readonly<Record<string, Input>>): StepEvent[] {
  const events: StepEvent[] = [];
  for (const creature of world.creatures) {
    events.push(...applyMovement(world, creature, inputs[creature.id] ?? IDLE));
    events.push(...applyFeeding(world, creature));
  }
  world.tick++;
  return events;
}
