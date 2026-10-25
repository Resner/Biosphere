import type { RenderInfo } from '../render/scene';

/** Read-only views of the running game for tests and tools (`window.__bs`). */
export interface BsState {
  screen: 'playing';
  tick: number;
  /** Food items handed to the renderer this tick. */
  visibleFood: number;
  player: {
    x: number;
    y: number;
    /** World units. */
    radius: number;
    biomass: number;
    energy: number;
    health: number;
    alive: boolean;
  };
}

export interface BsHook {
  ready: true;
  state(): BsState;
  /** How many events of each type the sim has emitted since the game started. */
  events(): Record<string, number>;
  render: { info(): RenderInfo };
  /** Mutating helpers; present only with `?debug=1`. */
  debug?: BsDebug;
}

export interface BsDebug {
  /** Draws a toxic plume without touching the sim (render-only until T9 moves it into the world). */
  spawnPlume(x: number, y: number, radius?: number): void;
}

declare global {
  interface Window {
    __bs?: BsHook;
  }
}

export function installHook(hook: BsHook): void {
  window.__bs = hook;
}
