import { describe, expect, it, vi } from 'vitest';
import { genomeHash, genomeToBase64url } from '../genome/codec';
import { genesisGenome } from '../genome/genesis';
import { starterGenome } from '../genome/starter';
import { STARTER_PHYS } from '../sim/body';
import { seedFromString } from '../sim/prng';
import { Hatcher, hatchBody } from './body';

const counter = (): (() => string) => {
  let n = 0;
  return () => String(++n);
};

describe('hatchBody', () => {
  it('builds the creature, its names and the sim body from a genome', () => {
    const body = hatchBody(genesisGenome(seedFromString('a')));
    expect(body.hash).toBe(body.creature.hash);
    expect(body.species).toMatch(/^[A-Z][a-z]+ [a-z]+$/);
    expect(['common', 'uncommon', 'rare', 'exotic']).toContain(body.rarity);
    expect(body.tier).toBeGreaterThanOrEqual(0);
    expect(body.creature.phys.maxBiomass).toBeGreaterThanOrEqual(100);
  });

  it('gives the starter genome the M1 cell, within 1%', () => {
    const { phys } = hatchBody(starterGenome()).creature;
    for (const k of ['maxBiomass', 'thrust', 'drag', 'turn', 'basal', 'growth'] as const) {
      expect(phys[k] / STARTER_PHYS[k], k).toBeGreaterThan(0.99);
      expect(phys[k] / STARTER_PHYS[k], k).toBeLessThan(1.01);
    }
    expect(phys.mouth).toEqual(STARTER_PHYS.mouth);
  });
});

describe('Hatcher', () => {
  it('hatches a different genesis body each time (10 hatches)', () => {
    const hatcher = new Hatcher({ pinned: null, random: counter(), warn: () => {} });
    const hashes = new Set(Array.from({ length: 10 }, () => hatcher.next().hash));
    expect(hashes.size).toBe(10);
  });

  it('is a pure function of its random numbers', () => {
    const a = new Hatcher({ pinned: null, random: counter(), warn: () => {} });
    const b = new Hatcher({ pinned: null, random: counter(), warn: () => {} });
    expect(a.next().hash).toBe(b.next().hash);
  });

  it('pins the body with a genome, or with "starter"', () => {
    const genome = genesisGenome(seedFromString('pin'));
    const pinned = new Hatcher({
      pinned: genomeToBase64url(genome),
      random: counter(),
      warn: () => {},
    });
    expect(pinned.next().hash).toBe(genomeHash(genome));
    expect(pinned.next().hash).toBe(genomeHash(genome));
    const starter = new Hatcher({ pinned: 'starter', random: counter(), warn: () => {} });
    expect(starter.next().hash).toBe(genomeHash(starterGenome()));
  });

  it.each(['hello', 'not*base64', '', 'A'.repeat(5)])(
    'falls back to genesis for the invalid value %j and warns once',
    (pinned) => {
      const warn = vi.fn();
      const hatcher = new Hatcher({ pinned, random: counter(), warn });
      const first = hatcher.next();
      const second = hatcher.next();
      expect(first.hash).not.toBe(second.hash);
      expect(warn).toHaveBeenCalledTimes(1);
    },
  );

  it('stays silent without a pin', () => {
    const warn = vi.fn();
    new Hatcher({ pinned: null, random: counter(), warn }).next();
    expect(warn).not.toHaveBeenCalled();
  });

  it('shows the title the starter cell', () => {
    const hatcher = new Hatcher({ pinned: null, random: counter(), warn: () => {} });
    expect(hatcher.title().hash).toBe(genomeHash(starterGenome()));
  });
});
