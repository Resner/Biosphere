// Eggs as prey (ADR 0052): a carried egg trails its carrier, has 25% of the carrier's maximum
// health and no armour, and any opponent may strike it. It is eaten when its health runs out or
// with its killed carrier; the eater gains a share of the carrier's biomass.

import { cos, length, lerp, sin } from '../math';
import { RULES } from '../rules';
import { maxHealth } from '../vitals';
import { aim, radiusOf } from './reach';
import type { EggBody, Encounter, Fighter } from './types';

const E = RULES.encounter;

/** A target code names an egg from this value up: `EGG_CODE + slot`. */
export const EGG_CODE = E.maxFighters;

/** Where the egg rests behind a still carrier, in wu from its centre. */
export const eggRest = (carrier: Fighter): number => {
  return radiusOf(carrier.body) * (1 + E.egg.gap + E.egg.radius);
};

/** Where the egg rests now: straight behind its carrier. */
function restPoint(f: Fighter): { x: number; y: number } {
  const b = f.body;
  const rest = eggRest(f);
  return { x: b.x - cos(b.heading) * rest, y: b.y - sin(b.heading) * rest };
}

/** The egg a fighter carries, at its resting place, with full health. */
export function seatEgg(f: Fighter): EggBody {
  const b = f.body;
  return {
    ...restPoint(f),
    radius: E.egg.radius * radiusOf(b),
    health: E.egg.healthShare * maxHealth(b.biomass),
    by: -1,
  };
}

/** Whether `f` carries an egg that nobody has eaten. */
export const hasEgg = (f: Fighter): boolean => f.eggBody !== null && f.eggBody.by < 0;

/** Moves the egg of a fighter still in the fight a quarter of the way to its resting place. */
export function followEgg(f: Fighter): void {
  const egg = f.eggBody;
  if (egg === null || !hasEgg(f) || f.status !== 'in') return;
  const goal = restPoint(f);
  egg.x = lerp(egg.x, goal.x, E.egg.follow);
  egg.y = lerp(egg.y, goal.y, E.egg.follow);
}

/**
 * Sets `aim` for an attacker and a carried egg: the distance from the attacker's centre to the
 * egg's edge (never negative), and the bearing to its centre as a cosine off the attacker's heading.
 */
export function aimAtEgg(attacker: Fighter, egg: EggBody): void {
  const a = attacker.body;
  const dx = egg.x - a.x;
  const dy = egg.y - a.y;
  const apart = length(dx, dy);
  aim.distance = Math.max(0, apart - egg.radius);
  aim.cos = apart > 0 ? (dx * cos(a.heading) + dy * sin(a.heading)) / apart : 1;
}

/** The egg a target code names, if it is a whole egg of a fighter still in the fight and not the attacker's. */
export function targetEgg(enc: Encounter, f: Fighter, code: number): Fighter | null {
  if (code < EGG_CODE || code >= EGG_CODE + E.maxFighters) return null;
  const carrier = enc.fighters[code - EGG_CODE];
  if (carrier === undefined || carrier === f || carrier.status !== 'in' || !hasEgg(carrier)) {
    return null;
  }
  return carrier;
}
