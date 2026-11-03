import { describe, expect, it } from 'vitest';
import { genomeFromBase64url, genomeToBase64url } from '../genome/codec';
import { fighterOf } from '../genome/fighter';
import { genesisGenome } from '../genome/genesis';
import { buildCreature } from '../genome/stats';
import { seedWords } from '../ledger/encounter';
import { createEncounter } from '../sim/encounter/encounter';
import { RULES } from '../sim/rules';
import { type EncStart, encounterStartOf } from './encounter-start';
import type { FighterInfo } from './protocol-defs';

// The referee and every client build the same encounter from the same `enc-start` (M7 T9).

const genome = genomeToBase64url(genesisGenome([7, 8, 9, 10]));

const fighter = (creature: string, x: number): FighterInfo => ({
  player: 'p'.repeat(43),
  creature,
  genome,
  x,
  y: 3000,
  vx: 1,
  vy: -1,
  heading: 0.5,
  biomass: 120,
  energy: 90,
  health: 80,
  elder: false,
  egg: true,
});

const msg: EncStart = {
  t: 'enc-start',
  enc: 'a'.repeat(64),
  seed: '0123456789abcdef'.repeat(4),
  round: 42,
  t0: 3600,
  at: 1_700_000_000_000,
  fighters: [fighter('b'.repeat(64), 5220), fighter('c'.repeat(64), 5200)],
};

describe('encounterStartOf', () => {
  it('builds each fighter from its genome, with the message’s seed, start tick and states', () => {
    const start = encounterStartOf(msg, 'pond-seed');
    const decoded = genomeFromBase64url(genome);
    if (!start || !decoded) throw new Error('no start');
    expect(start).toMatchObject({ id: msg.enc, pondSeed: 'pond-seed', t0: 3600 });
    expect(start.size).toBe(RULES.world.size);
    expect(start.seed).toEqual(seedWords(msg.seed));
    const body = fighterOf(buildCreature(decoded));
    const { genome: _text, ...state } = fighter('b'.repeat(64), 5220);
    expect(start.fighters[0]).toEqual({ ...state, ...body });
    // Two builds of one message step alike.
    expect(createEncounter(start)).toEqual(
      createEncounter(encounterStartOf(msg, 'pond-seed') ?? start),
    );
  });

  it('is null when a genome does not decode', () => {
    const bad = {
      ...msg,
      fighters: [{ ...fighter('b'.repeat(64), 1), genome: '!' }, fighter('c'.repeat(64), 2)],
    };
    expect(encounterStartOf(bad, 'pond-seed')).toBeNull();
  });
});
