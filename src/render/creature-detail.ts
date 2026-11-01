// How finely a creature mesh is drawn on each level of detail (ADR 0025): the vertex budgets, each
// level's ladder of detail, the organs' detail and the vertices each level keeps for the organs and
// glints. `creature-fit.ts` steps a body down the ladder until it fits.

import { CHAMBERS } from './anatomy';
import type { PresetName } from './presets';
import { MAX_GLINTS } from './surface';

const { max } = Math;

/** A creature's level of detail is a quality preset's: the budgets of ADR 0025. */
export type Lod = PresetName;
export const LOD_BUDGET: Readonly<Record<Lod, number>> = {
  high: 12_000,
  medium: 6_000,
  low: 1_500,
};

/** How finely a body is drawn; every count only ever falls down a ladder. */
export interface MeshDetail {
  /** Body rings per segment along the loft (even, so a ring crosses the middle of a lone cell). */
  bodyRings: number;
  /** Vertices round the body and a carapace. */
  bodyRing: number;
  /** Rings per joint of a part; 0 draws each part as one straight piece. */
  jointRings: number;
  /** Vertices round a part. */
  partRing: number;
  /** Vertices round a bulb's equator; 0 draws a bulb as a widened tip (eyes keep 4). */
  ball: number;
  /** Share of each part's bristles drawn. */
  setae: number;
  /** Vertices per bristle: 5 (bendable) or 3. */
  setaVertices: number;
  /** Rows of a membrane sheet from its root. */
  web: number;
}

const rung = (
  bodyRings: number,
  bodyRing: number,
  jointRings: number,
  partRing: number,
  ball: number,
  setae: number,
  setaVertices: number,
  web: number,
): MeshDetail => ({ bodyRings, bodyRing, jointRings, partRing, ball, setae, setaVertices, web });

/**
 * Each level's ladder, richest first; a body takes the first rung that fits its budget, then the
 * lower levels' rungs. The last low rung fits any plan development can make (24 parts of 4 joints
 * and 2 branches each, every detail on): about 1,200 vertices.
 */
export const LOD_LADDER: Readonly<Record<Lod, readonly MeshDetail[]>> = {
  high: [
    rung(10, 16, 4, 8, 8, 1, 5, 4),
    rung(8, 14, 3, 7, 8, 1, 5, 3),
    rung(8, 12, 3, 6, 6, 1, 3, 2),
    rung(6, 12, 2, 6, 6, 1, 3, 2),
  ],
  medium: [
    rung(6, 12, 3, 6, 6, 1, 3, 2),
    rung(6, 10, 2, 5, 6, 1, 3, 2),
    rung(4, 8, 2, 4, 4, 0.5, 3, 1),
    rung(4, 8, 1, 4, 4, 0.25, 3, 1),
  ],
  low: [
    rung(4, 8, 1, 4, 4, 0.5, 3, 1),
    rung(2, 6, 1, 3, 4, 0.25, 3, 1),
    rung(2, 6, 0, 3, 0, 0, 3, 1),
  ],
};

/** How finely the organs are drawn on each level: vertices round a ball's equator, gut rings and vertices round the gut. */
export interface OrganDetail {
  ball: number;
  gutRings: number;
  gutRing: number;
}
export const ORGAN_DETAIL: Readonly<Record<Lod, OrganDetail>> = {
  high: { ball: 10, gutRings: 20, gutRing: 6 },
  medium: { ball: 6, gutRings: 12, gutRing: 5 },
  low: { ball: 4, gutRings: 6, gutRing: 4 },
};
/** A ball's vertices (`addBall`): its bands' rings and the two poles. */
const ballVertices = (lon: number): number => (max(2, lon >> 1) - 1) * lon + 2;
/**
 * The organs' vertices on one level: each ball and the gut. A body has at most one heart, two
 * pigment spots and `CHAMBERS.max` chambers.
 */
export const organVertices = (lod: Lod, organs: number, gut: boolean): number => {
  const o = ORGAN_DETAIL[lod];
  return organs * ballVertices(o.ball) + (gut ? o.gutRings * o.gutRing : 0);
};
const MOST_ORGANS = 3 + CHAMBERS.max;
/** The vertices each level keeps for the organs, whatever the anatomy: the body fits the rest. */
export const ORGAN_RESERVE: Readonly<Record<Lod, number>> = {
  high: organVertices('high', MOST_ORGANS, true),
  medium: organVertices('medium', MOST_ORGANS, true),
  low: organVertices('low', MOST_ORGANS, true),
};
/** Every level keeps room for the most glints (M6 T13): one quad each. */
export const GLINT_RESERVE = 4 * MAX_GLINTS;
