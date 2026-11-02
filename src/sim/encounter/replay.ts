// Encounter logs (ADR 0050): the start and every frame's inputs reproduce a fight bit for bit.

import { RULES_VERSION } from '../rules';
import { createEncounter, hashEncounter, results, stepFrame } from './encounter';
import type { EncounterStart, FighterResult } from './types';

export interface EncounterLog {
  rules: number;
  start: EncounterStart;
  /** `frames[f][slot]` is the u32 input code, or null for the fallback marker. */
  frames: (number | null)[][];
}

export function replayEncounter(log: EncounterLog): { hash: string; results: FighterResult[] } {
  if (log.rules !== RULES_VERSION)
    throw new Error(`log is for rules v${log.rules}, this build runs v${RULES_VERSION}`);
  const enc = createEncounter(log.start);
  for (const frame of log.frames) stepFrame(enc, frame);
  return { hash: hashEncounter(enc), results: results(enc) };
}
