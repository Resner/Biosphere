// Outcomes in a fight: how a fighter's result is recorded, shared by the frame loop and combat.

import type { Encounter, Fighter, FighterResult, Outcome } from './types';

export function resultOf(
  f: Fighter,
  outcome: Outcome,
  by: number | null,
  frame: number,
): FighterResult {
  return {
    outcome,
    cause: f.body.cause,
    by,
    frame,
    biomass: f.body.biomass,
    egg: f.eggBody === null ? 'none' : f.eggBody.by >= 0 ? 'eaten' : 'kept',
    eggBy: f.eggBody !== null && f.eggBody.by >= 0 ? f.eggBody.by : null,
  };
}

/** Fixes a fighter's outcome at the current frame. */
export function finish(enc: Encounter, f: Fighter, outcome: Outcome, by: number | null): void {
  f.status = outcome;
  f.result = resultOf(f, outcome, by, enc.frame);
}

export const living = (enc: Encounter): Fighter[] => enc.fighters.filter((f) => f.status === 'in');
