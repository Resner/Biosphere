// Encounter shapes (ADR 0050, ADR 0051): plain data that survives structuredClone and hashes the
// same everywhere. The referee and every client step the same `Encounter` from the same start.

import type { CombatStats, PhysStats } from '../body';
import type { Seed } from '../prng';
import type { CreatureState, DeathCause, World } from '../types';

export type Stance = 'balanced' | 'aggressive' | 'evasive';
export type TargetPref = 'nearest' | 'weakest' | 'largest' | 'strongest';

/** The combat autopilot's genes (DESIGN §6): four 0-1 traits and a target preference. */
export interface Behaviour {
  aggression: number;
  caution: number;
  curiosity: number;
  reflex: number;
  targetPref: TargetPref;
}

/** One fighter's choices for one frame (3 ticks). */
export interface FrameInput {
  steer: number;
  throttle: number;
  dash: boolean;
  stance: Stance;
  /** 0-3 a fighter's slot, 4-7 that slot's egg. */
  target: number;
  brace: boolean;
}

export interface FighterStart {
  player: string;
  creature: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  heading: number;
  biomass: number;
  energy: number;
  health: number;
  elder: boolean;
  egg: boolean;
  phys: PhysStats;
  combat: CombatStats;
  behaviour: Behaviour;
}

export interface EncounterStart {
  id: string;
  pondSeed: string;
  size: number;
  /** The encounter's own random seed (the beacon round's, from the referee). */
  seed: Seed;
  /** The pond tick of frame 0. */
  t0: number;
  fighters: FighterStart[];
}

export type Outcome = 'killed' | 'died' | 'escaped' | 'stood';

export interface FighterResult {
  outcome: Outcome;
  cause: DeathCause | null;
  /** The slot of the killer. */
  by: number | null;
  /** Frames completed when the outcome was reached. */
  frame: number;
  egg: 'none' | 'kept' | 'eaten';
  eggBy: number | null;
}

export interface Fighter {
  slot: number;
  player: string;
  /** The creature's id; `body` carries its full simulated state. */
  creature: string;
  body: CreatureState;
  combat: CombatStats;
  behaviour: Behaviour;
  egg: boolean;
  /** `in` until the fighter's outcome is known. */
  status: 'in' | Outcome;
  /** Consecutive ticks outside every living opponent's escape range. */
  outside: number;
  result: FighterResult | null;
}

export interface Encounter {
  id: string;
  seed: Seed;
  t0: number;
  /** Frames completed. */
  frame: number;
  over: boolean;
  /** Plain pond water at tick `t0 + 3 × frame`; it never holds a creature or food. */
  world: World;
  /** In slot order. */
  fighters: Fighter[];
}

export type EncounterEvent =
  | { type: 'death'; slot: number; cause: DeathCause }
  | { type: 'escape'; slot: number }
  | { type: 'end'; frame: number };
