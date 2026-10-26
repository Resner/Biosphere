import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ARCHETYPES } from '../../tests/archetypes';
import { isProfane } from '../net/text';
import { type Seed, seedFromString } from '../sim/prng';
import { RULES_VERSION } from '../sim/rules';
import { decodeGenome, encodeGenome, type Genome } from './codec';
import { describeCreature } from './describe';
import { express } from './express';
import { genesisGenome } from './genesis';
import { HAPLOTYPE_BYTES, LOCI } from './karyotype';
import { EPITHETS, GENUS_SUFFIXES, SYLLABLES, speciesName } from './names';
import { rarityOf } from './rarity';
import { starterGenome } from './starter';
import { buildCreature } from './stats';

const seedOf = (i: number): Seed => seedFromString(`names-test-${i}`);
const genomes = Array.from({ length: 10_000 }, (_, i) => genesisGenome(seedOf(i)));

const locus = (id: string) => LOCI.find((l) => l.id === id) as (typeof LOCI)[number];
function withLoci(base: Genome, set: Record<string, number>): Genome {
  const bytes = encodeGenome(base);
  for (const [id, v] of Object.entries(set)) {
    bytes[locus(id).offset] = v;
    bytes[HAPLOTYPE_BYTES + locus(id).offset] = v;
  }
  return decodeGenome(bytes);
}

describe('speciesName', () => {
  const names = genomes.map(speciesName);

  it('is deterministic: identical genomes get identical names', () => {
    for (let i = 0; i < 200; i++) {
      const g = genomes[i] as Genome;
      expect(speciesName(decodeGenome(encodeGenome(g)))).toBe(names[i]);
    }
  });

  it('is ASCII, a capitalised genus and a lowercase epithet, at most 28 characters', () => {
    for (const name of names) {
      expect(name).toMatch(/^[A-Z][a-z]+ [a-z]+$/);
      expect(name.length).toBeLessThanOrEqual(28);
    }
  });

  it('rarely collides: under 1% of 10,000 genesis names match another genome', () => {
    const seen = new Map<string, number>();
    for (const n of names) seen.set(n, (seen.get(n) ?? 0) + 1);
    const colliding = names.filter((n) => (seen.get(n) as number) > 1).length;
    expect(colliding / names.length).toBeLessThan(0.01);
  });

  it('never contains a word the chat filter blocks', () => {
    for (const n of names) expect(isProfane(n), n).toBe(false);
    for (const n of names) expect(isProfane(n.replace(' ', '')), n).toBe(false);
  });

  it('keeps every possible genus and epithet clear of the filter', () => {
    for (const e of EPITHETS) expect(isProfane(e), e).toBe(false);
    for (const s of GENUS_SUFFIXES) expect(isProfane(s), s).toBe(false);
    // Every three-syllable stem, then every join of the last syllable with a suffix.
    for (const a of SYLLABLES) {
      for (const b of SYLLABLES) {
        for (const c of SYLLABLES) expect(isProfane(a + b + c), a + b + c).toBe(false);
      }
    }
    for (const a of SYLLABLES) {
      for (const b of SYLLABLES) {
        for (const s of GENUS_SUFFIXES) expect(isProfane(a + b + s), a + b + s).toBe(false);
      }
    }
  });

  it('picks the epithet from the dominant trait', () => {
    const epithet = (g: Genome): string => speciesName(g).split(' ')[1] as string;
    expect(epithet(ARCHETYPES.filter as Genome)).toBe('filtrans');
    expect(epithet(ARCHETYPES.hunter as Genome)).toBe('ferox');
    expect(epithet(ARCHETYPES.armoured as Genome)).toBe('armatus');
    expect(epithet(ARCHETYPES.flagellate as Genome)).toBe('natans');
    expect(EPITHETS.length).toBeGreaterThanOrEqual(8);
  });

  it('does not change with the haplotype order', () => {
    const g = genomes[3] as Genome;
    const swapped = decodeGenome(
      Uint8Array.from([
        ...encodeGenome(g).slice(HAPLOTYPE_BYTES),
        ...encodeGenome(g).slice(0, HAPLOTYPE_BYTES),
      ]),
    );
    // The hash covers the order, so only the epithet (a trait) must agree.
    expect(speciesName(swapped).split(' ')[1]).toBe(speciesName(g).split(' ')[1]);
  });
});

const BANNED = /allele|locus|quant|haplotype|gene/i;

describe('describeCreature', () => {
  const creatures: Record<string, Genome> = {
    starter: starterGenome(),
    armoured: ARCHETYPES.armoured as Genome,
    hunter: ARCHETYPES.hunter as Genome,
    filter: ARCHETYPES.filter as Genome,
    exotic: withLoci(starterGenome(), { iridescence: 1, albino: 1, pattern: 3, luminescence: 1 }),
  };

  it('is plain words: no genetics jargon and no number with more than 2 decimals', () => {
    const all = [
      ...Object.values(creatures),
      ...genomes.slice(0, 1500),
      ...Array.from({ length: 300 }, (_, i) => decodeGenome(randomBytes(i))),
    ];
    for (const g of all) {
      for (const sentence of describeCreature(buildCreature(g))) {
        expect(sentence, sentence).not.toMatch(BANNED);
        expect(sentence, sentence).not.toMatch(/\d+\.\d{3,}/);
        expect(sentence, sentence).not.toMatch(/NaN|undefined|Infinity/);
        expect(sentence.length).toBeGreaterThan(10);
        expect(sentence).toMatch(/\.$/);
      }
    }
  });

  it('covers body, movement, feeding, defence, looks and rarity, in that order', () => {
    const lines = describeCreature(buildCreature(creatures.hunter as Genome));
    expect(lines).toHaveLength(6);
    expect(lines[5]).toMatch(/^Rarity: /);
    expect(lines[2]).toMatch(/jaw|feed|eat|bite/i);
  });

  it('names the rarity tier and the features behind it', () => {
    const lines = describeCreature(buildCreature(creatures.exotic as Genome));
    const rarity = rarityOf(creatures.exotic as Genome);
    expect(lines[5]).toContain(rarity.tier);
    expect(lines[5]).toMatch(/iridescent/i);
    expect(lines[5]).toMatch(/albino/i);
  });

  it('describes the same body the same way', () => {
    const c = buildCreature(creatures.armoured as Genome);
    expect(describeCreature(c)).toEqual(
      describeCreature(buildCreature(creatures.armoured as Genome)),
    );
    expect(describeCreature(c).join(' ')).toMatch(/plat|armou?r/i);
    expect(express(creatures.armoured as Genome).skin.plating).toBeGreaterThan(0.9);
  });

  it('matches the golden sentences for three creatures', () => {
    const actual = Object.fromEntries(
      ['starter', 'armoured', 'hunter'].map((k) => [
        k,
        describeCreature(buildCreature(creatures[k] as Genome)),
      ]),
    );
    const file = new URL('./__golden__/describe.json', import.meta.url);
    if (process.env.UPDATE_GOLDENS === '1') {
      writeFileSync(
        file,
        `${JSON.stringify({ rulesVersion: RULES_VERSION, sentences: actual }, null, 2)}\n`,
      );
    }
    const golden = JSON.parse(readFileSync(file, 'utf8')) as {
      rulesVersion: number;
      sentences: unknown;
    };
    expect(golden.rulesVersion).toBe(RULES_VERSION);
    expect(actual).toEqual(golden.sentences);
  });
});

function randomBytes(i: number): Uint8Array {
  const bytes = new Uint8Array(2 * HAPLOTYPE_BYTES);
  let s = (i + 1) * 2654435761;
  for (let k = 0; k < bytes.length; k++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    bytes[k] = s >>> 24;
  }
  return bytes;
}
