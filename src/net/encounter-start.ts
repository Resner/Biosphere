// An encounter's start from its `enc-start` message (ADR 0050): the referee and every client build
// the same `EncounterStart` from the same message, each fighter's body from its genome text.

import { genomeFromBase64url } from '../genome/codec';
import { fighterOf } from '../genome/fighter';
import { buildCreature, type Creature } from '../genome/stats';
import { seedWords } from '../ledger/encounter';
import type { EncounterStart, FighterStart } from '../sim/encounter/types';
import { RULES } from '../sim/rules';
import type { FighterInfo, HubMsg } from './protocol-defs';

export type EncStart = Extract<HubMsg, { t: 'enc-start' }>;
export type EncJoin = Extract<HubMsg, { t: 'enc-join' }>;

/** Builds a creature from genome text; null for text that is no genome or breaks the builder. */
export function bodyFromText(text: string): Creature | null {
  const genome = genomeFromBase64url(text);
  if (!genome) return null;
  try {
    return buildCreature(genome);
  } catch {
    return null;
  }
}

/**
 * The encounter's start in the pond seeded `pondSeed`, or null when a genome does not build.
 * `bodies` lets a client reuse a creature it has already built.
 */
export function encounterStartOf(
  msg: EncStart,
  pondSeed: string,
  bodies: (genome: string) => Creature | null = bodyFromText,
): EncounterStart | null {
  const fighters: EncounterStart['fighters'] = [];
  for (const info of msg.fighters) {
    const f = fighterStartOf(info, bodies);
    if (!f) return null;
    fighters.push(f);
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

/** One fighter's start from its `FighterInfo` (an `enc-start`'s or an `enc-join`'s); null when its genome does not build. */
export function fighterStartOf(
  info: FighterInfo,
  bodies: (genome: string) => Creature | null = bodyFromText,
): FighterStart | null {
  const { genome: text, ...f } = info;
  const creature = bodies(text);
  return creature ? { ...f, ...fighterOf(creature) } : null;
}
