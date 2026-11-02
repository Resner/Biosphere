import { applyFeeding } from './food';
import { applyHazards } from './hazards';
import { IDLE, type Input } from './input';
import { applyMetabolism } from './metabolism';
import { applyMovement, type Movement } from './physics';
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

/** What differs between a free-roam creature and a fighter: fighters eat nothing and take stance mods. */
export interface CreatureTick {
  feeding: boolean;
  mods?: Movement;
}

const FREE_ROAM: CreatureTick = { feeding: true };

/**
 * One creature's tick: movement, feeding, metabolism and growth, hazards, death. Free-roam `step`
 * and an encounter's fighters both run exactly this, so a new per-creature rule reaches both.
 */
export function stepCreature(
  world: World,
  creature: CreatureState,
  input: Input,
  tick: CreatureTick = FREE_ROAM,
): StepEvent[] {
  const mine = applyMovement(world, creature, input, tick.mods);
  if (tick.feeding) mine.push(...applyFeeding(world, creature));
  mine.push(...applyMetabolism(world, creature, input), ...applyHazards(world, creature));
  return [...mine, ...applyDeath(creature, mine)];
}

/**
 * Advances the world by one tick. Per creature, in id order: `stepCreature`. A creature without an
 * entry in `inputs` idles; a dead one does nothing.
 */
export function step(world: World, inputs: Readonly<Record<string, Input>>): StepEvent[] {
  const events: StepEvent[] = [];
  for (const creature of world.creatures) {
    events.push(...stepCreature(world, creature, inputs[creature.id] ?? IDLE));
  }
  world.tick++;
  return events;
}
