import { applyFeeding } from './food';
import { applyHazards } from './hazards';
import { IDLE, type Input } from './input';
import { applyMetabolism } from './metabolism';
import { applyMovement } from './physics';
import type { CreatureState, StepEvent, World } from './types';

/** A creature at 0 health dies of the last damage it took this tick. */
function applyDeath(creature: CreatureState, events: StepEvent[]): StepEvent[] {
  if (!creature.alive || creature.health > 0) return [];
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type === 'damage') {
      creature.alive = false;
      creature.cause = event.cause;
      creature.health = 0;
      return [{ type: 'death', creature: creature.id, cause: event.cause }];
    }
  }
  return [];
}

/**
 * Advances the world by one tick. Per creature, in id order: movement, feeding, metabolism and
 * growth, hazards, death. A creature without an entry in `inputs` idles; a dead one does nothing.
 */
export function step(world: World, inputs: Readonly<Record<string, Input>>): StepEvent[] {
  const events: StepEvent[] = [];
  for (const creature of world.creatures) {
    const input = inputs[creature.id] ?? IDLE;
    const mine = [
      ...applyMovement(world, creature, input),
      ...applyFeeding(world, creature),
      ...applyMetabolism(world, creature, input),
      ...applyHazards(world, creature),
    ];
    events.push(...mine, ...applyDeath(creature, mine));
  }
  world.tick++;
  return events;
}
