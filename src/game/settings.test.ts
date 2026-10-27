import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, loadSettings, qualityFromSearch, saveSettings } from './settings';

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
  it('defaults to auto quality', () => {
    expect(DEFAULT_SETTINGS).toEqual({ quality: 'auto' });
    expect(loadSettings(store())).toEqual(DEFAULT_SETTINGS);
  });

  it('reads a stored quality', () => {
    expect(loadSettings(store('{"quality":"high"}'))).toEqual({ quality: 'high' });
    expect(loadSettings(store('{"quality":"auto"}'))).toEqual({ quality: 'auto' });
  });

  it.each([
    ['invalid JSON', '{nope'],
    ['a non-object', '42'],
    ['null', 'null'],
    ['a wrong type', '{"quality":3}'],
    ['an unknown preset', '{"quality":"ultra"}'],
    ['a missing field', '{}'],
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
    saveSettings({ quality: 'low' }, s);
    expect(loadSettings(s)).toEqual({ quality: 'low' });
  });

  it('swallows a throwing or missing store', () => {
    expect(() => saveSettings({ quality: 'low' }, throwing)).not.toThrow();
    expect(() => saveSettings({ quality: 'low' }, null)).not.toThrow();
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
