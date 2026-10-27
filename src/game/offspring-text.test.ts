import { describe, expect, it } from 'vitest';
import { genomeToBase64url } from '../genome/codec';
import { genesisGenome } from '../genome/genesis';
import { speciesName } from '../genome/names';
import { seedFromString } from '../sim/prng';
import { hatchBody } from './body';
import type { Child } from './offspring';
import { VERIFY_BORN_FAILED } from './offspring';
import { childLine, fallbackOptions, lifeLeftText } from './offspring-text';

const genome = genesisGenome(seedFromString('x'));
const body = hatchBody(genome);
const child = { born: {}, body, generation: 3 } as unknown as Child;
const ancestor = {
  creature: 'a'.repeat(64),
  genome: genomeToBase64url(genome),
  activeMs: 600_000,
  lifespanMs: 1_000_000,
} as never;

const BANNED = /commit|ledger|checkpoint|nonce|beacon|record|allele|genotype|hash/i;

describe('fallback options', () => {
  it('lists the offspring first, then the ancestor, in plain words', () => {
    const options = fallbackOptions({ pending: true, ancestor }, child, () => 2);
    expect(options.map((o) => o.id)).toEqual(['child', 'ancestor']);
    expect(options[0]?.label).toBe(`Become ${body.species} (your offspring)`);
    expect(options[1]?.label).toBe(
      `Return to ${speciesName(genome)}, generation 2 (about 7 min of life left)`,
    );
    for (const o of options) expect(o.label).not.toMatch(BANNED);
  });

  it('leaves out what is missing and offers nothing when nothing survives', () => {
    expect(fallbackOptions({ pending: true, ancestor: null }, null, () => 0)).toEqual([]);
    expect(fallbackOptions(null, child, () => 0)).toEqual([]);
    const only = fallbackOptions({ pending: false, ancestor }, child, () => undefined);
    expect(only).toHaveLength(1);
    expect(only[0]?.label).not.toContain('generation');
  });

  it('rounds the life left up to a whole minute, at least one', () => {
    expect(lifeLeftText({ activeMs: 0, lifespanMs: 61_000 })).toBe('about 2 min of life left');
    expect(lifeLeftText({ activeMs: 5, lifespanMs: 5 })).toBe('about 1 min of life left');
  });
});

describe('words', () => {
  it('names the rarity and generation, and keeps jargon out', () => {
    expect(childLine(child)).toBe(`${body.rarity} · generation 3`);
    expect(VERIFY_BORN_FAILED).not.toMatch(BANNED);
  });
});
