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

/** From the attacker's centre to the nearest edge of the target's collision circles (never negative). */
export function strikeDistance(attacker: CreatureState, target: CreatureState): number {
  const radius = radiusOf(target);
  const cosH = cos(target.heading);
  const sinH = sin(target.heading);
  let best = Number.POSITIVE_INFINITY;
  for (const k of target.phys.colliders) {
    const cx = target.x + (k.x * cosH - k.y * sinH) * radius;
    const cy = target.y + (k.x * sinH + k.y * cosH) * radius;
    best = Math.min(best, length(cx - attacker.x, cy - attacker.y) - k.r * radius);
  }
  return Math.max(0, best);
}

/** The distance within which `attacker` may engage `target`: its reach plus 30% of the target's radius. */
export function engageRange(attacker: Fighter, target: Fighter): number {
  return strikeReach(attacker) + RULES.encounter.engageSlack * radiusOf(target.body);
}
