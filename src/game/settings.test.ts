import { describe, expect, it } from 'vitest';
import {
  BENCH_GPUS,
  DEFAULT_SETTINGS,
  loadBench,
  loadSettings,
  qualityFromSearch,
  reducedMotion,
  saveBench,
  saveSettings,
} from './settings';

const store = (initial?: string) => {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set('bs.settings', initial);
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
};

const throwing = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
};

describe('loadSettings', () => {
  it('defaults to auto quality, volume 60, sound on and the system motion setting', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      quality: 'auto',
      volume: 60,
      muted: false,
      reducedMotion: null,
    });
    expect(loadSettings(store())).toEqual(DEFAULT_SETTINGS);
  });

  it('reads a stored quality (settings from before sound keep the sound defaults)', () => {
    expect(loadSettings(store('{"quality":"high"}'))).toEqual({
      ...DEFAULT_SETTINGS,
      quality: 'high',
    });
    expect(loadSettings(store('{"quality":"auto"}'))).toEqual({
      ...DEFAULT_SETTINGS,
      quality: 'auto',
    });
  });

  it('reads stored sound and motion settings', () => {
    const text = '{"quality":"low","volume":35,"muted":true,"reducedMotion":false}';
    expect(loadSettings(store(text))).toEqual({
      quality: 'low',
      volume: 35,
      muted: true,
      reducedMotion: false,
    });
    expect(loadSettings(store('{"reducedMotion":true}')).reducedMotion).toBe(true);
    expect(loadSettings(store('{"reducedMotion":null}')).reducedMotion).toBeNull();
  });

  it('keeps each valid field when another is damaged', () => {
    const text = '{"quality":"ultra","volume":20,"muted":"yes","reducedMotion":1}';
    expect(loadSettings(store(text))).toEqual({ ...DEFAULT_SETTINGS, volume: 20 });
  });

  it('rounds the volume to a whole step in 0..100 and rejects non-numbers', () => {
    expect(loadSettings(store('{"volume":42.6}')).volume).toBe(43);
    expect(loadSettings(store('{"volume":-5}')).volume).toBe(0);
    expect(loadSettings(store('{"volume":250}')).volume).toBe(100);
    expect(loadSettings(store('{"volume":"loud"}')).volume).toBe(60);
    expect(loadSettings(store('{"volume":null}')).volume).toBe(60);
  });

  it.each([
    ['invalid JSON', '{nope'],
    ['a non-object', '42'],
    ['null', 'null'],
    ['a wrong type', '{"quality":3}'],
    ['an unknown preset', '{"quality":"ultra"}'],
    ['a missing field', '{}'],
    ['an array', '[1,2]'],
  ])('falls back to the defaults on %s', (_, text) => {
    expect(loadSettings(store(text))).toEqual(DEFAULT_SETTINGS);
  });

  it('falls back to the defaults when the store throws or is missing', () => {
    expect(loadSettings(throwing)).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings(null)).toEqual(DEFAULT_SETTINGS);
  });
});

describe('saveSettings', () => {
  it('writes what loadSettings reads', () => {
    const s = store();
    const settings = { quality: 'low', volume: 12, muted: true, reducedMotion: true } as const;
    saveSettings(settings, s);
    expect(loadSettings(s)).toEqual(settings);
  });

  it('swallows a throwing or missing store', () => {
    const settings = { ...DEFAULT_SETTINGS, quality: 'low' } as const;
    expect(() => saveSettings(settings, throwing)).not.toThrow();
    expect(() => saveSettings(settings, null)).not.toThrow();
  });
});

describe('reducedMotion', () => {
  it('follows prefers-reduced-motion until the player picks', () => {
    expect(reducedMotion(DEFAULT_SETTINGS, true)).toBe(true);
    expect(reducedMotion(DEFAULT_SETTINGS, false)).toBe(false);
    expect(reducedMotion({ ...DEFAULT_SETTINGS, reducedMotion: false }, true)).toBe(false);
    expect(reducedMotion({ ...DEFAULT_SETTINGS, reducedMotion: true }, false)).toBe(true);
  });
});

describe('qualityFromSearch', () => {
  it('reads a preset name from ?quality=', () => {
    expect(qualityFromSearch('?quality=low')).toBe('low');
    expect(qualityFromSearch('?debug=1&quality=high')).toBe('high');
    expect(qualityFromSearch('?quality=medium')).toBe('medium');
  });

  it('ignores anything else, auto included', () => {
    expect(qualityFromSearch('')).toBeNull();
    expect(qualityFromSearch('?quality=ultra')).toBeNull();
    expect(qualityFromSearch('?quality=auto')).toBeNull();
  });
});

describe('loadBench and saveBench', () => {
  it('keep the benchmark result per GPU', () => {
    const s = store();
    expect(loadBench(s, 'GPU A')).toBeNull();
    saveBench(s, 'GPU A', 'high');
    saveBench(s, 'GPU B', 'low');
    expect(loadBench(s, 'GPU A')).toBe('high');
    expect(loadBench(s, 'GPU B')).toBe('low');
    // Another machine (or another GPU in this one) benchmarks again.
    expect(loadBench(s, 'GPU C')).toBeNull();
    expect(JSON.parse(s.data.get('bs.bench') ?? '')).toEqual({ 'GPU A': 'high', 'GPU B': 'low' });
  });

  it('replaces the result for a GPU that benchmarks again', () => {
    const s = store();
    saveBench(s, 'GPU A', 'high');
    saveBench(s, 'GPU A', 'medium');
    expect(loadBench(s, 'GPU A')).toBe('medium');
  });

  it(`keeps the last ${BENCH_GPUS} GPUs`, () => {
    const s = store();
    for (let i = 0; i <= BENCH_GPUS; i++) saveBench(s, `GPU ${i}`, 'low');
    expect(loadBench(s, 'GPU 0')).toBeNull();
    expect(loadBench(s, `GPU ${BENCH_GPUS}`)).toBe('low');
    expect(Object.keys(JSON.parse(s.data.get('bs.bench') ?? ''))).toHaveLength(BENCH_GPUS);
  });

  it.each([
    ['invalid JSON', '{nope'],
    ['a non-object', '"high"'],
    ['an array', '["high"]'],
    ['an unknown preset', '{"GPU A":"ultra"}'],
  ])('reads nothing from %s, and saving replaces it', (_, text) => {
    const s = store();
    s.data.set('bs.bench', text);
    expect(loadBench(s, 'GPU A')).toBeNull();
    saveBench(s, 'GPU B', 'high');
    expect(loadBench(s, 'GPU B')).toBe('high');
  });

  it('swallows a throwing or missing store', () => {
    expect(loadBench(throwing, 'GPU A')).toBeNull();
    expect(loadBench(null, 'GPU A')).toBeNull();
    expect(() => saveBench(throwing, 'GPU A', 'high')).not.toThrow();
    expect(() => saveBench(null, 'GPU A', 'high')).not.toThrow();
  });
});
