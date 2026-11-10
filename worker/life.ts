import type { Genome } from '../src/genome/codec';
import { buildCreature } from '../src/genome/stats';
import {
  CLOCK_SLACK_MS,
  type Condition,
  HUNDREDTHS,
  reachAt,
  vitalsCap,
} from '../src/ledger/gates';
import { accrue } from '../src/sim/life';
import { RULES, TICK_HZ } from '../src/sim/rules';
import { CREATURE_FLAGS, type CreatureFlag } from './audit';
import type { Head } from './ledger';

export type { Condition };

// The authority's view of one creature's current session (ADR 0019): what the client last
// reported and the life clock it earned, kept in the socket's hibernation attachment (small, so
// it survives eviction without touching SQLite). Plausibility is checked here, as plain functions.
// The bounds hold per record interval (ADR 0055), as a verifier sees them: the clock and the
// growth since the creature's last record (or this connection's binding, which comes later).

/** When spawn protection that starts at `now` ends (a genesis, a promoted child or a restore; never a resume). */
export const protectionEnds = (now: number): number =>
  now + RULES.encounter.protectionSeconds * 1000;

/** Active time since the last checkpoint after which the next progress writes one. */
export const CHECKPOINT_EVERY_MS = 900_000;

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
  /** When this connection bound the creature: the ticks it reports count from here. */
  startT: number;
  /**
   * The creature's last record on this connection (or the binding before one): its time, life clock
   * and biomass. The clock's credit and the growth since count from here, with one slack each.
   */
  boundT: number;
  boundMs: number;
  boundBiomass: number;
  /** The life clock when the creature's last record was written. */
  savedMs: number;
  /** The report number that the last record covers. */
  savedN: number;
  /** The active time at which this creature dies of old age (the genome's lifespan, scaled in fixture mode). */
  lifespanMs: number;
  /** The active time from which the creature may mate (ADR 0021) and until which it is in cooldown. */
  matureAtMs: number;
  /** The least biomass (hundredths) from which it may mate (`matureBiomassOf`). */
  matureBiomass: number;
  cooldownUntilMs: number;
  /** Set once the creature has died on this connection: it takes no more reports. */
  over: boolean;
  /** What the genome allows (`physOf`): the largest body and the growth multiplier. */
  maxBiomass: number;
  growth: number;
  /** Bit `i` is set once `CREATURE_FLAGS[i]` was noted on this connection, so a client that keeps sending it costs no more reads. */
  flagged: number;
  /** When the last mating record, which charged the cost, was written (hub clock): see `COST_GRACE_MS`. */
  costT?: number;
}

/**
 * How long after a mating record a report or a lock-in claim may still hold the body from before
 * the cost. The record charges the cost at the hub; the page pays it when the `mating` message
 * arrives, at its next tick, so a report it sent in that window (a round trip and a tick, seconds
 * on a loaded page) is honest. Such a claim is clamped as ever, just not flagged.
 */
export const COST_GRACE_MS = 5_000;

/** The tolerance for a claim at `now`: unbounded while a mating's cost may be in flight, else `base`. */
const toleranceAt = (life: LifeState, now: number, base: number): number =>
  life.costT !== undefined && now - life.costT <= COST_GRACE_MS ? Number.POSITIVE_INFINITY : base;

export type Report = Condition & { n: number; ticks: number };

export type Implausible = CreatureFlag;

/** The gates a creature's life is held to, under the object's scales (`worker/lives.ts`). */
export interface Gates {
  lifespanMs: number;
  matureAtMs: number;
  matureBiomass: number;
}

/** A session starts crediting the creature from `now`, with the condition and clock the ledger has. */
export function bindLife(
  head: Pick<Head, 'id' | 'activeMs' | 'biomass' | 'energy' | 'health' | 'cooldownUntilMs'>,
  genome: Genome,
  now: number,
  { lifespanMs, matureAtMs, matureBiomass }: Gates,
): LifeState {
  const { maxBiomass, growth } = buildCreature(genome).phys;
  return {
    creature: head.id,
    n: 0,
    ticks: 0,
    t: now,
    activeMs: head.activeMs,
    startT: now,
    boundT: now,
    boundMs: head.activeMs,
    boundBiomass: head.biomass,
    savedMs: head.activeMs,
    savedN: 0,
    biomass: head.biomass,
    energy: head.energy,
    health: head.health,
    lifespanMs,
    matureAtMs,
    matureBiomass,
    cooldownUntilMs: head.cooldownUntilMs,
    over: false,
    maxBiomass,
    growth,
    flagged: 0,
  };
}

/**
 * The life state once a record of the creature was written at `t` with its clock and biomass:
 * the clock's cap and the growth reach count from it, and everything reported so far is saved.
 */
export function recorded(life: LifeState, t: number): LifeState {
  return {
    ...life,
    boundT: t,
    boundMs: life.activeMs,
    boundBiomass: life.biomass,
    savedMs: life.activeMs,
    savedN: life.n,
  };
}

/** Active time to credit for `ticks` now: `accrue`, within the wall time since the last record (plus one slack) and the lifespan. */
function credited(life: LifeState, ticks: number, now: number): number {
  // `accrue` caps one report at its own wall time plus slack; a record interval gets the slack once.
  const allowed = now - life.boundT + CLOCK_SLACK_MS - (life.activeMs - life.boundMs);
  const left = life.lifespanMs - life.activeMs;
  return Math.floor(Math.max(0, Math.min(accrue(life.ticks, ticks, now - life.t), allowed, left)));
}

/**
 * Whether `ticks` (counted from the connection's binding) claim more play than the wall time
 * since then plus the slack: no honest client can, whatever the record intervals took from it.
 */
const tooFast = (life: LifeState, ticks: number, now: number): boolean =>
  (ticks * 1000) / TICK_HZ > now - life.startT + CLOCK_SLACK_MS;

/** Notes `kind` in `flagged` once; whether it is new to this connection. */
function note(flagged: number, kind: Implausible): { flagged: number; isNew: boolean } {
  const bit = 1 << CREATURE_FLAGS.indexOf(kind);
  return { flagged: flagged | bit, isNew: (flagged & bit) === 0 };
}

/** The clock check of a report or a death's ticks: `clock-too-fast`, once per connection. */
function clockFlags(
  life: LifeState,
  ticks: number,
  now: number,
): Pick<Clamped, 'flagged' | 'newFlags'> {
  if (!tooFast(life, ticks, now)) return { flagged: life.flagged, newFlags: [] };
  const { flagged, isNew } = note(life.flagged, 'clock-too-fast');
  return { flagged, newFlags: isNew ? ['clock-too-fast'] : [] };
}

/** Credits the ticks played since the last report, as a death request carries them; no condition changes. */
export function creditTicks(
  life: LifeState,
  ticks: number,
  now: number,
): { life: LifeState; newFlags: Implausible[] } {
  const { flagged, newFlags } = clockFlags(life, ticks, now);
  return {
    life: {
      ...life,
      ticks: Math.max(life.ticks, ticks),
      t: now,
      activeMs: life.activeMs + credited(life, ticks, now),
      flagged,
    },
    newFlags,
  };
}

/** Whether the creature's active time has reached its lifespan. */
export const isOld = (life: LifeState): boolean => life.activeMs >= life.lifespanMs;

/** A condition clamped to what the genome and the active time since the last report allow (hundredths). */
interface Clamped {
  condition: Condition;
  /** `life.flagged` with the kinds clamped for added. */
  flagged: number;
  /** The kinds clamped for that this connection had not noted before. */
  newFlags: Implausible[];
}

/**
 * Clamps a claimed condition to the growth curve a creature of this genome can follow from its last
 * record, over `activeMs` of play since it (the rulebook's `reachAt`, with its one slack). A value
 * within `tolerance` (a share) of its cap is clamped without a flag, for claims quantised on the way
 * (a snapshot's biomass). `over` names one kind for every clamp past the tolerance (a lock-in's).
 */
function clampCondition(
  life: LifeState,
  claim: Condition,
  activeMs: number,
  tolerance = 0,
  over?: Implausible,
): Clamped {
  const clamped: Implausible[] = [];
  const clamp = (value: number, cap: number, kind: Implausible): number => {
    if (value <= cap) return value;
    if (value > cap * (1 + tolerance)) clamped.push(over ?? kind);
    return cap;
  };

  const biomass = clamp(
    clamp(claim.biomass, Math.floor(life.maxBiomass * HUNDREDTHS), 'biomass-over-max'),
    reachAt(life.boundBiomass, life.growth, activeMs),
    'growth-too-fast',
  );
  const cap = vitalsCap(biomass);
  const energy = clamp(claim.energy, cap.energy, 'energy-over');
  const health = clamp(claim.health, cap.health, 'health-over');

  let flagged = life.flagged;
  const newFlags = [...new Set(clamped)].filter((kind) => {
    const noted = note(flagged, kind);
    flagged = noted.flagged;
    return noted.isNew;
  });
  return { condition: { biomass, energy, health }, flagged, newFlags };
}

/**
 * Credits a report: advances the life clock by `accrue` (within the wall time since the last
 * record), and clamps the reported condition to what the genome and the active time since that
 * record allow. Never rejects; the kinds it flagged and had not noted before on this connection come back.
 */
export function applyReport(
  life: LifeState,
  report: Report,
  now: number,
): { life: LifeState; newFlags: Implausible[] } {
  const gained = credited(life, report.ticks, now);
  const clock = clockFlags(life, report.ticks, now);
  const { condition, flagged, newFlags } = clampCondition(
    { ...life, flagged: clock.flagged },
    report,
    life.activeMs + gained - life.boundMs,
    toleranceAt(life, now, 0),
  );
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
    newFlags: [...clock.newFlags, ...newFlags],
  };
}

/**
 * A condition claimed outside a report (a signed snapshot at lock-in, ADR 0050), clamped by the
 * same growth curve over the wall time since the last record. Nothing is credited; a clamp past
 * the tolerance is `claim-over`.
 */
export function clampClaim(
  life: LifeState,
  claim: Condition,
  now: number,
  tolerance: number,
): Clamped {
  return clampCondition(
    life,
    claim,
    Math.max(0, now - life.boundT),
    toleranceAt(life, now, tolerance),
    'claim-over',
  );
}

/** Whether the creature has played since its last record, so a close should write one. */
export const unsaved = (life: LifeState): boolean => life.n > life.savedN;

/** Whether a progress report is due a checkpoint of its own: 15 minutes of active time since the last. */
export const checkpointDue = (life: LifeState): boolean =>
  life.activeMs - life.savedMs >= CHECKPOINT_EVERY_MS;
