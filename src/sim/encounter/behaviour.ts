// The combat autopilot's genes as the simulation trusts them: whatever a start record carries is
// forced into range here, like `sanitizePhys` does for the body.

import type { Behaviour, TargetPref } from './types';

export const TARGET_PREFS: readonly TargetPref[] = ['nearest', 'weakest', 'largest', 'strongest'];

const unit = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5);

/** A copy with each trait in 0-1 (non-finite takes 0.5) and an unknown preference taken as `nearest`. */
export function sanitizeBehaviour(
  b: Omit<Behaviour, 'targetPref'> & { targetPref: string },
): Behaviour {
  return {
    aggression: unit(b.aggression),
    caution: unit(b.caution),
    curiosity: unit(b.curiosity),
    reflex: unit(b.reflex),
    targetPref: TARGET_PREFS.find((p) => p === b.targetPref) ?? 'nearest',
  };
}
