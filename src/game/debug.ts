import type { FxSnapshot } from '../render/effects';
import type { RenderInfo } from '../render/scene';
import type { InputLog } from '../sim/replay';
import type { FoodItem } from '../sim/types';
import type { DeathSummary, Screen } from './screens';

/** Read-only views of the running game for tests and tools (`window.__bs`). */
export interface BsState {
  screen: Screen;
  tick: number;
  /** This browser's identity; null until the key is loaded. */
  playerId: string | null;
  /** Food items handed to the renderer this tick. */
  visibleFood: number;
  /** The creature being played; null on the title screen. */
  player: {
    x: number;
    y: number;
    /** World units. */
    radius: number;
    biomass: number;
    energy: number;
    health: number;
    alive: boolean;
  } | null;
  /** Set once the player has died. */
  death: DeathSummary | null;
  /** The other players in the pond, as drawn (alpha fades when they go quiet). */
  remotes: { id: string; name: string; x: number; y: number; alpha: number }[];
}

/** A scripted remote creature for tests: it swims in a straight line and sends real snapshots. */
export interface ScriptedRemote {
  id: string;
  name: string;
  x: number;
  y: number;
  /** World units per second. */
  vx?: number;
  vy?: number;
  /** Default 100. */
  biomass?: number;
}

export interface BsHook {
  ready: true;
  state(): BsState;
  /** How many events of each type the sim has emitted since the player hatched. */
  events(): Record<string, number>;
  /** Re-runs an input log in a fresh world and returns its final state hash. */
  replay(log: InputLog): { hash: string; events: Record<string, number> };
  render: { info(): RenderInfo; fx(): FxState };
  /** Mutating helpers; present only with `?debug=1`. */
  debug?: BsDebug;
}

/** The feedback cues now showing: counts since hatching, plus the camera's current zoom. */
export interface FxState extends FxSnapshot {
  /** Visible half-height in world units, as drawn. */
  halfHeight: number;
  /** Where the camera looks, in world units. */
  camX: number;
  camY: number;
}

export interface BsDebug {
  /** Sets the player's energy (clamped to its maximum). */
  setEnergy(energy: number): void;
  /** Sets the player's biomass (growth to a new size); energy and health keep their fractions. */
  setBiomass(biomass: number): void;
  /** Moves the player and stops it. */
  teleport(x: number, y: number): void;
  /** The food item closest to the player, or null. */
  nearestFood(): FoodItem | null;
  /** Swims at full throttle towards a target; resolves true once it is eaten or reached, false on a timeout or if it vanished. */
  steerTo(target: { id?: string; x: number; y: number }): Promise<boolean>;
  /** Adds a toxic plume to the world. */
  spawnPlume(x: number, y: number, radius?: number): void;
  /** Replaces the scripted remotes (an empty list removes them); they send snapshots at 10 Hz. */
  setRemotes(remotes: readonly ScriptedRemote[]): void;
  /** Runs the sim this many times faster than real time. */
  timeScale(scale: number): void;
}

declare global {
  interface Window {
    __bs?: BsHook;
  }
}

export function installHook(hook: BsHook): void {
  window.__bs = hook;
}
