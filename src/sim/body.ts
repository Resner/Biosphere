// The body seam (ADR 0006, ADR 0018): the few numbers a creature's anatomy hands to the rules.
// M3's genome code computes a `PhysStats` from a body plan; until then tests build them by hand.
// Plain data, part of the state hash.

import { length } from './math';
import { RULES } from './rules';

/** A mouth in the body frame, in units of the core radius. `type` runs from 0 (filter) to 1 (jaw). */
export interface Mouth {
  offset: number;
  radius: number;
  /** Half-angle of the reach in radians, around the heading: π reaches all round. */
  arc: number;
  type: number;
  digestion: number;
}

/** A collision circle in the body frame (x forward, y left), in units of the core radius. */
export interface Collider {
  x: number;
  y: number;
  r: number;
}

export interface PhysStats {
  /** wu of biomass at which growth stops; the radius is √biomass. */
  maxBiomass: number;
  /** Multipliers on `RULES.movement`. */
  thrust: number;
  drag: number;
  turn: number;
  /** Multipliers on metabolism and growth rate. */
  basal: number;
  growth: number;
  mouth: Mouth;
  /** 1 to 12 circles; the first is always the core `{ x: 0, y: 0, r: 1 }` (sanitising replaces it). */
  colliders: Collider[];
}

const deepFreeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

/** The M1 cell: every multiplier 1, an all-round mouth on the core, no appendages. */
export const STARTER_PHYS: PhysStats = deepFreeze({
  maxBiomass: 400,
  thrust: 1,
  drag: 1,
  turn: 1,
  basal: 1,
  growth: 1,
  mouth: { offset: 0, radius: 1, arc: Math.PI, type: 0.5, digestion: 1 },
  colliders: [{ x: 0, y: 0, r: 1 }],
});

const finiteOr = (value: number, fallback: number): number =>
  Number.isFinite(value) ? value : fallback;

const clampTo = (value: number, min: number, max: number, fallback: number): number =>
  Math.min(max, Math.max(min, finiteOr(value, fallback)));

/**
 * A copy of `phys` with every value forced into range: a body from the network or a log can be
 * hostile, and the rules never see anything outside the caps of ADR 0006. Idempotent.
 */
export function sanitizePhys(phys: PhysStats): PhysStats {
  const b = RULES.body;
  const mult = (value: number, fallback: number): number =>
    clampTo(value, b.multiplierMin, b.multiplierMax, fallback);

  const colliders: Collider[] = [{ x: 0, y: 0, r: 1 }];
  for (const c of phys.colliders.slice(1)) {
    if (colliders.length >= b.maxColliders) break;
    if (!Number.isFinite(c.x) || !Number.isFinite(c.y) || !Number.isFinite(c.r)) continue;
    const r = Math.min(b.maxColliderRadius, Math.max(b.minColliderRadius, c.r));
    const distance = Math.sqrt(c.x * c.x + c.y * c.y);
    const room = b.maxReach - r;
    // Land just inside the cap so that a second pass leaves the circle where it is.
    const scale = distance > room ? (room - 1e-9) / distance : 1;
    colliders.push({ x: c.x * scale, y: c.y * scale, r });
  }

  const m = phys.mouth;
  return {
    maxBiomass: clampTo(
      phys.maxBiomass,
      b.maxBiomassFloor,
      b.maxBiomassCeiling,
      STARTER_PHYS.maxBiomass,
    ),
    thrust: mult(phys.thrust, 1),
    drag: mult(phys.drag, 1),
    turn: mult(phys.turn, 1),
    basal: mult(phys.basal, 1),
    growth: mult(phys.growth, 1),
    mouth: {
      offset: clampTo(m.offset, 0, b.maxReach, 0),
      radius: clampTo(m.radius, b.minMouthRadius, b.maxMouthRadius, 1),
      arc: clampTo(m.arc, b.minMouthArc, Math.PI, Math.PI),
      type: clampTo(m.type, 0, 1, 0.5),
      digestion: clampTo(m.digestion, b.digestionMin, b.digestionMax, 1),
    },
    colliders,
  };
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Whether `value` has the shape of a `PhysStats` with finite numbers (they may be out of range). */
export function isPhysShape(value: unknown): value is PhysStats {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  const m = p.mouth as Record<string, unknown> | null | undefined;
  return (
    ['maxBiomass', 'thrust', 'drag', 'turn', 'basal', 'growth'].every((k) => isNumber(p[k])) &&
    typeof m === 'object' &&
    m !== null &&
    ['offset', 'radius', 'arc', 'type', 'digestion'].every((k) => isNumber(m[k])) &&
    Array.isArray(p.colliders) &&
    p.colliders.length <= 64 &&
    p.colliders.every((c: unknown) => {
      const o = c as Record<string, unknown> | null;
      return typeof o === 'object' && o !== null && ['x', 'y', 'r'].every((k) => isNumber(o[k]));
    })
  );
}

/** How far the farthest collider centre lies from the core centre, in wu at this biomass. */
export function colliderReach(phys: PhysStats, biomass: number): number {
  let far = 0;
  for (const c of phys.colliders) far = Math.max(far, length(c.x, c.y));
  return far * Math.sqrt(biomass);
}
