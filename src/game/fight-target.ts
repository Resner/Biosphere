// Targeting in a fight (M7 T15, DESIGN §3): Tab cycles the living opponents and the whole eggs,
// nearest first; a click on a fighter or an egg picks it; the input's target field carries the
// choice, and with none the nearest opponent is struck. It is offered whenever there is a choice to
// make: three or more fighters, or an egg. Pure: the fight is read, never changed.

import { aimAtEgg, EGG_CODE, hasEgg, targetEgg } from '../sim/encounter/egg';
import { aim, radiusOf, strikeDistance } from '../sim/encounter/reach';
import { pickTarget } from '../sim/encounter/strike';
import type { Encounter, Fighter } from '../sim/encounter/types';

/** Something the player can aim at: a fighter's body (its slot) or its egg (`EGG_CODE + slot`). */
export interface TargetOption {
  code: number;
  x: number;
  y: number;
  radius: number;
  /** From the own centre to its nearest edge, in wu. */
  distance: number;
}

const own = (enc: Encounter, slot: number): Fighter | null => {
  const f = enc.fighters[slot];
  return f && f.status === 'in' ? f : null;
};

/** Whether there is a choice to make: three or more fighters, or an egg in the fight. */
export const targetingOffered = (enc: Encounter): boolean =>
  enc.fighters.length >= 3 || enc.fighters.some((f) => f.eggBody !== null);

/** The living opponents and the whole eggs of fighters still in (never the own), nearest first; ties by code. */
export function targetOptions(enc: Encounter, slot: number): TargetOption[] {
  const me = own(enc, slot);
  if (!me) return [];
  const out: TargetOption[] = [];
  for (const f of enc.fighters) {
    if (f.slot === slot || f.status !== 'in') continue;
    out.push({
      code: f.slot,
      x: f.body.x,
      y: f.body.y,
      radius: radiusOf(f.body),
      distance: strikeDistance(me.body, f.body),
    });
    const egg = f.eggBody;
    if (egg && hasEgg(f)) {
      aimAtEgg(me, egg);
      out.push({
        code: EGG_CODE + f.slot,
        x: egg.x,
        y: egg.y,
        radius: egg.radius,
        distance: aim.distance,
      });
    }
  }
  return out.sort((a, b) => a.distance - b.distance || a.code - b.code);
}

/** Whether `code` still names a living opponent or a whole egg. */
export function validTarget(enc: Encounter, slot: number, code: number | null): boolean {
  const me = own(enc, slot);
  if (!me || code === null) return false;
  if (code >= EGG_CODE) return targetEgg(enc, me, code) !== null;
  return code !== slot && own(enc, code) !== null;
}

/** Tab: the option after `current` in nearest-first order, or the nearest when `current` names none. */
export function nextTarget(enc: Encounter, slot: number, current: number | null): number | null {
  const options = targetOptions(enc, slot);
  if (options.length === 0) return null;
  const at = options.findIndex((o) => o.code === current);
  return (options[(at + 1) % options.length] as TargetOption).code;
}

/**
 * A click at (x, y) in the world: the option whose circle (or `pick` wu round its centre, for a
 * small one) holds the point, the nearest centre first; null when it misses them all.
 */
export function targetAt(
  enc: Encounter,
  slot: number,
  x: number,
  y: number,
  pick: number,
): number | null {
  let best: number | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const o of targetOptions(enc, slot)) {
    const gap = Math.hypot(o.x - x, o.y - y);
    if (gap > Math.max(o.radius, pick) || gap >= bestGap) continue;
    bestGap = gap;
    best = o.code;
  }
  return best;
}

/** The target the input names: the chosen one while it is valid, else the own slot (the nearest is struck). */
export const inputTarget = (enc: Encounter, slot: number, chosen: number | null): number =>
  validTarget(enc, slot, chosen) ? (chosen as number) : slot;

/**
 * What the ring marks: the chosen target while it is valid, else the opponent the sim strikes by
 * default (the nearest). Null when targeting is not offered or nobody is left.
 */
export function markedTarget(
  enc: Encounter,
  slot: number,
  chosen: number | null,
): { code: number; chosen: boolean } | null {
  const me = own(enc, slot);
  if (!me || !targetingOffered(enc)) return null;
  if (validTarget(enc, slot, chosen)) return { code: chosen as number, chosen: true };
  const nearest = pickTarget(enc, me, null);
  return nearest ? { code: nearest.slot, chosen: false } : null;
}
