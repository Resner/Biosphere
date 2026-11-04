import type { Genome } from '../genome/codec';
import { express } from '../genome/express';
import { buildCreature } from '../genome/stats';
import { lifespanMs } from '../sim/life';
import { exp } from '../sim/math';
import { cooldownMs, hatchling, mateCost } from '../sim/mating';
import { RULES } from '../sim/rules';
import { maxEnergy, maxHealth, starterEnergy } from '../sim/vitals';

// The one rulebook of the authority and the verifier (ADR 0055): the time gates, a creature's
// start, a mating's cost and the growth reach, in hundredths and ms. The authority enforces these
// and a verifier checks records against the same functions. Pure and shared: no DOM, no Node APIs.

/**
 * Fractions in (0, 1] that shorten the clocks of a test world: `lifespan` the lifespan, `mating`
 * maturity, the cooldown, the repeat window and the restore minimum. 1 in production.
 */
export interface Scales {
  lifespan: number;
  mating: number;
}

export const LIVE_SCALES: Scales = Object.freeze({ lifespan: 1, mating: 1 });

/** A creature's condition in hundredths. */
export interface Condition {
  biomass: number;
  energy: number;
  health: number;
}

const HUNDREDTHS = 100;
/** Growth rate allowance over the genome's own, for rounding and a tick or two of jitter. */
const GROWTH_SLACK = 1.1;
/** Biomass in wu that a condition may exceed the growth curve by, once per reach. */
const BIOMASS_SLACK = 1;

/** The life clock may run this far ahead of the wall clock (`RULES.life.accrueSlackMs`). */
export const CLOCK_SLACK_MS: number = RULES.life.accrueSlackMs;

const baseLifespan = (genome: Genome): number => lifespanMs(express(genome).physiology.lifespan);

/** The active ms at which a creature of this genome dies of old age. */
export function lifespanOf(genome: Genome, s: Scales): number {
  return Math.round(baseLifespan(genome) * s.lifespan);
}

/** The active ms from which a creature of this genome may mate: max(7 min, 10% of its unscaled lifespan). */
export function matureAtOf(genome: Genome, s: Scales): number {
  const l = RULES.life;
  return Math.round(s.mating * Math.max(l.matureMinMs, l.matureMinShare * baseLifespan(genome)));
}

/**
 * The least biomass (hundredths) at which a creature of this genome is mature: 60% of its adult
 * size, rounded up so the gate is the share itself. Sizes are never scaled.
 */
export function matureBiomassOf(genome: Genome, _s: Scales): number {
  const share = RULES.life.matureBiomassShare * buildCreature(genome).phys.maxBiomass;
  return Math.ceil(share * HUNDREDTHS);
}

/** The cooldown in active ms after a mating whose pair mated `prior` times before in the window. */
export function cooldownOf(prior: number, s: Scales): number {
  return Math.round(cooldownMs(prior) * s.mating);
}

/** How far back, in wall ms, a pair's earlier matings count towards the doubling. */
export function repeatWindowOf(s: Scales): number {
  return Math.round(RULES.mating.repeatWindowMs * s.mating);
}

/** The least life (active ms) a frozen creature must have left to be restored. */
export function restoreMinOf(s: Scales): number {
  return Math.round(RULES.mating.restoreMinMs * s.mating);
}

/** A creature's condition when its life starts: the starter cell for a genesis, the hatchling for a birth. */
export function startOf(kind: 'genesis' | 'birth', genome: Genome): Condition {
  const { biomass, energy } =
    kind === 'genesis'
      ? { biomass: RULES.starter.biomass, energy: starterEnergy(RULES.starter.biomass) }
      : hatchling(buildCreature(genome).phys.maxBiomass);
  return {
    biomass: Math.floor(biomass * HUNDREDTHS),
    energy: Math.floor(energy * HUNDREDTHS),
    health: Math.floor(maxHealth(biomass) * HUNDREDTHS),
  };
}

/** The condition after paying for a mating (hundredths, rounded down), as the `mate-commit` record keeps it. */
export function paidFor(before: Condition): Condition {
  const left = mateCost(before.biomass / HUNDREDTHS, before.energy / HUNDREDTHS);
  const biomass = Math.floor(left.biomass * HUNDREDTHS);
  return {
    biomass,
    energy: Math.floor(left.energy * HUNDREDTHS),
    // Health can't exceed what the smaller body allows.
    health: Math.min(before.health, Math.floor(maxHealth(biomass / HUNDREDTHS) * HUNDREDTHS)),
  };
}

/** The most energy and health (hundredths) a body of `biomass` hundredths holds. */
export function vitalsCap(biomass: number): { energy: number; health: number } {
  return {
    energy: Math.floor(maxEnergy(biomass / HUNDREDTHS) * HUNDREDTHS),
    health: Math.floor(maxHealth(biomass / HUNDREDTHS) * HUNDREDTHS),
  };
}

/**
 * The most biomass (hundredths, floored) a creature of growth multiplier `growth` can reach from
 * `from` hundredths over `activeMs`: max(from, starter) × exp(maxRate × growth × 1.1 × s) + 1 wu,
 * with `exp` from `src/sim/math.ts`, so every engine draws the same line.
 */
export function reachAt(from: number, growth: number, activeMs: number): number {
  const base = Math.max(from / HUNDREDTHS, RULES.starter.biomass);
  const rate = RULES.growth.maxRate * growth * GROWTH_SLACK;
  return Math.floor((base * exp(rate * (activeMs / 1000)) + BIOMASS_SLACK) * HUNDREDTHS);
}

/** `reachAt` for a genome: its own growth multiplier. */
export function growthReach(from: number, genome: Genome, activeMs: number): number {
  return reachAt(from, buildCreature(genome).phys.growth, activeMs);
}
