// Carrion (M7, DESIGN §2): when a fight kills a creature, 40% of its biomass becomes food that drops
// where it died and spoils. Pieces live in `World.carrion`; an eaten one is recorded in
// `World.consumed` under its id (cycle 1, never respawning), so the claim rules of ADR 0016 settle
// contested bites. Everything here is a pure function of the world and the kill, so every client
// that applies the same drop holds the same pieces.

import { clamp, cos, lerp, sin, TAU } from './math';
import { hashU32 } from './prng';
import { RULES } from './rules';
import type { CarrionPiece, World } from './types';

const SALT = { angle: 1, dist: 2 } as const;
const ID_PATTERN = /^x[0-9a-f]{8}_\d{1,2}$/;

/** Where and what a kill leaves; `enc` is the encounter id (hex), `tick` the tick of the kill. */
export interface Drop {
  enc: string;
  x: number;
  y: number;
  biomass: number;
  radius: number;
  tick: number;
}

/** Whether `id` names a carrion piece (and so is claimed as a slot of cycle 0). */
export const isCarrionId = (id: string): boolean => ID_PATTERN.test(id);

/** Whether a piece is still there at `world.tick`: not spoiled and not eaten. */
export function carrionAlive(world: World, piece: CarrionPiece): boolean {
  return world.tick < piece.expires && world.consumed[piece.id] === undefined;
}

const unit = (hash: number): number => hash / 4294967296;

/** How many pieces a victim of `radius` leaves. */
export const pieceCount = (radius: number): number =>
  clamp(
    Math.round(radius / RULES.carrion.perPiece),
    RULES.carrion.minPieces,
    RULES.carrion.maxPieces,
  );

/**
 * Adds a kill's pieces, in id order, in place: the same drop on two worlds gives the same pieces.
 * A piece whose id is held already (a drop heard twice) or already eaten (its claim came first) is
 * skipped. Spoiled pieces and their `consumed` entries are cleared first.
 */
export function dropCarrion(world: World, drop: Drop): void {
  const c = RULES.carrion;
  const reward = RULES.encounter.reward;
  prune(world);
  const count = pieceCount(drop.radius);
  const value = (reward.carrion * drop.biomass * reward.energyPerBiomass) / count;
  const key = Number.parseInt(drop.enc.slice(0, 8), 16) >>> 0;
  const radius = c.radiusBase + c.radiusPerVictim * drop.radius;
  const held = new Set(world.carrion.map((p) => p.id));
  for (let i = 0; i < count; i++) {
    const id = `x${drop.enc.slice(0, 8)}_${i}`;
    if (held.has(id) || world.consumed[id] !== undefined) continue;
    const angle = unit(hashU32(...world.seed32, key, i, SALT.angle)) * TAU;
    // The square root spreads the pieces evenly over the disc rather than piling them at the centre.
    const away =
      Math.sqrt(unit(hashU32(...world.seed32, key, i, SALT.dist))) * c.scatter * drop.radius;
    world.carrion.push({
      id,
      x: clamp(drop.x + cos(angle) * away, 0, world.size),
      y: clamp(drop.y + sin(angle) * away, 0, world.size),
      value,
      radius,
      expires: drop.tick + c.lifeTicks,
    });
  }
  world.carrion.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Removes spoiled pieces, and the eaten-piece entries of `consumed` that outlived them. */
function prune(world: World): void {
  let kept = 0;
  for (const piece of world.carrion) {
    if (world.tick < piece.expires) world.carrion[kept++] = piece;
    else delete world.consumed[piece.id];
  }
  world.carrion.length = kept;
}

/** The pieces on the water within `radius` of a point, in id order. */
export function carrionNear(world: World, x: number, y: number, radius: number): CarrionPiece[] {
  return world.carrion.filter((piece) => {
    const dx = piece.x - x;
    const dy = piece.y - y;
    return carrionAlive(world, piece) && dx * dx + dy * dy <= radius * radius;
  });
}

/** Marks a piece eaten: its id joins `consumed` as cycle 1 until it would have spoiled. */
export function consumeCarrion(world: World, id: string): void {
  const piece = world.carrion.find((p) => p.id === id);
  if (piece === undefined || !carrionAlive(world, piece))
    throw new Error(`carrion ${id} is not alive`);
  world.consumed[id] = { k: 1, until: piece.expires };
}

/**
 * Applies another player's claim on a piece: eaten at `claim.tick`. A claim that beats the one this
 * client holds replaces it. False, changing nothing, for a cycle other than 0.
 */
export function applyRemoteCarrionClaim(
  world: World,
  claim: { slot: string; k: number; tick: number },
): boolean {
  if (claim.k !== 0 || !isCarrionId(claim.slot)) return false;
  const piece = world.carrion.find((p) => p.id === claim.slot);
  world.consumed[claim.slot] = {
    k: 1,
    until: piece?.expires ?? claim.tick + RULES.carrion.lifeTicks,
  };
  return true;
}

/** How much of a piece a mouth of `type` (0 filter to 1 jaw) takes in, 0 to 1. */
export function carrionEfficiency(type: number): number {
  const { filter, middle, jaw } = RULES.carrion.efficiency;
  return type <= 0.5 ? lerp(filter, middle, type * 2) : lerp(middle, jaw, (type - 0.5) * 2);
}
