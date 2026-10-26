import type { Input } from './input';
import { IDLE } from './input';
import { pow } from './math';
import { DT, RULES } from './rules';
import type { CreatureState, StepEvent, World } from './types';
import { maxEnergy } from './vitals';

/**
 * One tick of energy drain, starvation damage and growth (DESIGN §4). Growth turns surplus energy
 * into biomass while energy is above the threshold; maximum health follows the radius, so the
 * health gained with the radius is added as the creature grows.
 */
export function applyMetabolism(
  _world: World,
  creature: CreatureState,
  input: Input = IDLE,
): StepEvent[] {
  if (!creature.alive) return [];
  const m = RULES.metabolism;
  const g = RULES.growth;
  const events: StepEvent[] = [];

  const effort = input.throttle / RULES.movement.maxThrottle;
  const drain =
    m.basal * creature.phys.basal * pow(creature.biomass, m.basalExp) +
    m.move * creature.biomass * effort * effort;
  creature.energy = Math.max(0, creature.energy - drain * DT);

  if (creature.energy <= 0) {
    const amount = RULES.damage.starvation * DT;
    creature.health -= amount;
    events.push({ type: 'damage', creature: creature.id, amount, cause: 'starved' });
  }

  if (
    creature.energy > g.energyThreshold * maxEnergy(creature.biomass) &&
    creature.biomass < creature.phys.maxBiomass
  ) {
    const before = creature.biomass;
    const gained = Math.min(
      g.maxRate * creature.phys.growth * before * DT,
      creature.phys.maxBiomass - before,
    );
    creature.biomass = before + gained;
    creature.energy -= gained * g.energyPerBiomass;
    creature.health +=
      RULES.creature.healthPerRadius * (Math.sqrt(creature.biomass) - Math.sqrt(before));
    if (Math.floor(creature.biomass) > Math.floor(before)) {
      events.push({ type: 'grow', creature: creature.id, biomass: creature.biomass });
    }
  }
  return events;
}
