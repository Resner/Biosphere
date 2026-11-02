// Fighter collisions (DESIGN §7): the collision circles of two fighters push apart along the line
// of centres, split by mass, and the closing velocity along it is removed.

import { cos, length, sin } from '../math';
import { radiusOf } from './reach';
import type { Fighter } from './types';

const PASSES = 2;

/** A pair pressed together in a tick: the fighters, the closing speed, and whether `a` is the rammer. */
export interface Impact {
  a: Fighter;
  b: Fighter;
  closing: number;
  aRams: boolean;
}

// Where `separate` records impacts during a `collide` call, or null.
let impacts: Impact[] | null = null;

// Per-fighter values that do not change while a tick's collisions resolve, in `fighters` order.
const cosH: number[] = [];
const sinH: number[] = [];
/** How far the farthest circle edge lies from the centre, in core radii. */
const extent: number[] = [];

// The deepest overlap found by `deepest`: its depth, and the unit normal from a to b.
let depth = 0;
let nx = 0;
let ny = 0;

/** Sets `depth`, `nx` and `ny` to the deepest overlap of two bodies' circles; depth is 0 for none. */
function deepest(a: Fighter, ai: number, b: Fighter, bi: number): void {
  depth = 0;
  const ra = radiusOf(a.body);
  const rb = radiusOf(b.body);
  const apart = length(b.body.x - a.body.x, b.body.y - a.body.y);
  if (apart > (extent[ai] as number) * ra + (extent[bi] as number) * rb) return;
  const ca = cosH[ai] as number;
  const sa = sinH[ai] as number;
  const cb = cosH[bi] as number;
  const sb = sinH[bi] as number;
  for (const ka of a.body.phys.colliders) {
    const ax = a.body.x + (ka.x * ca - ka.y * sa) * ra;
    const ay = a.body.y + (ka.x * sa + ka.y * ca) * ra;
    for (const kb of b.body.phys.colliders) {
      const bx = b.body.x + (kb.x * cb - kb.y * sb) * rb;
      const by = b.body.y + (kb.x * sb + kb.y * cb) * rb;
      const dx = bx - ax;
      const dy = by - ay;
      const dist = length(dx, dy);
      const overlap = ka.r * ra + kb.r * rb - dist;
      if (overlap > depth) {
        depth = overlap;
        nx = dist > 0 ? dx / dist : 1;
        ny = dist > 0 ? dy / dist : 0;
      }
    }
  }
}

function separate(a: Fighter, ai: number, b: Fighter, bi: number): void {
  deepest(a, ai, b, bi);
  if (depth <= 0) return;
  const ma = a.combat.mass;
  const mb = b.combat.mass;
  const total = ma + mb;
  const shareA = mb / total;
  const shareB = ma / total;
  a.body.x -= nx * depth * shareA;
  a.body.y -= ny * depth * shareA;
  b.body.x += nx * depth * shareB;
  b.body.y += ny * depth * shareB;
  const va = a.body.vx * nx + a.body.vy * ny;
  const vb = b.body.vx * nx + b.body.vy * ny;
  if (vb - va >= 0) return;
  impacts?.push({ a, b, closing: va - vb, aRams: va >= -vb });
  const common = (ma * va + mb * vb) / total;
  a.body.vx += nx * (common - va);
  a.body.vy += ny * (common - va);
  b.body.vx += nx * (common - vb);
  b.body.vy += ny * (common - vb);
}

/** Resolves every pair of the given fighters (in slot order) for one tick, appending each impact to `out`. */
export function collide(fighters: readonly Fighter[], out: Impact[] | null = null): void {
  impacts = out;
  for (let i = 0; i < fighters.length; i++) {
    const f = fighters[i] as Fighter;
    cosH[i] = cos(f.body.heading);
    sinH[i] = sin(f.body.heading);
    let far = 0;
    for (const k of f.body.phys.colliders) far = Math.max(far, length(k.x, k.y) + k.r);
    extent[i] = far;
  }
  for (let pass = 0; pass < PASSES; pass++) {
    for (let i = 0; i < fighters.length; i++) {
      for (let j = i + 1; j < fighters.length; j++) {
        separate(fighters[i] as Fighter, i, fighters[j] as Fighter, j);
      }
    }
  }
}
