import { describe, expect, it } from 'vitest';
import type { Known } from '../net/aoi';
import { aoiRadius } from '../net/aoi';
import { sizeTier } from '../sim/size';
import {
  MAP_MIN_SIDE,
  type MapView,
  mapMarks,
  mapSide,
  mapSpot,
  SIGHTING_FADE_MS,
  sightingAlpha,
  sightings,
  squareShows,
} from './map-view';

const view = (over: Partial<MapView> = {}): MapView => ({
  seed: [1, 2, 3, 4],
  size: 262_144,
  side: 8192,
  self: { id: 'me', name: 'Me', x: 131_072, y: 131_072, ready: false },
  players: [],
  known: [],
  pings: [],
  ...over,
});

const known = (id: string, x: number, y: number, at: number, source: Known['source']): Known => ({
  id,
  x,
  y,
  r: 10,
  at,
  source,
});

describe('the map square', () => {
  it('is 8,192 wu for a starter and 8 × the AoI for a tier-2 adult', () => {
    expect(mapSide(10, 20)).toBe(MAP_MIN_SIDE);
    expect(mapSide(20, 20)).toBe(8192);
    // A tier-2 adult (radius 200, between 128 and 512).
    expect(sizeTier(200 * 200)).toBe(2);
    expect(mapSide(200, 200)).toBeCloseTo(8 * aoiRadius(200, 200), 6);
    expect(mapSide(200, 200)).toBeGreaterThan(20_000);
  });

  it('centres the player, north up, and says what lies inside', () => {
    expect(mapSpot(1000, 1000, 1000, 1000, 8192)).toEqual({ u: 0.5, v: 0.5, inside: true });
    expect(mapSpot(1000 + 2048, 1000 + 2048, 1000, 1000, 8192)).toEqual({
      u: 0.75,
      v: 0.25,
      inside: true,
    });
    expect(mapSpot(1000 - 4096, 1000, 1000, 1000, 8192).u).toBe(0);
    expect(mapSpot(1000 + 5000, 1000, 1000, 1000, 8192).inside).toBe(false);
  });

  it('shows the spawn centre and the world edge only when they fall in the square', () => {
    const size = 262_144;
    expect(squareShows(131_072, 131_072, 8192, size)).toEqual({ spawn: true, edge: false });
    expect(squareShows(231_072, 131_072, 8192, size)).toEqual({ spawn: false, edge: false });
    expect(squareShows(260_000, 131_072, 8192, size)).toEqual({ spawn: false, edge: true });
    expect(squareShows(2000, 2000, 8192, size)).toEqual({ spawn: false, edge: true });
  });
});

describe('the map marks', () => {
  it('shows a known player who is not linked as a hollow mark, and a linked one as a dot', () => {
    const marks = mapMarks(
      view({
        players: [{ id: 'linked', name: 'Lin', x: 131_500, y: 131_000, ready: false }],
        known: [
          { id: 'heard', name: 'Her', x: 129_000, y: 132_000, age: 0 },
          // Known and linked: the link's dot wins.
          { id: 'linked', name: 'Lin', x: 131_400, y: 131_000, age: 0 },
        ],
      }),
    );
    const by = (id: string) => marks.filter((m) => m.id === id);
    expect(by('me').map((m) => m.mark)).toEqual(['self']);
    expect(by('linked').map((m) => m.mark)).toEqual(['player']);
    expect(by('heard').map((m) => m.mark)).toEqual(['known']);
    expect(by('heard')[0]?.name).toBe('Her');
  });

  it('marks a linked player ready to mate with a heart, and leaves out anyone off the square', () => {
    const marks = mapMarks(
      view({
        players: [
          { id: 'r', name: 'Rea', x: 131_000, y: 131_000, ready: true },
          { id: 'far', name: 'Far', x: 131_072 + 6000, y: 131_072, ready: false },
        ],
        known: [{ id: 'gone', name: 'Gon', x: 131_072, y: 131_072 - 6000, age: 0 }],
      }),
    );
    expect(marks.map((m) => [m.id, m.mark])).toEqual([
      ['me', 'self'],
      ['r', 'ready'],
    ]);
  });

  it('fades a sighting with its age, never below a faint mark', () => {
    expect(sightingAlpha(0)).toBe(1);
    const half = sightingAlpha(SIGHTING_FADE_MS / 2);
    expect(half).toBeLessThan(1);
    expect(half).toBeGreaterThan(sightingAlpha(SIGHTING_FADE_MS));
    expect(sightingAlpha(SIGHTING_FADE_MS * 10)).toBe(sightingAlpha(SIGHTING_FADE_MS));
    expect(sightingAlpha(SIGHTING_FADE_MS)).toBeGreaterThan(0.2);
    const marks = mapMarks(
      view({ known: [{ id: 'old', name: 'Old', x: 131_000, y: 131_000, age: 20_000 }] }),
    );
    expect(marks.find((m) => m.id === 'old')?.alpha).toBe(sightingAlpha(20_000));
  });
});

describe('sightings', () => {
  it('keeps the newest sighting of each player not linked, with its name and age', () => {
    const now = 100_000;
    const out = sightings(
      [
        known('a', 10, 10, now - 8000, 'directory'),
        known('a', 20, 20, now - 2000, 'gossip'),
        known('b', 30, 30, now - 500, 'snapshot'),
        known('c', 40, 40, now - 1000, 'signal'),
        known('me', 0, 0, now, 'gossip'),
      ],
      new Set(['b']),
      'me',
      (id) => (id === 'a' ? 'Ann' : undefined),
      now,
    );
    expect(out).toEqual([
      { id: 'a', name: 'Ann', x: 20, y: 20, age: 2000 },
      { id: 'c', name: '', x: 40, y: 40, age: 1000 },
    ]);
  });
});
