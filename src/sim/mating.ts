// Mating rules (M5, DESIGN §5, ADR 0021): who may breed, what it costs, how long the cooldown is
// and how big a hatchling is. Pure and shared: clients, the authority and verifiers all call it.

import { RULES } from './rules';
import { sizeTier } from './size';
import { maxEnergy } from './vitals';

/** What the rules need to know about one creature (and its owner) at the moment of a mating. */
export interface MateView {
  creature: string;
  owner: string;
  active: boolean;
  activeMs: number;
  matureAtMs: number;
  cooldownUntilMs: number;
  biomass: number;
  energy: number;
  maxEnergy: number;
  hasPending: boolean;
  inFlight: boolean;
  /** In a committed encounter (M7); always false until then. */
  locked: boolean;
}

export type MateRefusal =
  | 'not-active'
  | 'locked'
  | 'in-flight'
  | 'pending'
  | 'not-mature'
  | 'cooldown'
  | 'low-energy'
  | 'tier'
  | 'self';

/** The first reason this creature cannot mate at all, in the order the player should fix them. */
export function ownRefusal(v: MateView): MateRefusal | null {
  if (!v.active) return 'not-active';
  if (v.locked) return 'locked';
  if (v.inFlight) return 'in-flight';
  if (v.hasPending) return 'pending';
  if (v.activeMs < v.matureAtMs) return 'not-mature';
  if (v.activeMs < v.cooldownUntilMs) return 'cooldown';
  if (v.energy < RULES.mating.minEnergyShare * v.maxEnergy) return 'low-energy';
  return null;
}

/** Why these two cannot mate with each other: the same player, or sizes more than a tier apart. */
export function pairRefusal(a: MateView, b: MateView): MateRefusal | null {
  if (a.owner === b.owner) return 'self';
  if (Math.abs(sizeTier(a.biomass) - sizeTier(b.biomass)) > RULES.mating.tierSpread) return 'tier';
  return null;
}

/** What remains after a parent pays for a mating. */
export function mateCost(biomass: number, energy: number): { biomass: number; energy: number } {
  return {
    biomass: biomass * (1 - RULES.mating.costBiomass),
    energy: energy * (1 - RULES.mating.costEnergy),
  };
}

/** The cooldown in active ms after a mating with a partner mated `priorMatings` times in the window. */
export function cooldownMs(priorMatings: number): number {
  const m = RULES.mating;
  return m.cooldownMs * (1 << Math.min(priorMatings, m.repeatMaxDoublings));
}

/** A newborn's biomass and energy, from the biomass its body can grow to. */
export function hatchling(maxBiomass: number): { biomass: number; energy: number } {
  const m = RULES.mating;
  const biomass = Math.max(m.hatchlingMinBiomass, m.hatchlingShare * maxBiomass);
  return { biomass, energy: m.hatchlingEnergyShare * maxEnergy(biomass) };
}
