// Plain-data simulation state (ADR 0005): no classes, closures, NaN or Infinity, so it survives
// structuredClone and hashes identically everywhere.

import type { Seed } from './prng';

export interface Vec2 {
  x: number;
  y: number;
}

export type DeathCause = 'starved' | 'toxin' | 'old-age' | 'uv' | 'pressure' | 'killed';

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
  cause: DeathCause | null;
  bornTick: number;
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
  options: { currents: boolean; hazards: boolean };
}

export type StepEvent =
  | { type: 'eat'; creature: string; food: string; value: number }
  | { type: 'damage'; creature: string; amount: number; cause: DeathCause }
  | { type: 'death'; creature: string; cause: DeathCause }
  | { type: 'dash'; creature: string }
  | { type: 'grow'; creature: string; biomass: number };
