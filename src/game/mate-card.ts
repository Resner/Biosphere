// The inspect card (M5 T12): what a player sees when they click another creature. A view model with
// no DOM: it reads the peer's drawn body, the player's own genome and one `mate-info` answer.

import { parseGenomeText } from '../genome/codec';
import { describeCreature } from '../genome/describe';
import { type MateHints, mateHints } from '../genome/hints';
import { type RarityTier, rarityOfTraits } from '../genome/rarity';
import type { Creature } from '../genome/stats';
import type { LifeMsg } from '../net/hub-client';
import { sizeTier } from '../sim/size';
import { bandWords, refusalText } from './mate-text';

type Info = Extract<LifeMsg, { t: 'mate-info' }>;

/** What the shell knows of the creature being looked at. */
export interface InspectInput {
  name: string;
  radius: number;
  species: string | null;
  /** The drawn body, or null while the creature is still a tinted cell. */
  body: Creature | null;
  /** The peer's genome text, for the hints. */
  genomeText: string | null;
  /** The player's own genome text, or null when they have no creature. */
  ownGenomeText: string | null;
  info: Info | null;
}

export interface InspectCard {
  name: string;
  /** False while the body has not arrived: only the name and a note show. */
  arrived: boolean;
  species: string;
  rarity: RarityTier | '';
  size: string;
  traits: string[];
  generation: number | null;
  kinship: string;
  /** Whether you can mate now, with the reason if not; empty before the check answers. */
  verdict: string;
  canMate: boolean;
  hints: MateHints | null;
}

const ARRIVING = 'Still arriving';
/** Which of `describeCreature`'s six sentences the card keeps: body, feeding and looks. */
const TRAIT_LINES = [0, 2, 4];

export function inspectCard(input: InspectInput): InspectCard {
  const { name, info, body } = input;
  const base = {
    name,
    size: `Size ${sizeTier(input.radius * input.radius)}`,
    generation: info ? info.generation : null,
    kinship: info ? bandWords(info.kinship) : '',
    verdict: !info
      ? ''
      : info.reason === null
        ? 'You can mate now'
        : refusalText(info.reason, info.cooldownLeftMs, name),
    canMate: info !== null && info.reason === null,
  };
  if (!body) {
    return {
      ...base,
      arrived: false,
      species: input.species ?? ARRIVING,
      rarity: '',
      traits: [ARRIVING],
      hints: null,
    };
  }
  const theirs = input.genomeText === null ? null : parseGenomeText(input.genomeText);
  const own = input.ownGenomeText === null ? null : parseGenomeText(input.ownGenomeText);
  return {
    ...base,
    arrived: true,
    species: input.species ?? 'A new creature',
    rarity: rarityOfTraits(body.traits).tier,
    traits: TRAIT_LINES.flatMap((i) => describeCreature(body)[i] ?? []),
    hints: own && theirs ? mateHints(own, theirs) : null,
  };
}
