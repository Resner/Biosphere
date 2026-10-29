// Which sounds the player's life asks for (M6 T23, DESIGN §10), from the sim's events and the
// creature's state each tick. The sim reports damage every tick it lasts, so a hit repeats slowly
// instead; low energy pulses slowly while it lasts; a plume rumbles once as it comes near. Pure
// rules on the tick count, so they test in Node; the shell plays what this asks for.

import type { Cue } from '../audio/cues';
import type { StepEvent } from '../sim/types';
import { LOW_ENERGY } from './hud';

export const CUE_WATCH = {
  /** A hit (toxin, starvation, a bite) sounds at most this often while damage goes on: 0.4 s. */
  hurtGapTicks: 12,
  /** UV's sizzle and pressure's squeeze, at most once a second each. */
  zoneGapTicks: 30,
  /** Its pulse repeats every 3 s while it lasts. */
  lowGapTicks: 90,
  /** A plume is near once its edge is this many body radii away, and clear past `clearGap`. */
  nearGap: 2,
  clearGap: 3,
  /** A plume's rumble plays at most once in 2 s. */
  nearGapTicks: 60,
} as const;

/** The nearest plume: its centre (world units) and its edge's distance in the creature's radii. */
export interface NearHazard {
  x: number;
  y: number;
  gap: number;
}

export type CueSink = (cue: Cue, at?: { x: number; y: number }) => void;

const NEVER = Number.NEGATIVE_INFINITY;

export class CueWatch {
  private last = new Map<Cue, number>();
  private near = false;
  private dead = false;

  constructor(private readonly play: CueSink) {}

  /** A new life: every repeat and the death tone start over. */
  reset(): void {
    this.last.clear();
    this.near = false;
    this.dead = false;
  }

  /** One of the player's sim events, on the life's tick. */
  onEvent(event: StepEvent, tick: number): void {
    switch (event.type) {
      case 'eat':
        this.play('eat');
        break;
      case 'dash':
        this.play('dash');
        break;
      case 'damage':
        if (event.cause === 'uv' || event.cause === 'pressure') {
          this.every(event.cause, tick, CUE_WATCH.zoneGapTicks);
        } else this.every('hurt', tick, CUE_WATCH.hurtGapTicks);
        break;
    }
  }

  /** Once per tick of a living creature: its energy share and the nearest plume, if any. */
  vitals(tick: number, energyShare: number, hazard: NearHazard | null): void {
    // Leaving low energy forgets the last pulse, so the next dip sounds at once.
    if (energyShare < LOW_ENERGY) this.every('low-energy', tick, CUE_WATCH.lowGapTicks);
    else this.last.delete('low-energy');

    if (hazard && hazard.gap <= CUE_WATCH.nearGap) {
      if (!this.near) {
        this.near = true;
        this.every('hazard-near', tick, CUE_WATCH.nearGapTicks, { x: hazard.x, y: hazard.y });
      }
    } else if (!hazard || hazard.gap > CUE_WATCH.clearGap) this.near = false;
  }

  /** The creature died, of any cause: the death tone, once per life. */
  died(): void {
    if (this.dead) return;
    this.dead = true;
    this.play('death');
  }

  private every(cue: Cue, tick: number, gap: number, at?: { x: number; y: number }): void {
    if (tick - (this.last.get(cue) ?? NEVER) >= gap) this.sound(cue, tick, at);
  }

  private sound(cue: Cue, tick: number, at?: { x: number; y: number }): void {
    this.last.set(cue, tick);
    this.play(cue, at);
  }
}

/** The plume whose edge is nearest the creature's, of those given, with its gap in body radii. */
export function nearestHazard(
  plumes: readonly { x: number; y: number; radius: number }[],
  x: number,
  y: number,
  radius: number,
): NearHazard | null {
  let best: NearHazard | null = null;
  const r = Math.max(radius, 1e-6);
  for (const p of plumes) {
    const gap = (Math.hypot(p.x - x, p.y - y) - p.radius - r) / r;
    if (!best || gap < best.gap) best = { x: p.x, y: p.y, gap };
  }
  return best;
}
