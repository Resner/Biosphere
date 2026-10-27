// Life rules (M4, DESIGN §5, ADR 0019): lifespan, maturity and old age run on active time, which
// the authority accrues; the sim only sees the two moments it is told about (`elder`, `expire`).

import { mateCost } from './mating';
import { RULES, TICK_HZ } from './rules';
import type { StepEvent, World } from './types';
import { maxHealth } from './vitals';

export type LifeStage = 'young' | 'mature' | 'old';
export type LifeEventKind = 'elder' | 'expire' | 'mate';
/** `[tick, kind]`: the authority's call that a creature turned elder, ran out of time or mated. */
export type LifeEvent = readonly [tick: number, kind: LifeEventKind];

/** The lifespan in ms of active time for a lifespan trait value (no genome import in the sim). */
export function lifespanMs(lifespanTrait: number): number {
  return RULES.life.lifespanBaseMs * lifespanTrait;
}

/**
 * Old beats mature beats young; mature needs both enough active time and enough biomass. The
 * authority's `matureAtMs` (M5) replaces the active-time rule when given.
 */
export function lifeStage(
  activeMs: number,
  lifespan: number,
  biomass: number,
  maxBiomass: number,
  matureAtMs?: number,
): LifeStage {
  const l = RULES.life;
  if (activeMs >= l.elderAt * lifespan) return 'old';
  const needMs = matureAtMs ?? Math.max(l.matureMinMs, l.matureMinShare * lifespan);
  return activeMs >= needMs && biomass >= l.matureBiomassShare * maxBiomass ? 'mature' : 'young';
}

/**
 * Active time to credit for a progress report: the ticks played since the last one, at most the
 * wall time since then plus a little slack, so nobody ages faster than real time.
 */
export function accrue(prevTicks: number, ticks: number, wallMs: number): number {
  // Written so that NaN fails the test and credits nothing.
  if (!(ticks > prevTicks && wallMs >= 0)) return 0;
  const claimedMs = ((ticks - prevTicks) * 1000) / TICK_HZ;
  return Math.min(claimedMs, wallMs + RULES.life.accrueSlackMs);
}

/**
 * Applies a life event to a creature: `elder` sets the flag, `expire` kills it of old age and
 * `mate` pays the mating cost (the radius follows the biomass; health is clamped to its maximum).
 */
export function applyLife(world: World, creatureId: string, kind: LifeEventKind): StepEvent[] {
  const creature = world.creatures.find((c) => c.id === creatureId);
  if (creature === undefined || !creature.alive) return [];
  if (kind === 'elder') {
    creature.elder = true;
    return [];
  }
  if (kind === 'mate') {
    const left = mateCost(creature.biomass, creature.energy);
    creature.biomass = left.biomass;
    creature.energy = left.energy;
    creature.health = Math.min(creature.health, maxHealth(creature.biomass));
    return [];
  }
  creature.alive = false;
  creature.health = 0;
  creature.cause = 'old-age';
  return [{ type: 'death', creature: creature.id, cause: 'old-age' }];
}
