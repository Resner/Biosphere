// Plain words for the offspring card and the choice after a death (M5 T11). The player sees
// creatures and families, never records: no "commit", "ledger", "checkpoint" or "nonce" here.

import { parseGenomeText } from '../genome/codec';
import { speciesName } from '../genome/names';
import type { Ancestor, FallbackInfo } from '../net/protocol';
import type { Child } from './offspring';

const MINUTE = 60_000;

export type FallbackId = 'child' | 'ancestor';

export interface FallbackOption {
  id: FallbackId;
  label: string;
}

/** The species name for a genome text, or a plain stand-in when it cannot be read. */
export function speciesOf(text: string): string {
  const genome = parseGenomeText(text);
  return genome ? speciesName(genome) : 'an earlier creature';
}

/** "about 12 min of life left", rounded up to whole minutes, never below 1. */
export const lifeLeftText = (ancestor: Pick<Ancestor, 'activeMs' | 'lifespanMs'>): string => {
  const minutes = Math.max(1, Math.ceil((ancestor.lifespanMs - ancestor.activeMs) / MINUTE));
  return `about ${minutes} min of life left`;
};

/** What the player may become when nothing swims: the pending child first, then the nearest ancestor. */
export function fallbackOptions(
  fallback: FallbackInfo | null,
  child: Child | null,
  generationOf: (creature: string) => number | undefined,
): FallbackOption[] {
  const options: FallbackOption[] = [];
  if (fallback?.pending && child) {
    options.push({ id: 'child', label: `Become ${child.body.species} (your offspring)` });
  }
  const ancestor = fallback?.ancestor;
  if (ancestor) {
    const generation = generationOf(ancestor.creature);
    const name = speciesOf(ancestor.genome);
    const where = generation === undefined ? name : `${name}, generation ${generation}`;
    options.push({ id: 'ancestor', label: `Return to ${where} (${lifeLeftText(ancestor)})` });
  }
  return options;
}

/** The offspring card's second line: how rare it is and how many parents back it goes. */
export const childLine = (child: Child): string =>
  `${child.body.rarity} · generation ${child.generation}`;
