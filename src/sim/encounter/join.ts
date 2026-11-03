// Joins (M7 T15): a third or fourth fighter enters a running fight at a frame boundary. It takes the
// next slot (the first fighters took theirs in creature-id order), so every slot already in use
// keeps its number, and the referee's bundles carry one more input from that frame on.

import { RULES } from '../rules';
import { checkFighter, seatFighter } from './encounter';
import type { Encounter, EncounterJoin, FighterStart } from './types';

const E = RULES.encounter;

/**
 * Seats `start` in the next slot before frame `f` is stepped (`enc.frame` must be `f`), born at the
 * current pond tick. A fight that is already over takes nobody: -1. Throws a `RangeError` for a
 * join at another frame, into a full fight, of a creature already in it, or of a bad body.
 */
export function joinFighter(enc: Encounter, start: FighterStart, f: number): number {
  if (enc.over) return -1;
  if (!Number.isInteger(f) || f !== enc.frame) {
    throw new RangeError(`a join for frame ${f} at frame ${enc.frame}`);
  }
  if (enc.fighters.length >= E.maxFighters) throw new RangeError('the fight is full');
  if (enc.fighters.some((x) => x.creature === start.creature)) {
    throw new RangeError(`creature ${start.creature} fights twice`);
  }
  checkFighter(start);
  const slot = enc.fighters.length;
  enc.fighters.push(seatFighter(slot, start, enc.world.tick));
  return slot;
}

/** Seats every join due before frame `enc.frame`, in the order given. */
export function applyJoins(enc: Encounter, joins: readonly EncounterJoin[] | undefined): void {
  if (!joins) return;
  for (const j of joins) if (j.f === enc.frame) joinFighter(enc, j.fighter, j.f);
}
