import { describe, expect, it } from 'vitest';
import { HINT_KEY, HINT_SHOW_MS, HINTS, Hints, hintAt } from './hints';

/** A Storage stand-in backed by a map. */
function memory(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, v),
  };
}

/** A Storage whose every read and write throws, as a blocked one does. */
const broken = (): Storage =>
  new Proxy({} as Storage, {
    get() {
      throw new Error('blocked');
    },
  });

describe('hintAt', () => {
  it('shows the swim hint for the first 8 s of the first life', () => {
    expect(HINTS[0]).toBe('Mouse or WASD to swim · Space to dash');
    expect(hintAt(true, 0)).toBe(HINTS[0]);
    expect(hintAt(true, HINT_SHOW_MS - 1)).toBe(HINTS[0]);
    expect(hintAt(true, HINT_SHOW_MS)).toBeNull();
  });

  it('shows the social hint after 30 s of play, for 8 s', () => {
    expect(HINTS[1]).toBe('G wheel · M map · Enter chat');
    expect(hintAt(true, 29_999)).toBeNull();
    expect(hintAt(true, 30_000)).toBe(HINTS[1]);
    expect(hintAt(true, 30_000 + HINT_SHOW_MS - 1)).toBe(HINTS[1]);
    expect(hintAt(true, 30_000 + HINT_SHOW_MS)).toBeNull();
    expect(hintAt(true, 600_000)).toBeNull();
  });

  it('shows nothing on later lives', () => {
    for (const ms of [0, 1000, 30_000, 35_000]) expect(hintAt(false, ms)).toBeNull();
  });
});

describe('Hints', () => {
  it('gives the first life of a browser the hints, and stores that it did', () => {
    const store = memory();
    const first = new Hints(store);
    first.startLife();
    expect(first.at(0)).toBe(HINTS[0]);
    expect(store.getItem(HINT_KEY)).not.toBeNull();
    // A second life in the same visit shows none.
    first.startLife();
    expect(first.at(0)).toBeNull();
    // Nor does a later visit.
    const later = new Hints(store);
    later.startLife();
    expect(later.at(0)).toBeNull();
    expect(later.at(31_000)).toBeNull();
  });

  it('works without storage, and with storage that throws', () => {
    for (const store of [null, broken()]) {
      const hints = new Hints(store);
      hints.startLife();
      expect(hints.at(0)).toBe(HINTS[0]);
      hints.startLife();
      expect(hints.at(0)).toBeNull();
    }
  });

  it('shows nothing before a life starts', () => {
    expect(new Hints(memory()).at(0)).toBeNull();
  });
});
