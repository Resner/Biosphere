import { clamp } from '../sim/math';
import { DT } from '../sim/rules';

const STEP_MS = DT * 1000;
/** Absorbs float error so 60 frames of 1000/60 ms give exactly 30 ticks. */
const EPSILON_MS = 1e-6;

export interface LoopOptions {
  /** Monotonic clock in milliseconds. */
  now(): number;
  /** Advances the simulation by one fixed tick. */
  tick(): void;
  /** Draws a frame; `alpha` in [0, 1) is how far we are into the next tick. */
  render(alpha: number): void;
  /** Longest burst of catch-up ticks per frame; the rest of the backlog is dropped. */
  maxTicksPerFrame?: number;
}

export interface Loop {
  /** Call once per animation frame. Does nothing while paused. */
  frame(): void;
  /** Stops ticking and rendering. The backlog is discarded. */
  pause(): void;
  /** Continues from the next frame, without catching up on the time spent paused. */
  resume(): void;
  stats(): { ticks: number; skippedMs: number };
}

export function createLoop({ now, tick, render, maxTicksPerFrame = 5 }: LoopOptions): Loop {
  let last: number | null = null;
  let accumulator = 0;
  let paused = false;
  let ticks = 0;
  let skippedMs = 0;

  return {
    frame() {
      if (paused) return;
      const t = now();
      const delta = last === null ? 0 : Math.max(0, t - last);
      last = t;
      accumulator += delta;

      let run = 0;
      while (accumulator + EPSILON_MS >= STEP_MS && run < maxTicksPerFrame) {
        accumulator -= STEP_MS;
        tick();
        run++;
      }
      ticks += run;
      if (accumulator + EPSILON_MS >= STEP_MS) {
        skippedMs += accumulator;
        accumulator = 0;
      }
      render(clamp(accumulator / STEP_MS, 0, 1 - EPSILON_MS));
    },
    pause() {
      paused = true;
      accumulator = 0;
      last = null;
    },
    resume() {
      paused = false;
      last = null;
    },
    stats: () => ({ ticks, skippedMs }),
  };
}

export interface VisibilitySource {
  readonly hidden: boolean;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

/**
 * Pauses a single-player loop while the tab is hidden. Returns a function that detaches it.
 * Multiplayer must not use this: other players keep moving.
 */
export function attachVisibilityPause(doc: VisibilitySource, loop: Loop): () => void {
  const sync = () => (doc.hidden ? loop.pause() : loop.resume());
  doc.addEventListener('visibilitychange', sync);
  if (doc.hidden) loop.pause();
  return () => doc.removeEventListener('visibilitychange', sync);
}
