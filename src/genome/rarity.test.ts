import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { locus, withAlleles } from '../../tests/archetypes';
import { type Seed, seedFromString } from '../sim/prng';
import { RULES_VERSION } from '../sim/rules';
import { sizeTier } from '../sim/size';
import { decodeGenome, encodeGenome, type Genome } from './codec';
import { express } from './express';
import { GENESIS_EYES, GENESIS_FORMS, genesisGenome } from './genesis';
import { HAPLOTYPE_BYTES, MODULE_BYTES, MODULE_EXT, MODULE_LOCI, MODULE_PARAMS } from './karyotype';
import { featureBits, NEVER_BITS, RARITY_TIERS, rarityOf } from './rarity';
import { starterGenome } from './starter';

const seedOf = (i: number): Seed => seedFromString(`rarity-test-${i}`);
const N = 20_000;
const genomes = Array.from({ length: N }, (_, i) => genesisGenome(seedOf(i)));
const rarities = genomes.map(rarityOf);

/** A module present in both haplotypes with the given first parameter bytes. */
function withModule(base: Genome, id: string): Genome {
  const bytes = encodeGenome(base);
  for (let hap = 0; hap < 2; hap++) {
    const o = hap * HAPLOTYPE_BYTES + locus(id).offset;
    bytes[o] = 1;
    bytes[o + 1] = 100;
    bytes[o + 2] = 40;
    bytes[o + MODULE_BYTES - 1] = 0;
  }
  return decodeGenome(bytes);
}

/** M1 with fine detail set on both haplotypes (and a pointed tip, which a chela needs). */
function withExt(base: Genome, set: Partial<Record<(typeof MODULE_EXT)[number], number>>): Genome {
  const bytes = encodeGenome(base);
  const slot = MODULE_LOCI[0] as (typeof MODULE_LOCI)[number];
  for (let hap = 0; hap < 2; hap++) {
    const o = hap * HAPLOTYPE_BYTES;
    for (const [name, v] of Object.entries(set))
      bytes[o + slot.ext + MODULE_EXT.indexOf(name as (typeof MODULE_EXT)[number])] = v;
    if (set.chela) bytes[o + slot.offset + 1 + MODULE_PARAMS.indexOf('tipShape')] = 96;
  }
  return decodeGenome(bytes);
}

const plain = (): Genome =>
  withAlleles(starterGenome(), {
    pattern: [0, 0],
    iridescence: [0, 0],
    albino: [0, 0],
    luminescence: [0, 0],
    texture: [0, 0],
  });

const withoutRare = (g: Genome): Genome =>
  withExt(
    withAlleles(g, {
      iridescence: [0, 0],
      albino: [0, 0],
      luminescence: [0, 0],
      pattern: [0, 0],
      texture: [0, 0],
      symmetry: [0, 0],
      drape: [0, 0],
      eyeSize: [0, 0],
    }),
    { webbing: 0 },
  );

/** Edits that each add one listed rare feature to a genome without rare features, and keep the earlier ones. */
const STEPS: [string, (g: Genome) => Genome][] = [
  ['luminescent', (g) => withAlleles(g, { luminescence: [1, 0] })],
  ['iridescent', (g) => withAlleles(g, { iridescence: [1, 1] })],
  ['albino', (g) => withAlleles(g, { albino: [1, 1] })],
  ['stripes', (g) => withAlleles(g, { pattern: [3, 0] })],
  ['spots', (g) => withAlleles(g, { pattern: [3, 2] })],
  ['segments', (g) => withAlleles(g, { segDrive1: [255, 255], segDrive2: [255, 255] })],
  ['modules', (g) => withModule(g, 'M5')],
  ['novel', (g) => withAlleles(g, { texture: [2, 2] })],
  ['size', (g) => withAlleles(g, { size1: [255, 255] })],
  ['radial', (g) => withAlleles(g, { symmetry: [255, 255] })],
  ['eyes', (g) => withAlleles(g, { eyeSize: [255, 255] })],
  ['webbing', (g) => withExt(g, { webbing: 200 })],
  ['chela', (g) => withExt(g, { chela: 255 })],
  ['coil', (g) => withAlleles(g, { curve: [255, 255] })],
  ['carapace', (g) => withAlleles(g, { fusion: [255, 255] })],
];

/** Each feature on its own, from a plain base. */
const ALONE: Record<string, (g: Genome) => Genome> = {
  ...Object.fromEntries(STEPS),
  stripes: (g) => withAlleles(g, { pattern: [3, 3] }),
  spots: (g) => withAlleles(g, { pattern: [2, 2] }),
  rings: (g) => withAlleles(g, { pattern: [1, 1] }),
  novel: (g) => withAlleles(g, { albino: [2, 2] }),
  coil: (g) => withAlleles(g, { curve: [255, 255] }),
  radial: (g) => withAlleles(g, { symmetry: [255, 255] }),
  carapace: (g) => withAlleles(g, { fusion: [255, 255] }),
  eyes: (g) => withAlleles(g, { eyeSize: [255, 255] }),
  webbing: (g) => withExt(g, { webbing: 200 }),
  chela: (g) => withExt(g, { chela: 255 }),
};

describe('rarityOf', () => {
  it('scores a genome with no rare features 0, and calls it common', () => {
    for (const g of [plain(), starterGenome()]) {
      expect(rarityOf(g)).toEqual({ score: 0, tier: 'common', features: [] });
    }
  });

  it('prices a feature at -log2 of its exact genesis frequency, and 12 bits when genesis never makes it', () => {
    // Per-allele frequencies 0.05 and 0.04 give homozygous phenotypes of 0.25% and 0.16%.
    expect(featureBits.iridescent).toBeCloseTo(-Math.log2(0.05 ** 2), 9);
    expect(featureBits.albino).toBeCloseTo(-Math.log2(0.04 ** 2), 9);
    // Pattern: stripes show with one stripes allele (0.1) whatever the other is, spots likewise (0.3).
    expect(featureBits.stripes).toBeCloseTo(-Math.log2(1 - 0.9 ** 2), 9);
    expect(featureBits.spots).toBeCloseTo(-Math.log2(1 - 0.7 ** 2), 9);
    // Rings show only without spots or stripes: (0.6² − 0.4²).
    expect(featureBits.rings).toBeCloseTo(-Math.log2(0.6 ** 2 - 0.4 ** 2), 9);
    expect(featureBits.luminescent).toBeCloseTo(-Math.log2(1 - 0.7 ** 2), 9);
    for (const name of ['segments', 'modules', 'novel', 'size', 'coil', 'carapace', 'chela']) {
      expect(featureBits[name], name).toBe(NEVER_BITS);
    }
    expect(NEVER_BITS).toBe(12);
    // The v2 features genesis makes are priced from the form table and the eye chance.
    const share = (pick: (f: (typeof GENESIS_FORMS)[number]) => boolean): number =>
      GENESIS_FORMS.filter(pick).reduce((sum, f) => sum + f.weight, 0);
    expect(featureBits.radial).toBeCloseTo(-Math.log2(share((f) => f.radial)), 9);
    expect(featureBits.webbing).toBeCloseTo(-Math.log2(share((f) => f.webbed)), 9);
    expect(featureBits.eyes).toBeCloseTo(-Math.log2(GENESIS_EYES), 9);
  });

  it('matches the measured genesis frequencies of the features it prices', () => {
    for (const name of [
      'iridescent',
      'albino',
      'stripes',
      'spots',
      'rings',
      'luminescent',
      'radial',
      'webbing',
      'eyes',
    ]) {
      const p = 2 ** -(featureBits[name] as number);
      const count = rarities.filter((r) => r.features.includes(name)).length;
      const sd = Math.sqrt((p * (1 - p)) / N);
      expect(Math.abs(count / N - p), `${name}: ${count}/${N} vs ${p}`).toBeLessThanOrEqual(4 * sd);
    }
  });

  it('never sees a 12-bit feature in genesis', () => {
    const never = new Set(['segments', 'modules', 'novel', 'size', 'coil', 'carapace', 'chela']);
    expect(rarities.filter((r) => r.features.some((f) => never.has(f)))).toEqual([]);
  });

  it('sums the listed features, and tiers follow the cut-offs', () => {
    for (const r of rarities.slice(0, 2000)) {
      const sum = r.features.reduce((a, f) => a + (featureBits[f] as number), 0);
      expect(r.score).toBeCloseTo(sum, 9);
      const expected = RARITY_TIERS.reduce(
        (t, [name, from]) => (r.score >= from ? name : t),
        'common',
      );
      expect(r.tier).toBe(expected);
    }
    expect(RARITY_TIERS).toEqual([
      ['common', 0],
      ['uncommon', 4],
      ['rare', 8],
      ['exotic', 14],
    ]);
  });

  it('is monotone: adding a listed rare feature never lowers the score', () => {
    for (let i = 0; i < 300; i++) {
      let g = withoutRare(genomes[i] as Genome);
      let last = rarityOf(g);
      expect(last.score).toBe(0);
      for (const [name, add] of STEPS) {
        g = add(g);
        const next = rarityOf(g);
        expect(next.features, `${name} #${i}`).toContain(name);
        expect(next.score, `${name} #${i}`).toBeGreaterThan(last.score);
        last = next;
      }
    }
  });

  it('counts each expressed feature exactly once on a plain base', () => {
    const base = plain();
    for (const [name, add] of Object.entries(ALONE)) {
      const r = rarityOf(add(base));
      expect(r.features, name).toEqual([name]);
      expect(r.score, name).toBeCloseTo(featureBits[name] as number, 9);
    }
  });

  it('keeps most genesis cells common, a few uncommon, almost none exotic', () => {
    const count = (p: (t: string) => boolean): number => rarities.filter((r) => p(r.tier)).length;
    // The larval forms (a radial body at 27%, eyes at 12%) add to the lower tiers: about 70% stay common.
    expect(count((t) => t === 'common') / N).toBeGreaterThanOrEqual(0.65);
    const higher = count((t) => t !== 'common') / N;
    expect(higher).toBeGreaterThanOrEqual(0.03);
    expect(higher).toBeLessThanOrEqual(0.35);
    expect(count((t) => t === 'exotic') / N).toBeLessThan(0.01);
  });

  it('calls an iridescent, albino, striped genome exotic', () => {
    const g = withAlleles(plain(), {
      iridescence: [1, 1],
      albino: [1, 1],
      pattern: [3, 3],
    });
    const r = rarityOf(g);
    expect(r.tier).toBe('exotic');
    expect(r.features).toEqual(['iridescent', 'albino', 'stripes']);
  });

  it('prices a novel allele, an extra module, extra segments and a big body at 12 bits each', () => {
    expect(rarityOf(withAlleles(plain(), { albino: [2, 2] })).features).toEqual(['novel']);
    // A novel allele beside a genesis one still shows in an incomplete-dominance blend (ridged + grainy).
    expect(rarityOf(withAlleles(plain(), { texture: [2, 1] })).features).toEqual(['novel']);
    expect(rarityOf(withModule(plain(), 'M5')).features).toEqual(['modules']);
    const long = withAlleles(plain(), { segDrive1: [255, 255], segDrive2: [255, 255] });
    expect(express(long).body.segments).toBeGreaterThan(1);
    expect(rarityOf(long).features).toEqual(['segments']);
    const big = withAlleles(plain(), { size1: [255, 255] });
    expect(express(big).body.maxBiomass).toBeGreaterThanOrEqual(1024);
    expect(rarityOf(big).features).toEqual(['size']);
    expect(rarityOf(withoutRare(big)).score).toBe(NEVER_BITS);
  });

  it('is a total, finite function of any genome', () => {
    for (const fill of [0, 255]) {
      const r = rarityOf(decodeGenome(new Uint8Array(2 * HAPLOTYPE_BYTES).fill(fill)));
      expect(Number.isFinite(r.score)).toBe(true);
    }
  });

  it('matches the goldens for five fixed genomes', () => {
    const fixed: Record<string, Genome> = {
      starter: starterGenome(),
      plain: plain(),
      glowStripes: withAlleles(plain(), { luminescence: [1, 1], pattern: [3, 0] }),
      iridescentAlbinoStriped: withAlleles(plain(), {
        iridescence: [1, 1],
        albino: [1, 1],
        pattern: [3, 3],
      }),
      mutantBig: withAlleles(withModule(plain(), 'M6'), { size1: [255, 255], texture: [2, 2] }),
    };
    // Scores are logs, so compare them to 6 decimals rather than to the last bit.
    const actual = Object.fromEntries(
      Object.entries(fixed).map(([k, g]) => {
        const r = rarityOf(g);
        return [k, { ...r, score: Number(r.score.toFixed(6)) }];
      }),
    );
    const file = new URL('./__golden__/rarity.json', import.meta.url);
    if (process.env.UPDATE_GOLDENS === '1') {
      writeFileSync(
        file,
        `${JSON.stringify({ rulesVersion: RULES_VERSION, rarity: actual }, null, 2)}\n`,
      );
    }
    const golden = JSON.parse(readFileSync(file, 'utf8')) as {
      rulesVersion: number;
      rarity: unknown;
    };
    expect(golden.rulesVersion).toBe(RULES_VERSION);
    expect(actual).toEqual(golden.rarity);
  });
});

describe('sizeTier', () => {
  it('follows ADR 0013: ×4 steps in radius from 32', () => {
    expect(
      [0, 1023, 1024, 16_383, 16_384, 262_143, 262_144, 4_194_304, 1e12].map(sizeTier),
    ).toEqual([0, 0, 1, 1, 2, 2, 3, 4, 4]);
    expect(sizeTier(Number.NaN)).toBe(0);
  });
});
