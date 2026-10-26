// What a player hatches as (M3 T15): a genome, built into a creature once. Genesis DNA comes from a
// browser-local random number, never from `sim` or `genome`, which stay deterministic.

import { type Genome, parseGenomeText } from '../genome/codec';
import { genesisGenome } from '../genome/genesis';
import { speciesName } from '../genome/names';
import { type RarityTier, rarityOfTraits } from '../genome/rarity';
import { sizeTier } from '../genome/size';
import { starterGenome } from '../genome/starter';
import { buildCreature, type Creature } from '../genome/stats';
import { seedFromString } from '../sim/prng';

/** A genome built into everything the game needs to play and draw it. */
export interface Body {
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
    creature,
    hash: creature.hash,
    species: speciesName(genome),
    rarity: rarityOfTraits(creature.traits).tier,
    tier: sizeTier(creature.stats.maxBiomass),
  };
}

/** The one-line name shown on the HUD and the death screen. */
export const bodyLabel = (body: Pick<Body, 'species' | 'rarity'>): string =>
  `${body.species} · ${body.rarity}`;

export interface HatcherOptions {
  /** `?genome=`: a base64url genome, "starter", or null for a fresh genesis body each hatch. */
  pinned: string | null;
  /** Fresh text on every call; the only source of randomness. */
  random(): string;
  warn(message: string): void;
}

/** Chooses the body of each hatch; bodies are built on first use and then reused. */
export class Hatcher {
  private starterBody: Body | null = null;
  private pinnedBody: Body | null = null;
  /** `?genome=` when it names a genome (not "starter"). */
  private readonly pinnedGenome: Genome | null = null;
  private readonly pinStarter: boolean;

  constructor(private readonly options: HatcherOptions) {
    const { pinned, warn } = options;
    this.pinStarter = pinned === 'starter';
    if (pinned !== null && !this.pinStarter) {
      this.pinnedGenome = parseGenomeText(pinned);
      if (!this.pinnedGenome) warn('?genome= is not a genome; hatching a fresh one instead');
    }
  }

  /** The body for the next life. */
  next(): Body {
    if (this.pinStarter) return this.title();
    if (this.pinnedGenome) return (this.pinnedBody ??= hatchBody(this.pinnedGenome));
    return hatchBody(genesisGenome(seedFromString(`hatch/${this.options.random()}`)));
  }

  /** The title screen's drifting cell: always the starter. */
  title(): Body {
    return (this.starterBody ??= hatchBody(starterGenome()));
  }
}
