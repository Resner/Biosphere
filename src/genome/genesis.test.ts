import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { metricsAt } from '../../tests/archetypes';
import { type Seed, seedFromString } from '../sim/prng';
import { RULES_VERSION } from '../sim/rules';
import { genomeHash } from './codec';
import { bodyViolations } from './develop';
import { GENESIS_FREQ, genesisGenome } from './genesis';
import { LOCI } from './karyotype';
import { starterGenome } from './starter';
import { buildCreature } from './stats';

const seedOf = (i: number): Seed => seedFromString(`genesis-test-${i}`);
const N = 20_000;
const genomes = Array.from({ length: N }, (_, i) => genesisGenome(seedOf(i)));
const creatures = genomes.map(buildCreature);

/** Four standard deviations of a binomial count's frequency. */
const tol = (p: number, n: number): number => 4 * Math.sqrt((p * (1 - p)) / n);

const appearanceKey = (c: (typeof creatures)[number]): string =>
  [
    Math.min(23, Math.floor(c.traits.colour.hue * 24)),
    c.traits.colour.pattern[0],
    Math.min(2, Math.floor(c.traits.skin.membrane * 3)),
    c.traits.colour.albino,
    c.traits.skin.iridescence,
    c.traits.colour.luminescence,
  ].join('/');

/** How often an allele index shows up at a locus, over every haplotype of every genome. */
function alleleFreq(id: string, index: number): number {
  const at = (LOCI.find((l) => l.id === id) as { offset: number }).offset;
  let n = 0;
  for (const g of genomes) for (const h of g.haplotypes) if (h.alleles[at] === index) n++;
  return n / (2 * genomes.length);
}

describe('genesisGenome', () => {
  it('is a pure function of the seed', () => {
    expect(genomeHash(genesisGenome(seedOf(7)))).toBe(genomeHash(genesisGenome(seedOf(7))));
    expect(genomeHash(genesisGenome(seedOf(7)))).not.toBe(genomeHash(genesisGenome(seedOf(8))));
  });

  it('gives a single cell with a whip, 300-900 biomass and a valid plan', () => {
    for (const c of creatures) {
      expect(c.traits.body.segments).toBe(1);
      const m1 = c.traits.modules[0];
      expect(m1?.present).toBe(true);
      expect(m1?.params.tipShape).toBeGreaterThanOrEqual(230);
      expect(c.traits.body.maxBiomass).toBeGreaterThanOrEqual(300);
      expect(c.traits.body.maxBiomass).toBeLessThanOrEqual(900);
      expect(c.plan.segments).toHaveLength(1);
      expect(bodyViolations(c.plan)).toEqual([]);
    }
  });

  it('adds a ciliary band to half of the cells', () => {
    const share = creatures.filter((c) => c.traits.modules[1]?.present).length / N;
    expect(Math.abs(share - GENESIS_FREQ.band)).toBeLessThan(tol(GENESIS_FREQ.band, N));
  });

  it('gives all-different DNA over 20,000 seeds', () => {
    expect(new Set(genomes.map(genomeHash)).size).toBe(N);
  });

  it('spreads looks: appearance keys and the hue wheel', () => {
    const keys = new Set(creatures.slice(0, 1000).map(appearanceKey));
    expect(keys.size).toBeGreaterThan(400);
    const bins = new Array<number>(12).fill(0);
    for (const c of creatures) {
      const bin = Math.min(11, Math.floor(c.traits.colour.hue * 12));
      bins[bin] = (bins[bin] ?? 0) + 1;
    }
    for (const b of bins) {
      expect(b / N).toBeGreaterThanOrEqual(0.05);
      expect(b / N).toBeLessThanOrEqual(0.14);
    }
  });

  it('draws rare alleles at their listed frequencies', () => {
    const rare: [string, number, number][] = [
      ['iridescence', 1, GENESIS_FREQ.iridescent],
      ['albino', 1, GENESIS_FREQ.albino],
      ['pattern', 3, GENESIS_FREQ.pattern[3] as number],
      ['L1', 1, GENESIS_FREQ.load],
      ['L2', 1, GENESIS_FREQ.load],
      ['L3', 1, GENESIS_FREQ.load],
      ['L4', 1, GENESIS_FREQ.load],
    ];
    for (const [id, index, p] of rare) {
      expect(Math.abs(alleleFreq(id, index) - p), id).toBeLessThan(tol(p, 2 * N));
    }
  });

  it('shows the recessive ones only when both alleles carry them', () => {
    const irid = creatures.filter((c) => c.traits.skin.iridescence === 'iridescent').length / N;
    const p = GENESIS_FREQ.iridescent ** 2;
    expect(Math.abs(irid - p)).toBeLessThan(tol(p, N));
    const albino = creatures.filter((c) => c.traits.colour.albino === 'albino').length / N;
    const q = GENESIS_FREQ.albino ** 2;
    expect(Math.abs(albino - q)).toBeLessThan(tol(q, N));
    const defect = creatures.filter((c) => c.traits.defects.beatStrength < 1).length / N;
    const r = GENESIS_FREQ.load ** 2;
    expect(Math.abs(defect - r)).toBeLessThan(tol(r, N));
  });

  it('never draws a novel allele', () => {
    for (const l of LOCI) {
      if (l.kind !== 'mendel') continue;
      for (const g of genomes.slice(0, 2000))
        for (const h of g.haplotypes)
          expect(h.alleles[l.offset] as number, l.id).toBeLessThan(l.novelFrom);
    }
  });

  it('swims about as fast as the M1 cell (median within 0.8-1.2x)', () => {
    const ref = metricsAt(starterGenome(), 400).speed;
    const ratios = genomes
      .slice(0, 1000)
      .map((g, i) => metricsAt(g, (creatures[i] as (typeof creatures)[number]).stats.maxBiomass))
      .map((m) => m.speed / ref)
      .sort((a, b) => a - b);
    const median = ratios[500] as number;
    expect(median).toBeGreaterThan(0.8);
    expect(median).toBeLessThan(1.2);
  });

  it('does not collapse into copies (first 200 cells)', () => {
    const counts = new Map<string, number>();
    for (const c of creatures.slice(0, 200)) {
      const band = Math.min(2, Math.floor(c.traits.mouth.type * 3));
      const key = `${appearanceKey(c)}|${c.plan.appendages.length}|${band}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(3);
  });

  it('keeps starterGenome free of rare features', () => {
    const t = buildCreature(starterGenome()).traits;
    expect(t.skin.iridescence).toBe('plain');
    expect(t.colour.albino).toBe('normal');
    expect(t.colour.luminescence).toBe('off');
    expect(t.defects).toEqual({
      membraneIntegrity: 1,
      partScale: 1,
      beatStrength: 1,
      metabolismCost: 1,
    });
  });

  it('matches the committed hashes for three seeds', () => {
    const file = new URL('./__golden__/genesis.json', import.meta.url);
    const seeds = ['alpha', 'beta', 'gamma'];
    const actual = Object.fromEntries(
      seeds.map((s) => [s, genomeHash(genesisGenome(seedFromString(s)))]),
    );
    if (process.env.UPDATE_GOLDENS === '1') {
      writeFileSync(
        file,
        `${JSON.stringify({ rulesVersion: RULES_VERSION, hashes: actual }, null, 2)}\n`,
      );
    }
    const golden = JSON.parse(readFileSync(file, 'utf8')) as {
      rulesVersion: number;
      hashes: Record<string, string>;
    };
    expect(golden.rulesVersion).toBe(RULES_VERSION);
    expect(actual).toEqual(golden.hashes);
  });
});
