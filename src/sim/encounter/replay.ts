// Encounter logs (ADR 0050): the start, every frame's inputs and the joins reproduce a fight bit
// for bit.

import { RULES_VERSION } from '../rules';
import { createEncounter, hashEncounter, results, stepFrame } from './encounter';
import { applyJoins } from './join';
import type { EncounterJoin, EncounterStart, FighterResult } from './types';

export interface EncounterLog {
  rules: number;
  start: EncounterStart;
  /** `frames[f][slot]` is the u32 input code, or null for the fallback marker. */
  frames: (number | null)[][];
  /** Fighters that joined later, each before its frame is stepped (M7 T15). */
  joins?: EncounterJoin[];
}

export function replayEncounter(log: EncounterLog): { hash: string; results: FighterResult[] } {
  if (log.rules !== RULES_VERSION)
    throw new Error(`log is for rules v${log.rules}, this build runs v${RULES_VERSION}`);
  const enc = createEncounter(log.start);
  for (const frame of log.frames) {
    applyJoins(enc, log.joins);
    stepFrame(enc, frame);
  }
  applyJoins(enc, log.joins);
  return { hash: hashEncounter(enc), results: results(enc) };
}
