import { RULES } from './rules';

/** The most energy a creature of this biomass can hold. */
export const maxEnergy = (biomass: number): number => RULES.creature.energyPerBiomass * biomass;

/** The most health a creature of this biomass can have; it follows the radius. */
export const maxHealth = (biomass: number): number =>
  RULES.creature.healthPerRadius * Math.sqrt(biomass);

/** The energy a freshly hatched creature of this biomass starts with. */
export const starterEnergy = (biomass: number): number =>
  RULES.starter.energyFraction * maxEnergy(biomass);

/**
 * Adds up to `amount` biomass (never past the body's maximum) and the health the new radius brings;
 * returns what was added. Growth and a fight's kill reward both go through here.
 */
export function addBiomass(
  creature: { biomass: number; health: number; phys: { maxBiomass: number } },
  amount: number,
): number {
  const before = creature.biomass;
  const added = Math.min(amount, Math.max(0, creature.phys.maxBiomass - before));
  creature.biomass = before + added;
  creature.health +=
    RULES.creature.healthPerRadius * (Math.sqrt(creature.biomass) - Math.sqrt(before));
  return added;
}
