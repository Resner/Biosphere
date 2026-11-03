// Reach and range (DESIGN §7): who can strike whom, and who may engage. All distances in wu.

import { cos, length, sin } from '../math';
import { RULES } from '../rules';
import type { CreatureState } from '../types';
import type { Fighter } from './types';

export const radiusOf = (c: CreatureState): number => Math.sqrt(c.biomass);

/** The farther of the weapon reach and the mouth's reach, times the radius. */
export function strikeReach(f: Fighter): number {
  const mouth = f.body.phys.mouth;
  return Math.max(f.combat.reach, mouth.offset + mouth.radius) * radiusOf(f.body);
}

/** The result of `aimAt`: the edge distance, the cosine of the bearing off the attacker's heading and the vector to the aimed circle's centre. */
export const aim = { distance: 0, cos: 1, dx: 0, dy: 0 };

/**
 * Sets `aim` for an attacker and a target: the distance from the attacker's centre to the nearest
 * edge of the target's collision circles (never negative), and the bearing to that circle's centre
 * as a cosine off the attacker's heading (1 when the centres coincide); `bearing = false` skips the
 * cosine and leaves `aim.cos` stale.
 */
export function aimAt(attacker: CreatureState, target: CreatureState, bearing = true): void {
  const radius = radiusOf(target);
  const cosH = cos(target.heading);
  const sinH = sin(target.heading);
  let best = Number.POSITIVE_INFINITY;
  let bx = 0;
  let by = 0;
  for (const k of target.phys.colliders) {
    const cx = target.x + (k.x * cosH - k.y * sinH) * radius;
    const cy = target.y + (k.x * sinH + k.y * cosH) * radius;
    const edge = length(cx - attacker.x, cy - attacker.y) - k.r * radius;
    if (edge < best) {
      best = edge;
      bx = cx - attacker.x;
      by = cy - attacker.y;
    }
  }
  aim.distance = Math.max(0, best);
  aim.dx = bx;
  aim.dy = by;
  if (!bearing) return;
  const apart = length(bx, by);
  aim.cos = apart > 0 ? (bx * cos(attacker.heading) + by * sin(attacker.heading)) / apart : 1;
}

/** From the attacker's centre to the nearest edge of the target's collision circles (never negative). */
export function strikeDistance(attacker: CreatureState, target: CreatureState): number {
  aimAt(attacker, target, false);
  return aim.distance;
}

/** The distance within which `attacker` may engage `target`: its reach plus 30% of the target's radius. */
export function engageRange(attacker: Fighter, target: Fighter): number {
  return strikeReach(attacker) + RULES.encounter.engageSlack * radiusOf(target.body);
}
