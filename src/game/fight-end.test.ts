import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { genomeToBase64url } from '../genome/codec';
import { genesisGenome } from '../genome/genesis';
import type { Born, FighterOutcome, HubMsg } from '../net/protocol';
import { seedFromString } from '../sim/prng';
import { EGG_EATEN, fightEnded } from './fight-end';
import { OffspringFlow } from './offspring';

// M7 T13: what a fight's end means for the player beyond the fight: an egg eaten in it goes, with
// the pending child it was (ADR 0052).

const ME = 'me-player';
const born = {
  record: { hash: 'c'.repeat(64), record: { body: { generation: 1 } } },
  genome: genomeToBase64url(genesisGenome(seedFromString('egg'))),
} as unknown as Born;

function fighter(player: string, over: Partial<FighterOutcome> = {}): FighterOutcome {
  return {
    player,
    creature: player.padEnd(64, '0'),
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    heading: 0,
    biomass: 3,
    energy: 2,
    health: 1,
    outcome: 'stood',
    cause: null,
    by: null,
    egg: 'none',
    eggBy: null,
    ...over,
  };
}

const end = (fighters: FighterOutcome[]): Extract<HubMsg, { t: 'enc-end' }> => ({
  t: 'enc-end',
  enc: 'e'.repeat(64),
  f: 40,
  hash: '0123456789abcdef',
  fighters,
});

let offspring: OffspringFlow;
let toasts: string[];
let lost: number;
const deps = () => ({
  playerId: ME,
  toast: (text: string) => toasts.push(text),
  loseEgg: () => {
    lost++;
    offspring.eaten();
  },
});

beforeEach(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  offspring = new OffspringFlow({ now: () => 0, verify: async () => [] });
  offspring.receive({ t: 'born', ...born });
  await new Promise((r) => setTimeout(r, 0));
  toasts = [];
  lost = 0;
});
afterEach(() => vi.restoreAllMocks());

describe('fightEnded', () => {
  it('tells a living carrier its egg was eaten, and it no longer carries it', () => {
    expect(offspring.child()).not.toBeNull();
    fightEnded(
      end([
        fighter('them', { outcome: 'stood' }),
        fighter(ME, { outcome: 'escaped', egg: 'eaten', eggBy: 0 }),
      ]),
      deps(),
    );
    expect(toasts).toEqual([EGG_EATEN]);
    expect(EGG_EATEN).toBe('Your egg was eaten');
    expect(lost).toBe(1);
    expect(offspring.child()).toBeNull();
    expect(offspring.view().kind).toBe('none');
  });

  it('leaves a kept egg, someone else’s eaten egg and a fight without eggs alone', () => {
    for (const fighters of [
      [fighter('them'), fighter(ME, { egg: 'kept' })],
      [fighter('them', { egg: 'eaten', eggBy: 1 }), fighter(ME)],
      [fighter('them'), fighter(ME)],
    ]) {
      fightEnded(end(fighters), deps());
    }
    expect(toasts).toEqual([]);
    expect(lost).toBe(0);
    expect(offspring.child()).not.toBeNull();
  });
});
