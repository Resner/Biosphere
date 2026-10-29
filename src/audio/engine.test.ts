import { describe, expect, it } from 'vitest';
import { hashSamples, measure, volumeGain } from './engine';

describe('volumeGain', () => {
  it('maps 0..100 to a perceptual curve and mute to zero', () => {
    expect(volumeGain(0, false)).toBe(0);
    expect(volumeGain(100, false)).toBe(1);
    expect(volumeGain(50, false)).toBeCloseTo(0.25, 9);
    expect(volumeGain(100, true)).toBe(0);
    expect(volumeGain(60, true)).toBe(0);
  });

  it('rises with the volume and clamps nonsense', () => {
    let last = -1;
    for (let v = 0; v <= 100; v += 5) {
      const g = volumeGain(v, false);
      expect(g).toBeGreaterThan(last);
      last = g;
    }
    expect(volumeGain(-20, false)).toBe(0);
    expect(volumeGain(300, false)).toBe(1);
    expect(volumeGain(Number.NaN, false)).toBe(0);
  });
});

describe('measure', () => {
  it('reports RMS and peak in dBFS', () => {
    const a = new Float32Array(1000).fill(0.5);
    const b = new Float32Array(1000).fill(-0.5);
    const m = measure([a, b]);
    expect(m.rmsDb).toBeCloseTo(20 * Math.log10(0.5), 4);
    expect(m.peakDb).toBeCloseTo(20 * Math.log10(0.5), 4);
    expect(m.silent).toBe(false);
  });

  it('rates brightness by the energy of the first difference', () => {
    const n = 4096;
    const slow = new Float32Array(n);
    const fast = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      slow[i] = Math.sin((i * 2 * Math.PI * 100) / 44100);
      fast[i] = Math.sin((i * 2 * Math.PI * 5000) / 44100);
    }
    expect(measure([fast]).brightness).toBeGreaterThan(measure([slow]).brightness * 10);
    expect(measure([new Float32Array(16)]).brightness).toBe(0);
  });

  it('calls exact zeros digital silence', () => {
    const m = measure([new Float32Array(64), new Float32Array(64)]);
    expect(m.silent).toBe(true);
    expect(m.rmsDb).toBe(Number.NEGATIVE_INFINITY);
    expect(m.peakDb).toBe(Number.NEGATIVE_INFINITY);
    const tiny = new Float32Array(64);
    tiny[10] = 1e-7;
    expect(measure([tiny]).silent).toBe(false);
  });
});

describe('hashSamples', () => {
  it('changes with any sample and repeats for equal buffers', () => {
    const a = new Float32Array([0, 0.25, -0.5, 1]);
    const b = new Float32Array([0, 0.25, -0.5, 1]);
    expect(hashSamples([a])).toBe(hashSamples([b]));
    b[2] = -0.5000001;
    expect(hashSamples([a])).not.toBe(hashSamples([b]));
    expect(hashSamples([a])).toMatch(/^[0-9a-f]{8}$/);
  });
});
