import type { RarityTier } from '../genome/rarity';
import type { Silhouette } from '../genome/silhouette';
import type { LabMode } from './specimens';

/** What the Lab's grid shows: a seeded set, or genomes handed in with `showGenomes`. */
export type LabView = LabMode | 'custom';

export interface LabCreature {
  index: number;
  hash: string;
  species: string;
  /** Size tier of the fully grown body. */
  tier: number;
  rarity: RarityTier;
  /** The body plan's shape class (M6 T8). */
  silhouette: Silhouette;
  vertices: number;
  /** False when the body breaks a development rule (never expected). */
  valid: boolean;
}

export interface LabState {
  seed: string;
  mode: LabView;
  creatures: LabCreature[];
  /** The cell under the pointer, or null. */
  hovered: number | null;
  /** The cell shown in the inspector (0-23 grid, 24-31 offspring), or null. */
  selected: number | null;
  /** The two grid cells that Breed would mate: the last plain click, then the shift-click. */
  parents: [number | null, number | null];
  /** The eight children of the last Breed, or none. */
  offspring: LabCreature[];
}

export interface LabRenderInfo {
  calls: number;
  triangles: number;
  programs: number;
  geometries: number;
}

/** Test helpers under `?debug=1`; they change what the Lab shows, so they are never always-on. */
export interface LabDebug {
  /** Replaces the grid with these base64url genomes (at most 24); false when any is not a genome. */
  showGenomes(texts: readonly string[]): boolean;
  /** Freezes the animation clock and the film grain; `advance` then steps the clock. */
  pause(): void;
  /** Runs the gait forward by this many seconds (pauses the clock). */
  advance(seconds: number): void;
}

/** `window.__lab`: read-only views, selection and the mode switch are always present. */
export interface LabHook {
  ready: boolean;
  state(): LabState;
  /** Inspects a cell; a grid cell also becomes a parent, the second one when `second` is set. */
  select(index: number, options?: { second?: boolean }): void;
  setMode(mode: LabMode): void;
  /** Counters of the last drawn frame. */
  renderInfo(): LabRenderInfo;
  debug?: LabDebug;
}

declare global {
  interface Window {
    __lab?: LabHook;
  }
}
