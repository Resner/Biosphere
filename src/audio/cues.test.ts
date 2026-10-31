import { describe, expect, it } from 'vitest';
import { CUE_SOUNDS, CUES, layerEnd, placeCue } from './cues';

describe('CUE_SOUNDS', () => {
  it('has a sound for every cue of DESIGN §10', () => {
    expect([...CUES].sort()).toEqual(
      [
        'eat',
        'hurt',
        'low-energy',
        'hazard-near',
        'dash',
        'death',
        'old-age',
        'court',
        'mate',
        'hatch',
        'reveal',
        'stir',
        'grow',
        'tier',
        'ping',
        'emote',
        'chat',
        'uv',
        'pressure',
      ].sort(),
    );
    for (const cue of CUES) expect(CUE_SOUNDS[cue].layers.length, cue).toBeGreaterThan(0);
  });

  it('ends every layer within its cue’s pinned length', () => {
    for (const cue of CUES) {
      const { seconds, layers } = CUE_SOUNDS[cue];
      const end = Math.max(...layers.map(layerEnd));
      expect(end, cue).toBeLessThanOrEqual(seconds + 1e-9);
      // The length is the sound's, not padding: the last layer ends in its final 15%.
      expect(end, cue).toBeGreaterThan(seconds * 0.85);
    }
  });

  it('pins the eat pop short and the death tone long', () => {
    expect(CUE_SOUNDS.eat.seconds).toBeLessThanOrEqual(0.25);
    expect(CUE_SOUNDS.death.seconds).toBeGreaterThanOrEqual(1);
    expect(CUE_SOUNDS.death.seconds).toBeLessThanOrEqual(2);
  });

  it('makes the death tone descend', () => {
    const tones = CUE_SOUNDS.death.layers.filter((l) => l.kind === 'tone');
    expect(tones.length).toBeGreaterThan(0);
    for (const t of tones) expect(t.toHz ?? t.hz).toBeLessThan(t.hz);
  });

  it('makes the egg’s stir a soft rise, ending before the shortest stir', () => {
    const { seconds, layers } = CUE_SOUNDS.stir;
    expect(seconds).toBeLessThanOrEqual(1.2);
    for (const l of layers) {
      expect(l.toHz ?? 0).toBeGreaterThan(l.hz);
      expect(l.level).toBeLessThanOrEqual(0.2);
      // Soft: it swells in rather than striking.
      expect(l.attack).toBeGreaterThanOrEqual(0.3);
    }
  });

  it('keeps every level and frequency sane', () => {
    for (const cue of CUES) {
      for (const l of CUE_SOUNDS[cue].layers) {
        expect(l.level, cue).toBeGreaterThan(0);
        expect(l.level, cue).toBeLessThanOrEqual(0.5);
        expect(l.hz, cue).toBeGreaterThanOrEqual(20);
        expect(l.hz, cue).toBeLessThanOrEqual(12000);
        expect(l.attack, cue).toBeGreaterThan(0);
        expect(l.decay, cue).toBeGreaterThan(0);
      }
    }
  });
});

describe('placeCue', () => {
  const listener = { x: 100, y: 100, halfWidth: 50 };

  it('is centred and full at the listener', () => {
    expect(placeCue({ x: 100, y: 100 }, listener)).toEqual({ pan: 0, gain: 1 });
  });

  it('pans by screen position', () => {
    const right = placeCue({ x: 125, y: 100 }, listener);
    const left = placeCue({ x: 75, y: 100 }, listener);
    expect(right.pan).toBeGreaterThan(0.3);
    expect(left.pan).toBeCloseTo(-right.pan, 9);
    // Up and down do not pan.
    expect(placeCue({ x: 100, y: 140 }, listener).pan).toBe(0);
    // Past the screen's edge the pan stays at its limit.
    const edge = placeCue({ x: 150, y: 100 }, listener).pan;
    expect(placeCue({ x: 400, y: 100 }, listener).pan).toBe(edge);
    expect(edge).toBeLessThanOrEqual(1);
  });

  it('falls off with distance', () => {
    let last = 2;
    for (const d of [0, 10, 25, 50, 100, 200, 400]) {
      const { gain } = placeCue({ x: 100, y: 100 + d }, listener);
      expect(gain).toBeLessThanOrEqual(last);
      last = gain;
    }
    expect(placeCue({ x: 100, y: 150 }, listener).gain).toBeLessThan(0.8);
    expect(placeCue({ x: 100, y: 400 }, listener).gain).toBeLessThan(0.15);
  });

  it('survives a degenerate screen', () => {
    const place = placeCue({ x: 120, y: 90 }, { x: 100, y: 100, halfWidth: 0 });
    expect(Number.isFinite(place.pan)).toBe(true);
    expect(Number.isFinite(place.gain)).toBe(true);
  });
});
