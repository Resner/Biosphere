// What a player hatches as (M3 T15): a genome, built into a creature once. Genesis DNA comes from a
// browser-local random number, never from `sim` or `genome`, which stay deterministic.

import type { Genome } from '../genome/codec';
import { parseGenomeText } from '../genome/codec';
import { genesisGenome } from '../genome/genesis';
import { speciesName } from '../genome/names';
import { type RarityTier, rarityOfTraits } from '../genome/rarity';
import { sizeTier } from '../genome/size';
import { starterGenome } from '../genome/starter';
import { buildCreature, type Creature } from '../genome/stats';
import { seedFromString } from '../sim/prng';

/** A genome built into everything the game needs to play and draw it. */
export interface Body {
  genome: Genome;
  creature: Creature;
  hash: string;
  species: string;
  rarity: RarityTier;
  /** Size tier of the fully grown body (DESIGN §3). */
  tier: number;
}

export function hatchBody(genome: Genome): Body {
  const creature = buildCreature(genome);
  return {
    genome,
    creature,
    hash: creature.hash,
    species: speciesName(genome),
    rarity: rarityOfTraits(creature.traits).tier,
    tier: sizeTier(creature.stats.maxBiomass),
  };
}

export interface HatcherOptions {
  /** `?genome=`: a base64url genome, "starter", or null for a fresh genesis body each hatch. */
  pinned: string | null;
  /** A fresh number on every call; the only source of randomness. */
  random(): number;
  warn(message: string): void;
}

/** Chooses the body of each hatch. */
export class Hatcher {
  private readonly pinned: Genome | null;
  private starter: Body | null = null;

  constructor(private readonly options: HatcherOptions) {
    const { pinned, warn } = options;
    if (pinned === null) this.pinned = null;
    else if (pinned === 'starter') this.pinned = starterGenome();
    else {
      this.pinned = parseGenomeText(pinned);
      if (!this.pinned) warn('?genome= is not a genome; hatching a fresh one instead');
    }
  }

  /** The body for the next life. */
  next(): Body {
    const genome =
      this.pinned ?? genesisGenome(seedFromString(`hatch/${this.options.random().toString(36)}`));
    return hatchBody(genome);
  }

  /** The title screen's drifting cell: always the starter. */
  title(): Body {
    this.starter ??= hatchBody(starterGenome());
    return this.starter;
  }
}
