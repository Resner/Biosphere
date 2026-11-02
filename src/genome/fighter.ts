// The combat view of a creature (ADR 0051): what the encounter simulation reads from a body and its
// behaviour genes. Deterministic and shared with the Worker.

import { sanitizeCombat, sanitizePhys } from '../sim/body';
import { sanitizeBehaviour } from '../sim/encounter/behaviour';
import type { FighterStart } from '../sim/encounter/types';
import type { Creature } from './stats';

export function fighterOf(c: Creature): Pick<FighterStart, 'phys' | 'combat' | 'behaviour'> {
  return {
    phys: sanitizePhys(c.phys),
    combat: sanitizeCombat({ ...c.stats.combat, mass: c.stats.mass }),
    behaviour: sanitizeBehaviour(c.traits.behaviour),
  };
}
