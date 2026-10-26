import { genomeFromBase64url } from '../src/genome/codec';
import { buildCreature } from '../src/genome/stats';
import { accrue } from '../src/sim/life';
import { RULES } from '../src/sim/rules';
import { maxEnergy, maxHealth } from '../src/sim/vitals';

// The authority's view of one creature's current session (ADR 0019): what the client last
// reported and the life clock it earned, kept in the socket's hibernation attachment (small, so
// it survives eviction without touching SQLite). Plausibility is checked here, as plain functions.

/** Active time since the last checkpoint after which the next progress writes one. */
export const CHECKPOINT_EVERY_MS = 900_000;
/** Growth rate allowance over the genome's own, for rounding and a tick or two of jitter. */
const GROWTH_SLACK = 1.1;
/** Biomass in wu that a report may exceed the growth curve by. */
const BIOMASS_SLACK = 1;
const HUNDREDTHS = 100;

export interface LifeState {
  creature: string;
  /** The last accepted report number (0 before any). */
  n: number;
  /** The highest tick count reported so far on this connection. */
  ticks: number;
  /** Wall time of the last report, or of the binding before the first one. */
  t: number;
  /** The creature's life clock including everything credited so far. */
  activeMs: number;
  /** The life clock when the creature's last record was written. */
  savedMs: number;
  /** The report number that the last record covers. */
  savedN: number;
  /** The condition after clamping, in hundredths. */
  biomass: number;
  energy: number;
  health: number;
}

export interface Report {
  n: number;
  ticks: number;
  biomass: number;
  energy: number;
  health: number;
}

/** What a creature's genome allows: the largest body and how fast it can grow. */
interface Limits {
  maxBiomass: number;
  growth: number;
}

const limitsCache = new Map<string, Limits>();
const LIMITS_CACHE_MAX = 64;

/** The limits of a genome text; a genome that doesn't decode gets the unbounded-growth-free reference. */
export function limitsOf(genomeText: string): Limits {
  const cached = limitsCache.get(genomeText);
  if (cached) return cached;
  const genome = genomeFromBase64url(genomeText);
  const stats = genome ? buildCreature(genome).stats : null;
  const limits = {
    maxBiomass: stats?.maxBiomass ?? RULES.starter.biomass,
    growth: stats?.growth ?? 1,
  };
  if (limitsCache.size >= LIMITS_CACHE_MAX) limitsCache.clear();
  limitsCache.set(genomeText, limits);
  return limits;
}

/** A session starts crediting the creature from `now`, with the condition and clock the ledger has. */
export function bindLife(
  head: { id: string; activeMs: number; biomass: number; energy: number; health: number },
  now: number,
): LifeState {
  return {
    creature: head.id,
    n: 0,
    ticks: 0,
    t: now,
    activeMs: head.activeMs,
    savedMs: head.activeMs,
    savedN: 0,
    biomass: head.biomass,
    energy: head.energy,
    health: head.health,
  };
}

export type Implausible = 'biomass-over-max' | 'growth-too-fast' | 'energy-over' | 'health-over';

/**
 * Credits a report: advances the life clock by `accrue`, and clamps the reported condition to what
 * the genome and the elapsed active time allow. Never rejects; the reasons it clamped come back.
 */
export function applyReport(
  life: LifeState,
  report: Report,
  now: number,
  limits: Limits,
): { life: LifeState; flags: Implausible[] } {
  const gained = Math.floor(accrue(life.ticks, report.ticks, now - life.t));
  const seconds = gained / 1000;
  const flags: Implausible[] = [];

  // The curve a creature of this genome can follow from where the last report left it.
  const from = Math.max(life.biomass / HUNDREDTHS, RULES.starter.biomass);
  const reach =
    from * Math.exp(RULES.growth.maxRate * limits.growth * GROWTH_SLACK * seconds) + BIOMASS_SLACK;
  let biomass = report.biomass;
  const cap = Math.floor(limits.maxBiomass * HUNDREDTHS);
  if (biomass > cap) {
    biomass = cap;
    flags.push('biomass-over-max');
  }
  const grown = Math.floor(reach * HUNDREDTHS);
  if (biomass > grown) {
    biomass = grown;
    flags.push('growth-too-fast');
  }
  const energyCap = Math.floor(maxEnergy(biomass / HUNDREDTHS) * HUNDREDTHS);
  const healthCap = Math.floor(maxHealth(biomass / HUNDREDTHS) * HUNDREDTHS);
  const energy = Math.min(report.energy, energyCap);
  const health = Math.min(report.health, healthCap);
  if (energy < report.energy) flags.push('energy-over');
  if (health < report.health) flags.push('health-over');

  return {
    life: {
      ...life,
      n: report.n,
      ticks: Math.max(life.ticks, report.ticks),
      t: now,
      activeMs: life.activeMs + gained,
      biomass,
      energy,
      health,
    },
    flags,
  };
}

/** Whether the creature has played since its last record, so a close should write one. */
export const unsaved = (life: LifeState): boolean => life.n > life.savedN;

/** Whether a progress report is due a checkpoint of its own: 15 minutes of active time since the last. */
export const checkpointDue = (life: LifeState): boolean =>
  life.activeMs - life.savedMs >= CHECKPOINT_EVERY_MS;
