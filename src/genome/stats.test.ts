import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ARCHETYPES, buildBytes, METRICS, type Metric, metricsAt } from '../../tests/archetypes';
import { STARTER_PHYS, sanitizePhys } from '../sim/body';
import { createRng, seedFromString } from '../sim/prng';
import { RULES, RULES_VERSION } from '../sim/rules';
import { decodeGenome, type Genome, genomeToBase64url } from './codec';
import { develop, hashPlan } from './develop';
import { express } from './express';
import { GENOME_BYTES, HAPLOTYPE_BYTES, LOCI } from './karyotype';
import { starterGenome } from './starter';
import { buildCreature, computeStats, hashStats, physOf, type Stats, statsAt } from './stats';

const rng = createRng(seedFromString('genome-stats-tests'), 'bytes');
const randomBytes = (): Uint8Array =>
  Uint8Array.from({ length: GENOME_BYTES }, () => rng.nextU32() & 0xff);

const locus = (id: string) => LOCI.find((l) => l.id === id) as (typeof LOCI)[number];

/** A copy of the bytes with `set` loci written in both haplotypes. */
function withLoci(bytes: Uint8Array, set: Record<string, number>): Uint8Array {
  const out = bytes.slice();
  for (const [id, v] of Object.entries(set)) {
    out[locus(id).offset] = v;
    out[HAPLOTYPE_BYTES + locus(id).offset] = v;
  }
  return out;
}

const statsOf = (bytes: Uint8Array): Stats => {
  const c = buildCreature(decodeGenome(bytes));
  return c.stats;
};

const extremes: Record<string, Uint8Array> = {
  zero: new Uint8Array(GENOME_BYTES),
  ones: new Uint8Array(GENOME_BYTES).fill(0xff),
  alternating: Uint8Array.from({ length: GENOME_BYTES }, (_, i) => (i % 2 ? 0xff : 0)),
  modulesFull: buildBytes(
    Object.fromEntries(
      ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8'].map((id) => [
        id,
        Object.fromEntries(
          [
            'length',
            'thickness',
            'taper',
            'curvature',
            'joints',
            'branching',
            'tipShape',
            'stiffness',
            'beat',
            'phase',
            'attachStart',
            'attachSpan',
            'angle',
            'pairs',
          ].map((p) => [p, 255]),
        ),
      ]),
    ),
  ),
};

/** The path of the first number that is not finite, or null. */
const nonFinite = (value: unknown, path = 'stats'): string | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? null : path;
  if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      const bad = nonFinite(v, `${path}.${k}`);
      if (bad) return bad;
    }
  }
  return null;
};

const finite = (value: unknown, path = 'stats'): void => {
  expect(nonFinite(value, path)).toBeNull();
};

describe('computeStats: totality and the body seam', () => {
  it('returns finite, sanitised stats for 10,000 random genomes and the extremes', () => {
    const genomes = [
      ...Object.values(extremes),
      ...Array.from({ length: 10_000 }, () => randomBytes()),
    ];
    genomes.forEach((bytes, i) => {
      const c = buildCreature(decodeGenome(bytes));
      const bad = nonFinite(c.stats, `genome ${i}`);
      if (bad) expect(bad).toBeNull();
      if (JSON.stringify(sanitizePhys(c.phys)) !== JSON.stringify(c.phys)) {
        expect(sanitizePhys(c.phys), `genome ${i}`).toEqual(c.phys);
      }
    });
  });

  it('develops and measures in well under a tenth of a millisecond at the median', () => {
    const traits = Array.from({ length: 1000 }, () => express(decodeGenome(randomBytes())));
    for (const t of traits) computeStats(develop(t), t); // warm up
    // The best of three runs, so that a busy runner does not fail the build.
    const median = Math.min(
      ...[0, 1, 2].map(() => {
        const times = traits.map((t) => {
          const start = performance.now();
          computeStats(develop(t), t);
          return performance.now() - start;
        });
        times.sort((a, b) => a - b);
        return times[500] as number;
      }),
    );
    expect(median).toBeLessThan(0.1);
  });

  it('is deterministic and plain data', () => {
    const g = decodeGenome(randomBytes());
    const a = buildCreature(g);
    const b = buildCreature(structuredClone(g));
    expect(a.hash).toBe(b.hash);
    expect(hashStats(structuredClone(a.stats))).toBe(hashStats(b.stats));
    expect(JSON.parse(JSON.stringify(a.phys))).toEqual(a.phys);
  });

  it('takes the plan and traits it is given, and no part label', () => {
    const g = decodeGenome(randomBytes());
    const traits = express(g);
    const plan = develop(traits);
    const relabelled = structuredClone(plan);
    relabelled.appendages.forEach((a, i) => {
      a.module = 100 + i;
    });
    expect(hashStats(computeStats(relabelled, traits))).toBe(hashStats(computeStats(plan, traits)));
  });

  it('computes the adult stats at the maximum biomass', () => {
    const c = buildCreature(decodeGenome(randomBytes()));
    expect(hashStats(statsAt(c.plan, c.traits, c.traits.body.maxBiomass))).toBe(hashStats(c.stats));
    expect(c.stats.maxBiomass).toBe(c.traits.body.maxBiomass);
  });
});

describe('computeStats: formulas', () => {
  it('prices the basal multiplier from segments, appendages, plating and glow', () => {
    // Two genomes that differ in one term each; the ratio of the multipliers follows DESIGN §6.
    const base = withLoci(buildBytes({ M1: { length: 100, thickness: 100, beat: 200 } }), {
      metabolism: 128,
    });
    const ref = statsOf(base);
    const plated = statsOf(withLoci(base, { plating1: 255, plating2: 255 }));
    const lit = statsOf(withLoci(base, { luminescence: 1 }));
    const plan = develop(express(decodeGenome(base)));
    const count = plan.appendages.length;
    const f = (segments: number, plating: number, glow: number) =>
      1 + 0.1 * (segments - 1) + 0.04 * count + 0.2 * plating + 0.1 * glow;
    expect(plated.basal / ref.basal).toBeCloseTo(f(1, 1, 0) / f(1, 0, 0), 9);
    expect(lit.basal / ref.basal).toBeCloseTo(f(1, 0, 1) / f(1, 0, 0), 9);
    expect(lit.glow).toBe(1);
    expect(ref.glow).toBe(0);
  });

  it('applies the homozygous loads', () => {
    const base = buildBytes({ M1: { length: 100, thickness: 100, beat: 200 } });
    const ref = statsOf(base);
    const beat = statsOf(withLoci(base, { L3: 1 }));
    expect(beat.thrust / ref.thrust).toBeCloseTo(RULES.genes.lof.beatStrength, 9);
    const metabolic = statsOf(withLoci(base, { L4: 1 }));
    expect(metabolic.basal / ref.basal).toBeCloseTo(RULES.genes.lof.metabolismCost, 9);
    const membrane = statsOf(withLoci(base, { membrane: 200, L1: 1 }));
    const sound = statsOf(withLoci(base, { membrane: 200 }));
    expect(membrane.integrity / sound.integrity).toBeCloseTo(RULES.genes.lof.membraneIntegrity, 9);
  });

  it('makes weapons from pointed and hooked tips, not from the others', () => {
    const spike = { length: 200, thickness: 60, stiffness: 255, beat: 0, angle: 30 };
    const bytes = (tipShape: number) =>
      buildBytes(
        {
          M1: { length: 150, thickness: 30, tipShape: 255, beat: 220 },
          M5: { ...spike, tipShape },
        },
        { mouthType: 0 },
      );
    expect(statsOf(bytes(96)).combat.power).toBeGreaterThan(0);
    expect(statsOf(bytes(96)).combat.reach).toBeGreaterThan(1.5);
    expect(statsOf(bytes(0)).combat.power).toBeLessThan(statsOf(bytes(96)).combat.power * 0.2);
    expect(statsOf(bytes(255)).combat.power).toBe(0);
  });

  it('lengthens the detection ring with slender forward stalks', () => {
    const feeler = { length: 220, thickness: 10, beat: 0, angle: 10, tipShape: 0 };
    const none = statsOf(
      buildBytes({ M1: { length: 100, thickness: 60, tipShape: 255, beat: 220 } }),
    );
    const stalk = statsOf(
      buildBytes({
        M1: { length: 100, thickness: 60, tipShape: 255, beat: 220 },
        M7: feeler,
      }),
    );
    expect(stalk.sense).toBeGreaterThan(none.sense);
    expect(none.sense).toBeGreaterThanOrEqual(1);
  });

  it('crosses from whip to paddle exactly once as size grows', () => {
    const common = { length: 150, thickness: 100, beat: 200, angle: 255, pairs: 128 };
    const whip = buildBytes({ M1: { ...common, tipShape: 255 } });
    const paddle = buildBytes({ M1: { ...common, tipShape: 191 } });
    const cw = buildCreature(decodeGenome(whip));
    const cp = buildCreature(decodeGenome(paddle));
    const sizes = Array.from({ length: 61 }, (_, i) => 100 * 10 ** (i / 15));
    const signs = sizes.map((b) =>
      Math.sign(statsAt(cw.plan, cw.traits, b).thrust - statsAt(cp.plan, cp.traits, b).thrust),
    );
    expect(sizes[sizes.length - 1]).toBeCloseTo(1e6, -3);
    expect(signs[0]).toBe(1);
    expect(signs[signs.length - 1]).toBe(-1);
    let changes = 0;
    for (let i = 1; i < signs.length; i++) if (signs[i] !== signs[i - 1]) changes++;
    expect(changes).toBe(1);
    const at = sizes.findIndex((_, i) => signs[i] !== signs[0]);
    expect(sizes[at]).toBeGreaterThan(1_024);
    expect(sizes[at]).toBeLessThan(262_144);
  });
});

describe('computeStats: every benefit has a cost', () => {
  const bytesList = Array.from({ length: 1_000 }, () => randomBytes());

  it('never lowers drag when an appendage is added', () => {
    let tested = 0;
    for (const bytes of bytesList) {
      const free = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8'].find((id) => {
        const at = locus(id).offset;
        return (
          ((bytes[at] as number) & 1) === 0 && ((bytes[HAPLOTYPE_BYTES + at] as number) & 1) === 0
        );
      });
      if (!free) continue;
      const added = bytes.slice();
      for (const hap of [0, HAPLOTYPE_BYTES]) {
        const at = hap + locus(free).offset;
        added[at] = 1;
        for (let k = 1; k <= 14; k++) added[at + k] = (rng.nextU32() & 0xff) | 0;
      }
      const before = buildCreature(decodeGenome(bytes));
      const after = buildCreature(decodeGenome(added));
      // The caps trim parts from the end of the list, so only compare when nothing was lost.
      const kept = (m: number) => after.plan.appendages.filter((a) => a.module === m).length;
      const lost = before.plan.appendages.some(
        (a) => kept(a.module) < before.plan.appendages.filter((b) => b.module === a.module).length,
      );
      if (lost || after.plan.appendages.length <= before.plan.appendages.length) continue;
      tested++;
      expect(after.stats.drag).toBeGreaterThanOrEqual(before.stats.drag - 1e-12);
    }
    expect(tested).toBeGreaterThan(100);
  });

  it('prices plating in mass, basal cost and turning', () => {
    for (const bytes of bytesList) {
      const plain = statsOf(withLoci(bytes, { plating1: 0, plating2: 0 }));
      const plated = statsOf(withLoci(bytes, { plating1: 200, plating2: 200 }));
      expect(plated.combat.armour).toBeGreaterThan(plain.combat.armour);
      expect(plated.mass).toBeGreaterThan(plain.mass);
      expect(plated.basal).toBeGreaterThan(plain.basal);
      expect(plated.turn).toBeLessThan(plain.turn);
    }
  });

  it('prices segments in the basal multiplier', () => {
    let tested = 0;
    for (const bytes of bytesList) {
      const one = buildCreature(decodeGenome(withLoci(bytes, { segDrive1: 0, segDrive2: 0 })));
      const many = buildCreature(decodeGenome(withLoci(bytes, { segDrive1: 255, segDrive2: 255 })));
      if (one.plan.appendages.length !== many.plan.appendages.length) continue;
      tested++;
      expect(many.plan.segments.length).toBeGreaterThan(one.plan.segments.length);
      expect(many.stats.basal).toBeGreaterThan(one.stats.basal);
    }
    expect(tested).toBeGreaterThan(50);
  });

  it('prices luminescence in the basal multiplier', () => {
    for (const bytes of bytesList) {
      const dark = statsOf(withLoci(bytes, { luminescence: 0 }));
      const lit = statsOf(withLoci(bytes, { luminescence: 1 }));
      expect(lit.basal).toBeGreaterThan(dark.basal);
      expect(lit.glow).toBeGreaterThan(dark.glow);
    }
  });
});

describe('archetypes: nobody wins everything', () => {
  const sizes = [100, 3_000, 30_000];
  const names = Object.keys(ARCHETYPES);
  const table = sizes.map((size) =>
    Object.fromEntries(names.map((n) => [n, metricsAt(ARCHETYPES[n] as Genome, size)])),
  );

  it('measures finite numbers', () => {
    for (const row of table) finite(row);
  });

  it('makes each archetype best at one metric at some size', () => {
    for (const name of names) {
      const wins = table.some((row) =>
        METRICS.some((m) =>
          names.every(
            (n) =>
              (row[name] as Record<Metric, number>)[m] >= (row[n] as Record<Metric, number>)[m],
          ),
        ),
      );
      expect(wins, `${name} is never best`).toBe(true);
    }
  });

  it('makes each archetype worst at one metric at some size', () => {
    for (const name of names) {
      const loses = table.some((row) =>
        METRICS.some((m) =>
          names.every(
            (n) =>
              (row[name] as Record<Metric, number>)[m] <= (row[n] as Record<Metric, number>)[m],
          ),
        ),
      );
      expect(loses, `${name} is never worst`).toBe(true);
    }
  });

  it('gives nobody more than 3 of the 8 metrics at any size', () => {
    table.forEach((row, i) => {
      for (const name of names) {
        const best = METRICS.filter((m) =>
          names.every(
            (n) =>
              (row[name] as Record<Metric, number>)[m] >= (row[n] as Record<Metric, number>)[m],
          ),
        );
        expect(best.length, `${name} at ${sizes[i]}: ${best.join()}`).toBeLessThanOrEqual(3);
      }
    });
  });
});

describe('starter genome', () => {
  it('reproduces the M1 cell', () => {
    const c = buildCreature(starterGenome());
    const p = c.phys;
    for (const k of ['thrust', 'drag', 'turn', 'basal', 'growth', 'maxBiomass'] as const) {
      expect(p[k] / STARTER_PHYS[k], k).toBeGreaterThan(0.99);
      expect(p[k] / STARTER_PHYS[k], k).toBeLessThan(1.01);
    }
    expect(p.maxBiomass).toBeCloseTo(400, 0);
    expect(p.mouth).toEqual(STARTER_PHYS.mouth);
    expect(p.colliders).toEqual(STARTER_PHYS.colliders);
  });

  it('is a single cell with a whip', () => {
    const c = buildCreature(starterGenome());
    expect(c.plan.segments).toHaveLength(1);
    expect(c.plan.appendages.length).toBeGreaterThan(0);
    expect(c.plan.plates).toEqual([]);
  });
});

describe('stats: golden vectors', () => {
  const r = createRng(seedFromString('genome-stats-golden'), 'bytes');
  const inputs: Record<string, Uint8Array> = { ...extremes };
  for (let i = 0; Object.keys(inputs).length < 20; i++) {
    inputs[`random${i}`] = Uint8Array.from({ length: GENOME_BYTES }, () => r.nextU32() & 0xff);
  }
  const file = new URL('./__golden__/stats.json', import.meta.url);

  const compute = () =>
    Object.fromEntries(
      Object.entries(inputs).map(([name, bytes]) => {
        const g = decodeGenome(bytes);
        const c = buildCreature(g);
        return [
          name,
          {
            genome: genomeToBase64url(g),
            planHash: hashPlan(c.plan),
            statsHash: hashStats(c.stats),
          },
        ];
      }),
    );

  it('keeps 20 fixed genomes frozen per rules version', () => {
    expect(Object.keys(inputs)).toHaveLength(20);
    if (process.env.UPDATE_GOLDENS === '1') {
      writeFileSync(
        file,
        `${JSON.stringify({ rulesVersion: RULES_VERSION, vectors: compute() }, null, 2)}\n`,
      );
    }
    const golden = JSON.parse(readFileSync(file, 'utf8')) as {
      rulesVersion: number;
      vectors: unknown;
    };
    expect(golden.rulesVersion).toBe(RULES_VERSION);
    expect(compute()).toEqual(golden.vectors);
  });
});
