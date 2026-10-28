import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ARCHETYPES, withAlleles } from '../../tests/archetypes';
import { isProfane } from '../net/text';
import { type Seed, seedFromString } from '../sim/prng';
import { RULES_VERSION } from '../sim/rules';
import { decodeGenome, encodeGenome, type Genome } from './codec';
import { describeCreature } from './describe';
import { express } from './express';
import { genesisGenome } from './genesis';
import { HAPLOTYPE_BYTES, MODULE_EXT, MODULE_LOCI } from './karyotype';
import { HAPLOTYPE_BYTES_V1 } from './karyotype-v1';
import { EPITHETS, GENUS_SUFFIXES, SYLLABLES, speciesName } from './names';
import { rarityOf } from './rarity';
import { starterGenome } from './starter';
import { buildCreature } from './stats';

const seedOf = (i: number): Seed => seedFromString(`names-test-${i}`);
const genomes = Array.from({ length: 10_000 }, (_, i) => genesisGenome(seedOf(i)));

const withLoci = (base: Genome, set: Record<string, number>): Genome =>
  withAlleles(base, Object.fromEntries(Object.entries(set).map(([id, v]) => [id, [v, v]])));

describe('speciesName', () => {
  const names = genomes.map(speciesName);

  it('is deterministic: identical genomes get identical names', () => {
    for (let i = 0; i < 200; i++) {
      const g = genomes[i] as Genome;
      expect(speciesName(decodeGenome(encodeGenome(g)))).toBe(names[i]);
    }
  });

  it('is ASCII, a capitalised genus and a lowercase epithet, at most 28 characters', () => {
    const bad = names.filter((n) => !/^[A-Z][a-z]+ [a-z]+$/.test(n) || n.length > 28);
    expect(bad).toEqual([]);
  });

  it('rarely collides: under 1% of 10,000 genesis names match another genome', () => {
    const seen = new Map<string, number>();
    for (const n of names) seen.set(n, (seen.get(n) ?? 0) + 1);
    const colliding = names.filter((n) => (seen.get(n) as number) > 1).length;
    expect(colliding / names.length).toBeLessThan(0.01);
  });

  it('never contains a word the chat filter blocks', () => {
    const bad = names.filter((n) => isProfane(n) || isProfane(n.replace(' ', '')));
    expect(bad).toEqual([]);
  });

  it('keeps every possible genus and epithet clear of the filter', () => {
    const bad: string[] = [];
    const check = (word: string): void => {
      if (isProfane(word)) bad.push(word);
    };
    for (const e of EPITHETS) check(e);
    for (const s of GENUS_SUFFIXES) check(s);
    // Every three-syllable stem, then every pair of syllables with each suffix.
    for (const a of SYLLABLES) {
      for (const b of SYLLABLES) {
        for (const c of SYLLABLES) check(a + b + c);
        for (const s of GENUS_SUFFIXES) check(a + b + s);
      }
    }
    expect(bad).toEqual([]);
  });

  it('picks the epithet from the dominant trait', () => {
    const epithet = (g: Genome): string => speciesName(g).split(' ')[1] as string;
    expect(epithet(ARCHETYPES.filter as Genome)).toBe('filtrans');
    expect(epithet(ARCHETYPES.hunter as Genome)).toBe('ferox');
    expect(epithet(ARCHETYPES.armoured as Genome)).toBe('armatus');
    expect(epithet(ARCHETYPES.flagellate as Genome)).toBe('natans');
    expect(EPITHETS.length).toBeGreaterThanOrEqual(8);
  });

  it('names the new traits: alata, spiralis, radiatus, oculatus and setosus', () => {
    const epithet = (g: Genome): string => speciesName(g).split(' ')[1] as string;
    const slot = MODULE_LOCI[0] as (typeof MODULE_LOCI)[number];
    const ext = (name: (typeof MODULE_EXT)[number], v: number): Genome => {
      const bytes = encodeGenome(starterGenome());
      for (let hap = 0; hap < 2; hap++)
        bytes[hap * HAPLOTYPE_BYTES + slot.ext + MODULE_EXT.indexOf(name)] = v;
      return decodeGenome(bytes);
    };
    const base = starterGenome();
    expect(epithet(ext('webbing', 255))).toBe('alata');
    expect(epithet(withLoci(base, { curve: 255 }))).toBe('spiralis');
    expect(epithet(withLoci(base, { symmetry: 255 }))).toBe('radiatus');
    expect(epithet(withLoci(base, { eyeSize: 255 }))).toBe('oculatus');
    const setose = decodeGenome(
      Uint8Array.from(encodeGenome(ext('setaeDensity', 255))).map((b, i) =>
        i % HAPLOTYPE_BYTES === slot.ext + 2 ? 255 : b,
      ),
    );
    expect(epithet(setose)).toBe('setosus');
    // A v1 body takes none of them.
    for (const g of [starterGenome(), ...Object.values(ARCHETYPES)].filter(
      (g) => g.haplotypes[0].alleles.length === HAPLOTYPE_BYTES_V1,
    ))
      expect(['alata', 'spiralis', 'radiatus', 'oculatus', 'setosus']).not.toContain(epithet(g));
  });

  it('is deterministic per genome hash for the new traits too', () => {
    for (const g of genomes.slice(0, 300)) expect(speciesName(g)).toBe(speciesName(g));
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
const BAD_NUMBER = /\d+\.\d{3,}|NaN|undefined|Infinity/;

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
      ...genomes.slice(0, 600),
      ...Array.from({ length: 300 }, (_, i) => decodeGenome(randomBytes(i))),
    ];
    const bad = all
      .flatMap((g) => describeCreature(buildCreature(g)))
      .filter((s) => BANNED.test(s) || BAD_NUMBER.test(s) || s.length <= 10 || !s.endsWith('.'));
    expect(bad).toEqual([]);
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
