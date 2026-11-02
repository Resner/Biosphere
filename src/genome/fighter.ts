// The combat view of a creature (ADR 0051): what the encounter simulation reads from a body and its
// behaviour genes. Deterministic and shared with the Worker.

import { type CombatStats, type PhysStats, sanitizeCombat, sanitizePhys } from '../sim/body';
import type { Behaviour, TargetPref } from '../sim/encounter/types';
import type { Creature } from './stats';

const PREFS: readonly TargetPref[] = ['nearest', 'weakest', 'largest', 'strongest'];

const unit = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5);

export function fighterOf(c: Creature): {
  phys: PhysStats;
  combat: CombatStats;
  behaviour: Behaviour;
} {
  const b = c.traits.behaviour;
  const pref = PREFS.find((p) => p === b.targetPref) ?? 'nearest';
  return {
    phys: sanitizePhys(c.phys),
    combat: sanitizeCombat({ ...c.stats.combat, mass: c.stats.mass }),
    behaviour: {
      aggression: unit(b.aggression),
      caution: unit(b.caution),
      curiosity: unit(b.curiosity),
      reflex: unit(b.reflex),
      targetPref: pref,
    },
  };
}
