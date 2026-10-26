/** Radians per second of the flagellum's wave with no beat and with full beat. */
export const BEAT_RATE_IDLE = 6;
export const BEAT_RATE_FULL = 12;
/** A longer frame gap (a stalled tab) advances the wave by no more than this many seconds. */
const MAX_STEP = 0.1;
const TURN = Math.PI * 2;

/**
 * The wave's phase after `dt` seconds at the rate `beat` (0..1) gives. The phase is integrated,
 * never `time * rate`: a changing rate would otherwise jump the phase by the elapsed time times
 * the change, which shows as a whip that flickers wildly after minutes of play. `freq` is the
 * genome's gait frequency, a multiplier on the rate (1 for the M1 cell).
 */
export function advanceBeatPhase(phase: number, beat: number, dt: number, freq = 1): number {
  const step = Math.min(Math.max(dt, 0), MAX_STEP);
  const rate = BEAT_RATE_IDLE + (BEAT_RATE_FULL - BEAT_RATE_IDLE) * Math.min(Math.max(beat, 0), 1);
  return (phase + rate * freq * step) % TURN;
}
