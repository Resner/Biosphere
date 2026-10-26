import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createRng, seedFromString } from '../sim/prng';
import { RULES, RULES_VERSION } from '../sim/rules';
import { decodeGenome, type Genome } from './codec';
import { express, QUANT_TRAITS, SEGMENT_LOCI, SIZE_LOCI, type Traits } from './express';
import { GENOME_BYTES, HAPLOTYPE_BYTES, LOCI, MODULE_PARAMS } from './karyotype';

const rng = createRng(seedFromString('genome-express-tests'), 'bytes');

function randomBytes(): Uint8Array {
  return Uint8Array.from({ length: GENOME_BYTES }, () => rng.nextU32() & 0xff);
}

const randomGenome = (): Genome => decodeGenome(randomBytes());

const locus = (id: string) => LOCI.find((l) => l.id === id) as (typeof LOCI)[number];

/** A genome of all-zero bytes, with `set` applied per haplotype as (id, value) pairs. */
function genomeWith(
  a: Record<string, number> = {},
  b: Record<string, number> = {},
  base = 0,
): Genome {
  const bytes = new Uint8Array(GENOME_BYTES).fill(base);
  for (const [hap, set] of [
    [0, a],
    [1, b],
  ] as const) {
    for (const [id, v] of Object.entries(set)) {
      bytes[hap * HAPLOTYPE_BYTES + locus(id).offset] = v;
    }
  }
  return decodeGenome(bytes);
}

const swapped = (g: Genome): Genome => ({
  haplotypes: [g.haplotypes[1], g.haplotypes[0]],
});

function numbers(value: unknown, out: number[] = []): number[] {
  if (typeof value === 'number') out.push(value);
  else if (Array.isArray(value)) for (const v of value) numbers(v, out);
  else if (typeof value === 'object' && value !== null) {
    for (const v of Object.values(value)) numbers(v, out);
  }
  return out;
}

const get = (t: Traits, group: string, key: string): number =>
  ((t as unknown as Record<string, Record<string, number>>)[group] as Record<string, number>)[
    key
  ] as number;

/** Plain loops instead of `expect` per value: this runs 10,000 times. */
function violations(t: Traits): string[] {
  const bad: string[] = [];
  for (const n of numbers(t)) if (!Number.isFinite(n)) bad.push(`not finite: ${n}`);
  for (const q of QUANT_TRAITS) {
    const [lo, hi] = (RULES.genes.range[q.group] as Record<string, readonly number[]>)[
      q.key
    ] as readonly [number, number];
    const v = get(t, q.group, q.key);
    if (!(v >= lo && v <= hi)) bad.push(`${q.group}.${q.key} = ${v}`);
  }
  const { segments, maxBiomass } = t.body;
  if (!Number.isInteger(segments) || segments < 1 || segments > RULES.genes.segments) {
    bad.push(`segments ${segments}`);
  }
  if (!(maxBiomass >= 300 && maxBiomass <= 300 * 8192)) bad.push(`maxBiomass ${maxBiomass}`);
  if (t.modules.length !== 8) bad.push('modules');
  for (const m of t.modules) {
    for (const p of MODULE_PARAMS) {
      const v = m.params[p];
      if (!(Number.isInteger(v) && v >= 0 && v <= 255)) bad.push(`param ${p} = ${v}`);
    }
  }
  return bad;
}

const checkRanges = (t: Traits): void => {
  expect(violations(t)).toEqual([]);
};

describe('express: totality', () => {
  it('gives finite, in-range traits for 10,000 random genomes', () => {
    for (let i = 0; i < 10_000; i++) {
      const bad = violations(express(randomGenome()));
      if (bad.length > 0) expect(bad).toEqual([]);
    }
  });

  it('handles the extreme genomes', () => {
    const alternating = Uint8Array.from({ length: GENOME_BYTES }, (_, i) => (i & 1 ? 0xff : 0));
    for (const bytes of [
      new Uint8Array(GENOME_BYTES),
      new Uint8Array(GENOME_BYTES).fill(0xff),
      alternating,
    ]) {
      checkRanges(express(decodeGenome(bytes)));
    }
  });

  it('survives genomes that did not come from the codec', () => {
    const junk: Genome = {
      haplotypes: [
        { alleles: [Number.NaN, -5, 1e9, 3.7] },
        { alleles: Array.from({ length: 400 }, (_, i) => i * 977) },
      ],
    };
    checkRanges(express(junk));
  });

  it('is deterministic and plain data', () => {
    const g = randomGenome();
    expect(express(g)).toEqual(express(g));
    expect(structuredClone(express(g))).toEqual(express(g));
  });
});

describe('express: order invariance', () => {
  it('does not depend on which haplotype is first', () => {
    for (let i = 0; i < 1000; i++) {
      const g = randomGenome();
      expect(express(swapped(g))).toEqual(express(g));
    }
  });
});

describe('express: quant loci', () => {
  it('maps the mean of both alleles onto the range and rises with either allele', () => {
    for (const q of QUANT_TRAITS) {
      for (const hap of [0, 1] as const) {
        let previous = Number.NEGATIVE_INFINITY;
        for (let v = 0; v <= 255; v += 15) {
          const set = Object.fromEntries(q.loci.map((id) => [id, v]));
          const g = hap === 0 ? genomeWith(set, {}) : genomeWith({}, set);
          const value = get(express(g), q.group, q.key);
          expect(value, `${q.key} ${v}`).toBeGreaterThanOrEqual(previous);
          previous = value;
        }
        const [lo, hi] = (RULES.genes.range[q.group] as Record<string, readonly number[]>)[
          q.key
        ] as readonly [number, number];
        // Every locus of the trait at 255 on one allele only: halfway.
        expect(previous).toBeCloseTo(lo + (hi - lo) * 0.5, 9);
      }
    }
  });

  it('is exactly the range ends for all-0 and all-255', () => {
    const low = express(genomeWith());
    const high = express(decodeGenome(new Uint8Array(GENOME_BYTES).fill(0xff)));
    for (const q of QUANT_TRAITS) {
      const [lo, hi] = (RULES.genes.range[q.group] as Record<string, readonly number[]>)[
        q.key
      ] as readonly [number, number];
      expect(get(low, q.group, q.key)).toBe(lo);
      expect(get(high, q.group, q.key)).toBe(hi);
    }
  });

  it('moves a polygenic trait by its weight per locus', () => {
    const polygenic = QUANT_TRAITS.filter((q) => q.loci.length > 1);
    expect(polygenic.map((q) => `${q.group}.${q.key}`).sort()).toEqual([
      'colour.hue',
      'skin.plating',
    ]);
    for (const q of polygenic) {
      const [lo, hi] = (RULES.genes.range[q.group] as Record<string, readonly number[]>)[
        q.key
      ] as readonly [number, number];
      const base = get(express(genomeWith()), q.group, q.key);
      for (const id of q.loci) {
        const both = genomeWith({ [id]: 255 }, { [id]: 255 });
        expect(get(express(both), q.group, q.key) - base).toBeCloseTo((hi - lo) / q.loci.length, 9);
      }
    }
  });

  it('sums two segmentation loci into 1-8 segments and three size loci into max biomass', () => {
    expect(SEGMENT_LOCI).toHaveLength(2);
    expect(SIZE_LOCI).toHaveLength(3);
    const segments = (v: number): number => {
      const set = Object.fromEntries(SEGMENT_LOCI.map((id) => [id, v]));
      return express(genomeWith(set, set)).body.segments;
    };
    expect(segments(0)).toBe(1);
    expect(segments(255)).toBe(8);
    let previous = 0;
    const seen = new Set<number>();
    for (let v = 0; v <= 255; v++) {
      const s = segments(v);
      expect(s).toBeGreaterThanOrEqual(previous);
      previous = s;
      seen.add(s);
    }
    expect(seen.size).toBe(8);
    // One of the two loci alone reaches half of the drive.
    const one = genomeWith({ segDrive1: 255 }, { segDrive1: 255 });
    expect(express(one).body.segments).toBe(5);
  });

  it('gives max size 300 · 2^(13t)', () => {
    const size = (v: number): number => {
      const set = Object.fromEntries(SIZE_LOCI.map((id) => [id, v]));
      return express(genomeWith(set, set)).body.maxBiomass;
    };
    expect(size(0)).toBe(300);
    expect(size(255)).toBe(300 * 8192);
    expect(size(51)).toBeCloseTo(300 * 2 ** (13 * 0.2), 6);
    let previous = 0;
    for (let v = 0; v <= 255; v += 5) {
      expect(size(v)).toBeGreaterThan(previous);
      previous = size(v);
    }
    // Each size locus carries a third of t.
    const third = express(genomeWith({ size1: 255 }, { size1: 255 })).body.maxBiomass;
    expect(third).toBeCloseTo(300 * 2 ** (13 / 3), 6);
  });
});

describe('express: mendel loci', () => {
  const alleleIndex = (id: string, name: string): number =>
    (locus(id) as { alleles: readonly string[] }).alleles.indexOf(name);
  const both = (id: string, a: string, b: string) =>
    genomeWith({ [id]: alleleIndex(id, a) }, { [id]: alleleIndex(id, b) });

  it('iridescence: plain is dominant over iridescent', () => {
    const read = (a: string, b: string) => express(both('iridescence', a, b)).skin.iridescence;
    expect(read('plain', 'plain')).toBe('plain');
    expect(read('plain', 'iridescent')).toBe('plain');
    expect(read('iridescent', 'plain')).toBe('plain');
    expect(read('iridescent', 'iridescent')).toBe('iridescent');
    expect(read('oil', 'oil')).toBe('oil');
    expect(read('oil', 'iridescent')).toBe('iridescent');
  });

  it('pattern: none < rings < spots = stripes, spots with stripes shows both', () => {
    const read = (a: string, b: string) => express(both('pattern', a, b)).colour.pattern;
    expect(read('none', 'none')).toEqual(['none']);
    expect(read('none', 'rings')).toEqual(['rings']);
    expect(read('rings', 'rings')).toEqual(['rings']);
    expect(read('rings', 'spots')).toEqual(['spots']);
    expect(read('stripes', 'rings')).toEqual(['stripes']);
    expect(read('spots', 'spots')).toEqual(['spots']);
    expect(read('spots', 'stripes')).toEqual(['spots', 'stripes']);
    expect(read('stripes', 'spots')).toEqual(['spots', 'stripes']);
    expect(read('stripes', 'stripes')).toEqual(['stripes']);
    expect(read('bands', 'spots')).toEqual(['bands']);
  });

  it('albino is recessive', () => {
    const read = (a: string, b: string) => express(both('albino', a, b)).colour.albino;
    expect(read('normal', 'normal')).toBe('normal');
    expect(read('normal', 'albino')).toBe('normal');
    expect(read('albino', 'albino')).toBe('albino');
    expect(read('albino', 'pale')).toBe('albino');
    expect(read('pale', 'pale')).toBe('pale');
  });

  it('luminescence: on is dominant', () => {
    const read = (a: string, b: string) => express(both('luminescence', a, b)).colour.luminescence;
    expect(read('off', 'off')).toBe('off');
    expect(read('off', 'on')).toBe('on');
    expect(read('on', 'on')).toBe('on');
    expect(read('off', 'pulse')).toBe('pulse');
    expect(read('on', 'pulse')).toBe('on');
  });

  it('target preference: nearest > weakest > largest by rank', () => {
    const read = (a: string, b: string) => express(both('targetPref', a, b)).behaviour.targetPref;
    expect(read('nearest', 'weakest')).toBe('nearest');
    expect(read('nearest', 'largest')).toBe('nearest');
    expect(read('weakest', 'largest')).toBe('weakest');
    expect(read('largest', 'largest')).toBe('largest');
    expect(read('largest', 'strongest')).toBe('largest');
  });

  it('incomplete dominance blends: the heterozygote is halfway', () => {
    const read = (a: string, b: string) => express(both('texture', a, b)).skin.texture;
    expect(read('smooth', 'smooth')).toBe(0);
    expect(read('grainy', 'grainy')).toBe(1);
    expect(read('smooth', 'grainy')).toBe(0.5);
    expect(read('grainy', 'smooth')).toBe(0.5);
    expect(read('smooth', 'ridged')).toBe(1);
    expect(read('ridged', 'ridged')).toBe(2);
  });
});

describe('express: load loci', () => {
  const clean = express(genomeWith());
  const lof = RULES.genes.lof;
  const defect = {
    L1: ['membraneIntegrity', lof.membraneIntegrity],
    L2: ['partScale', lof.partScale],
    L3: ['beatStrength', lof.beatStrength],
    L4: ['metabolismCost', lof.metabolismCost],
  } as const;

  it('changes nothing when heterozygous', () => {
    for (const id of Object.keys(defect)) {
      expect(express(genomeWith({ [id]: 1 }, {}))).toEqual(clean);
      expect(express(genomeWith({}, { [id]: 1 }))).toEqual(clean);
    }
    for (let i = 0; i < 200; i++) {
      const g = randomGenome();
      const healed = decodeGenome(
        (() => {
          const bytes = Uint8Array.from(g.haplotypes.flatMap((h) => h.alleles));
          for (const id of Object.keys(defect)) bytes[locus(id).offset] = 0;
          return bytes;
        })(),
      );
      // Clearing the load alleles of one haplotype removes any homozygous defect, and nothing else.
      const [before, after] = [express(g), express(healed)];
      expect({ ...after, defects: before.defects }).toEqual(before);
    }
  });

  it('degrades exactly the named trait when homozygous', () => {
    for (const [id, [name, factor]] of Object.entries(defect)) {
      const t = express(genomeWith({ [id]: 1 }, { [id]: 1 }));
      expect(t.defects).toEqual({ ...clean.defects, [name]: factor });
      expect({ ...t, defects: clean.defects }).toEqual(clean);
    }
  });
});

describe('express: modules', () => {
  const params = (v: number, extra: Partial<Record<string, number>> = {}): number[] =>
    MODULE_PARAMS.map((name) => extra[name] ?? v);

  function withModule(
    hap: 0 | 1,
    bytes: Uint8Array,
    slot: string,
    present: number,
    p: number[],
  ): void {
    const at = hap * HAPLOTYPE_BYTES + locus(slot).offset;
    bytes[at] = present;
    p.forEach((v, k) => {
      bytes[at + 1 + k] = v;
    });
  }

  it('is expressed when present in either haplotype', () => {
    for (const hap of [0, 1] as const) {
      const bytes = new Uint8Array(GENOME_BYTES);
      withModule(hap, bytes, 'M3', 1, params(77));
      const t = express(decodeGenome(bytes));
      expect(t.modules[2]?.present).toBe(true);
      expect(t.modules[2]?.params.length).toBe(77);
      expect(t.modules.filter((m) => m.present)).toHaveLength(1);
    }
  });

  it('averages parameters when present in both, rounding half up', () => {
    const cases: [number, number, number][] = [
      [0, 255, 128],
      [255, 255, 255],
      [0, 0, 0],
      [3, 4, 4],
      [4, 3, 4],
      [100, 101, 101],
      [100, 102, 101],
    ];
    for (const [x, y, mean] of cases) {
      const bytes = new Uint8Array(GENOME_BYTES);
      withModule(0, bytes, 'M1', 1, params(x));
      withModule(1, bytes, 'M1', 1, params(y));
      const t = express(decodeGenome(bytes));
      for (const p of MODULE_PARAMS) expect(t.modules[0]?.params[p]).toBe(mean);
    }
  });

  it('ignores the parameter bytes of an absent module', () => {
    const base = new Uint8Array(GENOME_BYTES);
    withModule(0, base, 'M2', 1, params(10));
    const reference = express(decodeGenome(base));
    for (const slot of ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8']) {
      // Garbage under an absent slot, set on the genome directly so no canonicalisation hides it.
      const g = decodeGenome(base);
      const alleles = [...g.haplotypes[1].alleles];
      const at = locus(slot).offset;
      for (let k = 1; k < 15; k++) alleles[at + k] = 0xa7;
      const noisy: Genome = { haplotypes: [g.haplotypes[0], { alleles }] };
      expect(express(noisy), slot).toEqual(reference);
    }
  });
});

describe('express: golden vectors', () => {
  const inputs: Record<string, Uint8Array> = {
    zero: new Uint8Array(GENOME_BYTES),
    counter: Uint8Array.from({ length: GENOME_BYTES }, (_, i) => i & 0xff),
    random: (() => {
      const r = createRng(seedFromString('genome-golden'), 'bytes');
      return Uint8Array.from({ length: GENOME_BYTES }, () => r.nextU32() & 0xff);
    })(),
  };
  const digest = (bytes: Uint8Array): string =>
    createHash('sha256')
      .update(JSON.stringify(express(decodeGenome(bytes))))
      .digest('hex');
  const file = new URL('./__golden__/express.json', import.meta.url);

  if (process.env.UPDATE_GOLDENS) {
    writeFileSync(
      file,
      `${JSON.stringify(
        {
          rulesVersion: RULES_VERSION,
          vectors: Object.fromEntries(Object.entries(inputs).map(([k, b]) => [k, digest(b)])),
        },
        null,
        2,
      )}\n`,
    );
  }

  it('matches the committed traits digests', () => {
    const golden = JSON.parse(readFileSync(file, 'utf8')) as {
      rulesVersion: number;
      vectors: Record<string, string>;
    };
    expect(golden.rulesVersion).toBe(RULES_VERSION);
    expect(Object.keys(golden.vectors)).toEqual(Object.keys(inputs));
    for (const [name, bytes] of Object.entries(inputs)) {
      expect(digest(bytes), name).toBe(golden.vectors[name]);
    }
  });
});
