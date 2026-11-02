// Fighter collisions (DESIGN §7): the collision circles of two fighters push apart along the line
// of centres, split by mass, and the closing velocity along it is removed.

import { cos, length, sin } from '../math';
import type { Fighter } from './types';

const PASSES = 2;

/** The deepest overlap of two bodies' circles as { depth, nx, ny } (n points from a to b), or null. */
function deepest(a: Fighter, b: Fighter): { depth: number; nx: number; ny: number } | null {
  const ra = Math.sqrt(a.body.biomass);
  const rb = Math.sqrt(b.body.biomass);
  const apart = length(b.body.x - a.body.x, b.body.y - a.body.y);
  // Every circle lies within the sanitised reach of its centre plus the largest circle.
  const bound = extent(a) * ra + extent(b) * rb;
  if (apart > bound) return null;
  const ca = cos(a.body.heading);
  const sa = sin(a.body.heading);
  const cb = cos(b.body.heading);
  const sb = sin(b.body.heading);
  let best: { depth: number; nx: number; ny: number } | null = null;
  for (const ka of a.body.phys.colliders) {
    const ax = a.body.x + (ka.x * ca - ka.y * sa) * ra;
    const ay = a.body.y + (ka.x * sa + ka.y * ca) * ra;
    for (const kb of b.body.phys.colliders) {
      const bx = b.body.x + (kb.x * cb - kb.y * sb) * rb;
      const by = b.body.y + (kb.x * sb + kb.y * cb) * rb;
      const dx = bx - ax;
      const dy = by - ay;
      const dist = length(dx, dy);
      const depth = ka.r * ra + kb.r * rb - dist;
      if (depth > 0 && (best === null || depth > best.depth)) {
        best = dist > 0 ? { depth, nx: dx / dist, ny: dy / dist } : { depth, nx: 1, ny: 0 };
      }
    }
  }
  return best;
}

/** How far the farthest circle edge lies from the centre, in core radii. */
function extent(f: Fighter): number {
  let far = 0;
  for (const k of f.body.phys.colliders) far = Math.max(far, length(k.x, k.y) + k.r);
  return far;
}

function separate(a: Fighter, b: Fighter): void {
  const hit = deepest(a, b);
  if (hit === null) return;
  const ma = a.combat.mass;
  const mb = b.combat.mass;
  const total = ma + mb;
  a.body.x -= hit.nx * hit.depth * (mb / total);
  a.body.y -= hit.ny * hit.depth * (mb / total);
  b.body.x += hit.nx * hit.depth * (ma / total);
  b.body.y += hit.ny * hit.depth * (ma / total);
  const va = a.body.vx * hit.nx + a.body.vy * hit.ny;
  const vb = b.body.vx * hit.nx + b.body.vy * hit.ny;
  if (vb - va >= 0) return;
  const common = (ma * va + mb * vb) / total;
  a.body.vx += hit.nx * (common - va);
  a.body.vy += hit.ny * (common - va);
  b.body.vx += hit.nx * (common - vb);
  b.body.vy += hit.ny * (common - vb);
}

/** Resolves every pair of the given fighters (in slot order) for one tick. */
export function collide(fighters: readonly Fighter[]): void {
  for (let pass = 0; pass < PASSES; pass++) {
    for (let i = 0; i < fighters.length; i++) {
      for (let j = i + 1; j < fighters.length; j++) {
        separate(fighters[i] as Fighter, fighters[j] as Fighter);
      }
    }
  }
}
