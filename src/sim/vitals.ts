import { RULES } from './rules';

/** The most energy a creature of this biomass can hold. */
export const maxEnergy = (biomass: number): number => RULES.creature.energyPerBiomass * biomass;

/** The most health a creature of this biomass can have; it follows the radius. */
export const maxHealth = (biomass: number): number =>
  RULES.creature.healthPerRadius * Math.sqrt(biomass);

/** The energy a freshly hatched creature of this biomass starts with. */
export const starterEnergy = (biomass: number): number =>
  RULES.starter.energyFraction * maxEnergy(biomass);
