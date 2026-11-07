// What the map shows (M11 T18, DESIGN §9): a square of the world centred on the player, the larger
// of 8,192 wu and 8 × its area of interest, so a starter sees the spawn's surroundings and a large
// creature the reach of its links. Linked players are dots with names; players the directory or
// gossip know of but not linked are hollow marks that fade with the sighting's age. Pure: no DOM.

import { aoiRadius, type Known } from '../net/aoi';
import { clamp } from '../sim/math';
import type { Seed } from '../sim/prng';

/** The map's least side, wu. */
export const MAP_MIN_SIDE = 8192;
/** The map's side in areas of interest (radii). */
export const MAP_AOI_SIDES = 8;
/** A sighting this old (ms) is drawn at its faintest; it stays until the known set drops it. */
export const SIGHTING_FADE_MS = 30_000;
/** The faintest a sighting is drawn. */
const SIGHTING_MIN_ALPHA = 0.35;

/** The map's side in wu for a creature of radius `r` whose adult radius is `adultR`. */
export function mapSide(r: number, adultR: number): number {
  return Math.max(MAP_MIN_SIDE, MAP_AOI_SIDES * aoiRadius(r, adultR));
}

/**
 * A world position on a map of `side` wu centred on (`cx`, `cy`): 0..1 from the left and from the
 * top (north up), clamped, and whether it lies inside the square.
 */
export function mapSpot(
  x: number,
  y: number,
  cx: number,
  cy: number,
  side: number,
): { u: number; v: number; inside: boolean } {
  const u = 0.5 + (x - cx) / side;
  const v = 0.5 - (y - cy) / side;
  return { u: clamp(u, 0, 1), v: clamp(v, 0, 1), inside: u >= 0 && u <= 1 && v >= 0 && v <= 1 };
}

/** Whether the world's spawn centre and its edge fall in a square of `side` wu centred on (`cx`, `cy`). */
export function squareShows(
  cx: number,
  cy: number,
  side: number,
  size: number,
): { spawn: boolean; edge: boolean } {
  const h = side / 2;
  const centre = size / 2;
  return {
    spawn: Math.abs(centre - cx) <= h && Math.abs(centre - cy) <= h,
    edge: cx - h < 0 || cy - h < 0 || cx + h > size || cy + h > size,
  };
}

/** How opaque a sighting `age` ms old is drawn: 1 when new, fading to a faint mark. */
export function sightingAlpha(age: number): number {
  const t = clamp(age / SIGHTING_FADE_MS, 0, 1);
  return 1 - t * (1 - SIGHTING_MIN_ALPHA);
}

export interface MapPlayer {
  id: string;
  name: string;
  x: number;
  y: number;
  ready: boolean;
}

/** A player known but not linked: where and how long ago (ms) it was last placed. */
export interface MapSighting {
  id: string;
  name: string;
  x: number;
  y: number;
  age: number;
}

export interface MapView {
  seed: Seed;
  /** The world's side, wu. */
  size: number;
  /** The map's side, wu (`mapSide`); the square is centred on `self`. */
  side: number;
  self: MapPlayer;
  /** The linked players. */
  players: readonly MapPlayer[];
  /** The players known but not linked. */
  known: readonly MapSighting[];
  pings: readonly { kind: number; x: number; y: number }[];
}

/**
 * The newest sighting of each known player who is neither linked nor the player, with its name
 * (empty when none is known) and its age.
 */
export function sightings(
  known: readonly Known[],
  linked: { has(id: string): boolean },
  selfId: string,
  nameOf: (id: string) => string | undefined,
  now: number,
): MapSighting[] {
  const newest = new Map<string, Known>();
  for (const k of known) {
    if (k.id === selfId || linked.has(k.id)) continue;
    const seen = newest.get(k.id);
    if (!seen || k.at > seen.at) newest.set(k.id, k);
  }
  return [...newest.values()].map((k) => ({
    id: k.id,
    name: nameOf(k.id) ?? '',
    x: k.x,
    y: k.y,
    age: Math.max(0, now - k.at),
  }));
}

/** A mark's shape: you a ring, linked players dots (hearts when ready), sightings hollow rings. */
export type MapMarkKind = 'self' | 'player' | 'ready' | 'known';

export interface MapMark {
  id: string;
  name: string;
  mark: MapMarkKind;
  u: number;
  v: number;
  alpha: number;
}

/**
 * The marks on the map, the player first: linked players, then the sightings of players who are
 * not linked, each once, leaving out what falls off the square.
 */
export function mapMarks(view: MapView): MapMark[] {
  const { self, side } = view;
  const out: MapMark[] = [{ id: self.id, name: self.name, mark: 'self', u: 0.5, v: 0.5, alpha: 1 }];
  const seen = new Set<string>([self.id]);
  for (const p of view.players) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    const { u, v, inside } = mapSpot(p.x, p.y, self.x, self.y, side);
    if (inside)
      out.push({ id: p.id, name: p.name, mark: p.ready ? 'ready' : 'player', u, v, alpha: 1 });
  }
  for (const k of view.known) {
    if (seen.has(k.id)) continue;
    seen.add(k.id);
    const { u, v, inside } = mapSpot(k.x, k.y, self.x, self.y, side);
    if (inside)
      out.push({ id: k.id, name: k.name, mark: 'known', u, v, alpha: sightingAlpha(k.age) });
  }
  return out;
}
