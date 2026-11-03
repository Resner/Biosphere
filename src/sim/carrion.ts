// Carrion (M7, DESIGN §2): when a fight kills a creature, 40% of its biomass becomes food that drops
// where it died and spoils. Pieces live in `World.carrion`; an eaten one is recorded in
// `World.consumed` under its id (cycle 1, never respawning), so the claim rules of ADR 0016 settle
// contested bites. Everything here is a pure function of the world and the kill, so every client
// that applies the same drop holds the same pieces.

import { clamp, cos, lerp3, sin, TAU } from './math';
import { hashU32 } from './prng';
import { RULES } from './rules';
import type { CarrionPiece, World } from './types';

const SALT = { angle: 1, dist: 2, where: 3 } as const;
// `x`, the first 8 hex digits of the encounter id, 8 hex digits hashing where the victim died, `_`, the piece.
const ID_PATTERN = /^x[0-9a-f]{16}_\d{1,2}$/;
/** Most claims held for pieces this client has not heard dropped yet (a peer's bite can beat the hub's message). */
const MAX_EARLY_CLAIMS = 64;

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
 * skipped. Pieces spoiled by the drop's tick, and their `consumed` entries, are cleared first.
 */
export function dropCarrion(world: World, drop: Drop): void {
  const c = RULES.carrion;
  const reward = RULES.encounter.reward;
  prune(world, drop.tick);
  const count = pieceCount(drop.radius);
  const value = (reward.carrion * drop.biomass * reward.energyPerBiomass) / count;
  const key = Number.parseInt(drop.enc.slice(0, 8), 16) >>> 0;
  const radius = c.radiusBase + c.radiusPerVictim * drop.radius;
  const held = new Set(world.carrion.map((p) => p.id));
  // Two victims of one fight (a mutual kill) die in different places, so their pieces get different ids.
  // The whole position (to 1/16 wu) is hashed into 32 bits, so near drops differ too.
  const where = hashU32(key, Math.round(drop.x * 16), Math.round(drop.y * 16), SALT.where)
    .toString(16)
    .padStart(8, '0');
  for (let i = 0; i < count; i++) {
    const id = `x${drop.enc.slice(0, 8)}${where}_${i}`;
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

/** Removes spoiled pieces, and every eaten-piece entry of `consumed` that has spoiled, held or not. */
function prune(world: World, now: number): void {
  let kept = 0;
  for (const piece of world.carrion) {
    if (now < piece.expires) world.carrion[kept++] = piece;
  }
  world.carrion.length = kept;
  for (const [id, eaten] of Object.entries(world.consumed)) {
    if (eaten.until <= now && isCarrionId(id)) delete world.consumed[id];
  }
}

/** The pieces on the water at `world.tick`, in id order: the one definition of "alive" for the hash, the views and the renderer. */
export function livePieces(world: World): CarrionPiece[] {
  return world.carrion.length === 0 ? NONE : world.carrion.filter((p) => carrionAlive(world, p));
}

const NONE: CarrionPiece[] = [];

/** The pieces on the water within `radius` of a point, in id order. */
export function carrionNear(world: World, x: number, y: number, radius: number): CarrionPiece[] {
  if (world.carrion.length === 0) return NONE;
  const found: CarrionPiece[] = [];
  for (const piece of world.carrion) {
    const dx = piece.x - x;
    const dy = piece.y - y;
    if (dx * dx + dy * dy <= radius * radius && carrionAlive(world, piece)) found.push(piece);
  }
  return found;
}

/** Marks a piece eaten: its id joins `consumed` as cycle 1 until it would have spoiled. */
export function consumeCarrion(world: World, id: string): void {
  const piece = world.carrion.find((p) => p.id === id);
  if (piece === undefined || !carrionAlive(world, piece))
    throw new Error(`carrion ${id} is not alive`);
  world.consumed[id] = { k: 1, until: piece.expires };
}

/**
 * Applies another player's claim on a piece: eaten at `claim.tick`. The first claim sets when the
 * entry spoils; who won is the claim book's business. A claim for a piece not heard of yet is kept
 * (the hub's `carrion` may be late), up to `MAX_EARLY_CLAIMS` at a time. False, changing nothing,
 * for a cycle other than 0 or too many early claims.
 */
export function applyRemoteCarrionClaim(
  world: World,
  claim: { slot: string; k: number; tick: number },
): boolean {
  if (claim.k !== 0 || !isCarrionId(claim.slot)) return false;
  if (world.consumed[claim.slot] !== undefined) return true;
  const piece = world.carrion.find((p) => p.id === claim.slot);
  if (piece === undefined) {
    const early = Object.keys(world.consumed).filter(
      (id) => isCarrionId(id) && !world.carrion.some((p) => p.id === id),
    );
    if (early.length >= MAX_EARLY_CLAIMS) return false;
  }
  world.consumed[claim.slot] = {
    k: 1,
    until: piece?.expires ?? claim.tick + RULES.carrion.lifeTicks,
  };
  return true;
}

/** How much of a piece a mouth of `type` (0 filter to 1 jaw) takes in, 0 to 1. */
export function carrionEfficiency(type: number): number {
  const { filter, middle, jaw } = RULES.carrion.efficiency;
  return lerp3(filter, middle, jaw, type);
}

/** A carrion piece's claim: its own slot, cycle 0 (it never respawns), or null if `id` is not one. */
export const carrionClaimOf = (id: string): { slot: string; k: number } | null =>
  isCarrionId(id) ? { slot: id, k: 0 } : null;
