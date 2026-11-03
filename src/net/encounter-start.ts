// An encounter's start from its `enc-start` message (ADR 0050): the referee and every client build
// the same `EncounterStart` from the same message, each fighter's body from its genome text.

import { genomeFromBase64url } from '../genome/codec';
import { fighterOf } from '../genome/fighter';
import { buildCreature } from '../genome/stats';
import { seedWords } from '../ledger/encounter';
import type { EncounterStart } from '../sim/encounter/types';
import { RULES } from '../sim/rules';
import type { HubMsg } from './protocol-defs';

export type EncStart = Extract<HubMsg, { t: 'enc-start' }>;

/** The encounter's start in the pond seeded `pondSeed`, or null when a genome does not decode. */
export function encounterStartOf(msg: EncStart, pondSeed: string): EncounterStart | null {
  const fighters: EncounterStart['fighters'] = [];
  for (const { genome: text, ...f } of msg.fighters) {
    const genome = genomeFromBase64url(text);
    if (!genome) return null;
    fighters.push({ ...f, ...fighterOf(buildCreature(genome)) });
  }
  return {
    id: msg.enc,
    pondSeed,
    size: RULES.world.size,
    seed: seedWords(msg.seed),
    t0: msg.t0,
    fighters,
  };
}
