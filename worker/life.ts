import type { Genome } from '../src/genome/codec';
import { buildCreature } from '../src/genome/stats';
import { accrue } from '../src/sim/life';
import { mateCost } from '../src/sim/mating';
import { RULES } from '../src/sim/rules';
import { maxEnergy, maxHealth } from '../src/sim/vitals';
import type { Head } from './ledger';

// The authority's view of one creature's current session (ADR 0019): what the client last
// reported and the life clock it earned, kept in the socket's hibernation attachment (small, so
// it survives eviction without touching SQLite). Plausibility is checked here, as plain functions.

/** When spawn protection that starts at `now` ends (a genesis, a promoted child or a restore; never a resume). */
export const protectionEnds = (now: number): number =>
  now + RULES.encounter.protectionSeconds * 1000;

/** Active time since the last checkpoint after which the next progress writes one. */
export const CHECKPOINT_EVERY_MS = 900_000;
/** Growth rate allowance over the genome's own, for rounding and a tick or two of jitter. */
const GROWTH_SLACK = 1.1;
/** Biomass in wu that a report may exceed the growth curve by. */
const BIOMASS_SLACK = 1;
const HUNDREDTHS = 100;

/** A creature's condition in hundredths. */
export interface Condition {
  biomass: number;
  energy: number;
  health: number;
}

export interface LifeState extends Condition {
  creature: string;
  /** The last accepted report number (0 before any). */
  n: number;
  /** The highest tick count reported so far on this connection. */
  ticks: number;
  /** Wall time of the last report, or of the binding before the first one. */
  t: number;
  /** The creature's life clock including everything credited so far. */
  activeMs: number;
  /** When this connection started crediting, and the life clock then: the wall-time cap counts from here. */
  boundT: number;
  boundMs: number;
  /** The life clock when the creature's last record was written. */
  savedMs: number;
  /** The report number that the last record covers. */
  savedN: number;
  /** The active time at which this creature dies of old age (the genome's lifespan, scaled in fixture mode). */
  lifespanMs: number;
  /** The active time from which the creature may mate (ADR 0021) and until which it is in cooldown. */
  matureAtMs: number;
  cooldownUntilMs: number;
  /** Set once the creature has died on this connection: it takes no more reports. */
  over: boolean;
  /** What the genome allows (`physOf`): the largest body and the growth multiplier. */
  maxBiomass: number;
  growth: number;
  /** Bit `i` is set once `FLAG_KINDS[i]` was noted on this connection, so a client that keeps sending it costs no more reads. */
  flagged: number;
}

export type Report = Condition & { n: number; ticks: number };

const FLAG_KINDS = ['biomass-over-max', 'growth-too-fast', 'energy-over', 'health-over'] as const;
export type Implausible = (typeof FLAG_KINDS)[number];

/** A session starts crediting the creature from `now`, with the condition and clock the ledger has. */
export function bindLife(
  head: Pick<Head, 'id' | 'activeMs' | 'biomass' | 'energy' | 'health' | 'cooldownUntilMs'>,
  genome: Genome,
  now: number,
  lifespanMs: number,
  matureAtMs: number,
): LifeState {
  const { maxBiomass, growth } = buildCreature(genome).phys;
  return {
    creature: head.id,
    n: 0,
    ticks: 0,
    t: now,
    activeMs: head.activeMs,
    boundT: now,
    boundMs: head.activeMs,
    savedMs: head.activeMs,
    savedN: 0,
    biomass: head.biomass,
    energy: head.energy,
    health: head.health,
    lifespanMs,
    matureAtMs,
    cooldownUntilMs: head.cooldownUntilMs,
    over: false,
    maxBiomass,
    growth,
    flagged: 0,
  };
}

/** Active time to credit for `ticks` now: `accrue`, within this connection's wall-time cap and the lifespan. */
function credited(life: LifeState, ticks: number, now: number): number {
  // `accrue` caps one report at its own wall time plus slack; the connection as a whole gets the slack once.
  const allowed = now - life.boundT + RULES.life.accrueSlackMs - (life.activeMs - life.boundMs);
  const left = life.lifespanMs - life.activeMs;
  return Math.floor(Math.max(0, Math.min(accrue(life.ticks, ticks, now - life.t), allowed, left)));
}

/** Credits the ticks played since the last report, as a death request carries them; no condition changes. */
export function creditTicks(life: LifeState, ticks: number, now: number): LifeState {
  return {
    ...life,
    ticks: Math.max(life.ticks, ticks),
    t: now,
    activeMs: life.activeMs + credited(life, ticks, now),
  };
}

/** Whether the creature's active time has reached its lifespan. */
export const isOld = (life: LifeState): boolean => life.activeMs >= life.lifespanMs;

/** A condition clamped to what the genome and `seconds` of growth since the last report allow (hundredths). */
interface Clamped {
  condition: Condition;
  /** `life.flagged` with the kinds clamped for added. */
  flagged: number;
  /** The kinds clamped for that this connection had not noted before. */
  newFlags: Implausible[];
}

/**
 * Clamps a claimed condition to the growth curve a creature of this genome can follow from the
 * last report, over `seconds` of play. A value within `tolerance` (a share) of its cap is clamped
 * without a flag, for claims quantised on the way (a snapshot's biomass).
 */
function clampCondition(
  life: LifeState,
  claim: Condition,
  seconds: number,
  tolerance = 0,
): Clamped {
  const clamped: Implausible[] = [];
  const clamp = (value: number, cap: number, kind: Implausible): number => {
    if (value <= cap) return value;
    if (value > cap * (1 + tolerance)) clamped.push(kind);
    return cap;
  };

  // The curve a creature of this genome can follow from where the last report left it.
  const from = Math.max(life.biomass / HUNDREDTHS, RULES.starter.biomass);
  const reach =
    from * Math.exp(RULES.growth.maxRate * life.growth * GROWTH_SLACK * seconds) + BIOMASS_SLACK;
  const biomass = clamp(
    clamp(claim.biomass, Math.floor(life.maxBiomass * HUNDREDTHS), 'biomass-over-max'),
    Math.floor(reach * HUNDREDTHS),
    'growth-too-fast',
  );
  const energy = clamp(
    claim.energy,
    Math.floor(maxEnergy(biomass / HUNDREDTHS) * HUNDREDTHS),
    'energy-over',
  );
  const health = clamp(
    claim.health,
    Math.floor(maxHealth(biomass / HUNDREDTHS) * HUNDREDTHS),
    'health-over',
  );

  let flagged = life.flagged;
  const newFlags = clamped.filter((kind) => {
    const bit = 1 << FLAG_KINDS.indexOf(kind);
    const isNew = (flagged & bit) === 0;
    flagged |= bit;
    return isNew;
  });
  return { condition: { biomass, energy, health }, flagged, newFlags };
}

/**
 * Credits a report: advances the life clock by `accrue`, and clamps the reported condition to what
 * the genome and the elapsed active time allow. Never rejects; the kinds it clamped for and had not
 * noted before on this connection come back.
 */
export function applyReport(
  life: LifeState,
  report: Report,
  now: number,
): { life: LifeState; newFlags: Implausible[] } {
  const gained = credited(life, report.ticks, now);
  const { condition, flagged, newFlags } = clampCondition(life, report, gained / 1000);
  return {
    life: {
      ...life,
      n: report.n,
      ticks: Math.max(life.ticks, report.ticks),
      t: now,
      activeMs: life.activeMs + gained,
      ...condition,
      flagged,
    },
    newFlags,
  };
}

/**
 * A condition claimed outside a report (a signed snapshot at lock-in, ADR 0050), clamped by the
 * same growth curve over the wall time since the last report. Nothing is credited.
 */
export function clampClaim(
  life: LifeState,
  claim: Condition,
  now: number,
  tolerance: number,
): Clamped {
  return clampCondition(life, claim, Math.max(0, now - life.t) / 1000, tolerance);
}

/** Whether the creature has played since its last record, so a close should write one. */
export const unsaved = (life: LifeState): boolean => life.n > life.savedN;

/**
 * The condition a fight left the creature in (ADR 0050). It is unsaved until the next record, so a
 * close or a death writes it: `savedN` drops below `n` without a report of its own.
 */
export const takeResult = (life: LifeState, condition: Condition): LifeState => ({
  ...life,
  ...condition,
  savedN: Math.min(life.savedN, life.n - 1),
});

/** Whether a progress report is due a checkpoint of its own: 15 minutes of active time since the last. */
export const checkpointDue = (life: LifeState): boolean =>
  life.activeMs - life.savedMs >= CHECKPOINT_EVERY_MS;

/** The condition after paying for a mating (hundredths, rounded down), as the `mate-commit` record keeps it. */
export function paidFor(life: Condition): Condition {
  const left = mateCost(life.biomass / HUNDREDTHS, life.energy / HUNDREDTHS);
  const biomass = Math.floor(left.biomass * HUNDREDTHS);
  return {
    biomass,
    energy: Math.floor(left.energy * HUNDREDTHS),
    // Health can't exceed what the smaller body allows.
    health: Math.min(life.health, Math.floor(maxHealth(biomass / HUNDREDTHS) * HUNDREDTHS)),
  };
}
