// Plain-data simulation state (ADR 0005): no classes, closures, NaN or Infinity, so it survives
// structuredClone and hashes identically everywhere.

import type { PhysStats } from './body';
import type { Seed } from './prng';

export interface Vec2 {
  x: number;
  y: number;
}

/** `eaten` ends only a pending child whose egg a predator ate in an encounter (ADR 0052). */
export type DeathCause = 'starved' | 'toxin' | 'old-age' | 'uv' | 'pressure' | 'killed' | 'eaten';

export interface CreatureState {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  heading: number;
  biomass: number;
  energy: number;
  health: number;
  dashReadyTick: number;
  alive: boolean;
  /** Past 85% of the lifespan: slower and hungrier (DESIGN §5). Set by a `life` input, never by the sim. */
  elder: boolean;
  cause: DeathCause | null;
  bornTick: number;
  phys: PhysStats;
}

export type FoodKind = 'detritus' | 'globule' | 'crystal';

export interface FoodItem {
  id: string;
  kind: FoodKind;
  x: number;
  y: number;
  value: number;
  radius: number;
  /** The tick this item appeared (0 for a slot's first item). */
  respawnTick: number;
}

/** A piece of a killed creature (M7): food that drops where a kill happened and spoils. */
export interface CarrionPiece {
  /** `x<first 8 of the encounter id>_<i>`; also its claim slot (cycle 0, never respawns). */
  id: string;
  x: number;
  y: number;
  /** Energy before the mouth's efficiency. */
  value: number;
  radius: number;
  /** The first tick it is gone. */
  expires: number;
}

/** A toxic cloud: a disc of poisoned water. */
export interface Plume {
  id: string;
  x: number;
  y: number;
  radius: number;
}

export interface World {
  rules: number;
  seed: string;
  seed32: Seed;
  tick: number;
  size: number;
  /** Always sorted by id. */
  creatures: CreatureState[];
  /**
   * Eaten food slots (`c3_5_s2`): the cycle that appears next and the tick it appears. An entry
   * stays after its respawn tick passes, because it is the only record of the slot's cycle.
   */
  consumed: Record<string, { k: number; until: number }>;
  /**
   * Carrion pieces, sorted by id. A piece is alive until `expires` unless `consumed` holds its id.
   * Mutated in place, because a pond's lives share this array.
   */
  carrion: CarrionPiece[];
  options: { currents: boolean; hazards: boolean };
  /** Fixed plumes added by tests and debug tools; they sit on top of the seeded ones. */
  extraPlumes: Plume[];
}

export type StepEvent =
  | { type: 'eat'; creature: string; food: string; value: number }
  | { type: 'damage'; creature: string; amount: number; cause: DeathCause }
  | { type: 'death'; creature: string; cause: DeathCause }
  | { type: 'dash'; creature: string }
  | { type: 'grow'; creature: string; biomass: number };
