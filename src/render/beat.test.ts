import { describe, expect, it } from 'vitest';
import { advanceBeatPhase, BEAT_RATE_FULL, BEAT_RATE_IDLE } from './beat';

describe('advanceBeatPhase', () => {
  it('advances at the idle rate with no beat and at the full rate with full beat', () => {
    expect(advanceBeatPhase(0, 0, 0.1)).toBeCloseTo(BEAT_RATE_IDLE * 0.1);
    expect(advanceBeatPhase(0, 1, 0.1)).toBeCloseTo(BEAT_RATE_FULL * 0.1);
  });

  it('moves by a bounded step when the beat changes late in a long session', () => {
    // The phase must not jump with the elapsed time: a change of beat only changes the rate.
    let phase = 0;
    for (let i = 0; i < 20_000; i++) {
      const next = advanceBeatPhase(phase, i % 40 < 20 ? 0 : 1, 1 / 60);
      const step = Math.abs(((next - phase + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      expect(step).toBeLessThanOrEqual(BEAT_RATE_FULL / 60 + 1e-9);
      phase = next;
    }
  });

  it('stays within one turn so float precision does not degrade', () => {
    let phase = 0;
    for (let i = 0; i < 100_000; i++) phase = advanceBeatPhase(phase, 1, 1 / 30);
    expect(phase).toBeGreaterThanOrEqual(0);
    expect(phase).toBeLessThan(Math.PI * 2);
  });

  it('ignores negative or huge frame gaps', () => {
    expect(advanceBeatPhase(1, 1, -5)).toBe(1);
    expect(advanceBeatPhase(1, 1, 60)).toBeCloseTo(1 + BEAT_RATE_FULL * 0.1, 5);
  });
});
