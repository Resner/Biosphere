import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ARCHETYPES,
  buildBytes,
  locus,
  METRICS,
  type Metric,
  metricsAt,
  withLoci,
} from '../../tests/archetypes';
import { STARTER_PHYS, sanitizePhys } from '../sim/body';
import { createRng, seedFromString } from '../sim/prng';
import { RULES, RULES_VERSION } from '../sim/rules';
import { decodeGenome, type Genome, genomeToBase64url } from './codec';
import { develop, hashPlan } from './develop';
import { express } from './express';
import { genesisGenome } from './genesis';
import { mutateGenome } from './inherit';
import {
  GENOME_BYTES,
  HAPLOTYPE_BYTES,
  MODULE_EXT_BYTES,
  MODULE_LOCI,
  MODULE_PARAMS,
} from './karyotype';
import { starterGenome } from './starter';
import {
  bandSpeed,
  buildCreature,
  type Creature,
  computeStats,
  formSpeed,
  hashStats,
  type Stats,
  statsAt,
} from './stats';

const rng = createRng(seedFromString('genome-stats-tests'), 'bytes');
const randomBytes = (): Uint8Array =>
  Uint8Array.from({ length: GENOME_BYTES }, () => rng.nextU32() & 0xff);

/**
 * A copy with every module's fine-part extension at 0 (M6 T8). Webs and the setae cap depend on
 * where the parts sit, so the v1 and T7 properties below compare bare parts; the fine parts have
 * their own properties here and in `develop-detail.test.ts`.
 */
const bare = (bytes: Uint8Array): Uint8Array => {
  const out = bytes.slice();
  for (const hap of [0, HAPLOTYPE_BYTES]) {
    for (const m of MODULE_LOCI) out.fill(0, hap + m.ext, hap + m.ext + MODULE_EXT_BYTES);
  }
  return out;
};

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
        Object.fromEntries(MODULE_PARAMS.map((p) => [p, 255])),
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

  it('develops and measures in under 0.15 ms at the median', () => {
    const traits = Array.from({ length: 1000 }, () => express(decodeGenome(randomBytes())));
    // Warm up until the JIT has settled: the first passes cost up to twice the steady speed.
    for (let pass = 0; pass < 3; pass++) for (const t of traits) computeStats(develop(t), t);
    // The best of nine runs, so that a busy runner (other test files run in parallel) does not fail
    // the build: the code's own speed is about 0.08 ms standalone (ADR 0030).
    const median = Math.min(
      ...Array.from({ length: 9 }, () => {
        const times = traits.map((t) => {
          const start = performance.now();
          computeStats(develop(t), t);
          return performance.now() - start;
        });
        times.sort((a, b) => a - b);
        return times[500] as number;
      }),
    );
    expect(median).toBeLessThan(0.15);
  });

  it('is deterministic and plain data', () => {
    const g = decodeGenome(randomBytes());
    const a = buildCreature(g);
    const b = buildCreature(structuredClone(g));
    expect(a.hash).toBe(b.hash);
    expect(hashStats(structuredClone(a.stats))).toBe(hashStats(b.stats));
    expect(JSON.parse(JSON.stringify(a.phys))).toEqual(a.phys);
  });

  it('hashes every number in the stats', () => {
    const stats = buildCreature(
      decodeGenome(
        buildBytes({ M1: { length: 100, thickness: 100, beat: 200 } }, { mouthType: 255 }),
      ),
    ).stats;
    const base = hashStats(stats);
    const leaves = (value: unknown, path: string[] = []): string[][] =>
      typeof value === 'number'
        ? [path]
        : typeof value === 'object' && value !== null
          ? Object.entries(value).flatMap(([k, v]) => leaves(v, [...path, k]))
          : [];
    for (const path of leaves(stats)) {
      const copy = structuredClone(stats);
      let holder = copy as unknown as Record<string, unknown>;
      for (const key of path.slice(0, -1)) holder = holder[key] as Record<string, unknown>;
      const last = path[path.length - 1] as string;
      holder[last] = (holder[last] as number) + 0.5;
      expect(hashStats(copy), path.join('.')).not.toBe(base);
    }
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
    // The band eases the top speed, so the load is read from what form alone gives.
    const formOf = (bytes: Uint8Array): number => {
      const c = buildCreature(decodeGenome(bytes));
      return formSpeed(c.plan, c.traits, c.traits.body.maxBiomass);
    };
    expect(formOf(withLoci(base, { L3: 1 })) / formOf(base)).toBeCloseTo(
      RULES.genes.lof.beatStrength,
      9,
    );
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

describe('the top-speed band (ADR 0036)', () => {
  const band = RULES.stats.speedBand;
  const sizes = (max: number): number[] => [80, max * 0.25, max * 0.5, max];
  const speedOf = (c: Creature, biomass: number): number => {
    const s = statsAt(c.plan, c.traits, biomass);
    return s.thrust / s.drag;
  };
  const mutants = (n: number): Genome[] =>
    Array.from({ length: n }, (_, i) =>
      mutateGenome(decodeGenome(randomBytes()), seedFromString(`speed-band-${i}`), {
        mutation: 1 + (i % 4),
      }),
    );

  it('is the identity in the middle, strictly increasing and inside the limits', () => {
    expect(bandSpeed(band.softLow)).toBe(band.softLow);
    expect(bandSpeed(1.05)).toBe(1.05);
    expect(bandSpeed(band.softHigh)).toBe(band.softHigh);
    let last = 0;
    let broken = 0;
    for (let v = 0.001; v <= 200; v += 0.01) {
      const out = bandSpeed(v);
      if (!(out >= band.min && out <= band.max && out > last)) broken++;
      last = out;
    }
    expect(broken).toBe(0);
    // Nothing reaches the limit itself: the lowest a body can be is a speed multiplier of 0.
    expect(bandSpeed(0)).toBeGreaterThanOrEqual(band.min);
    expect(bandSpeed(0)).toBeLessThan(band.softLow);
    expect(bandSpeed(Number.NaN)).toBeGreaterThanOrEqual(band.min);
    expect(bandSpeed(1e9)).toBeLessThanOrEqual(band.max);
    expect(bandSpeed(Number.POSITIVE_INFINITY)).toBe(band.max);
  });

  it('keeps 10,000 random and 10,000 mutated genomes within 0.6-1.6x the starter at four sizes', () => {
    const genomes = [
      ...Array.from({ length: 10_000 }, () => decodeGenome(randomBytes())),
      ...mutants(10_000),
    ];
    let outside = 0;
    for (const g of genomes) {
      const c = buildCreature(g);
      for (const b of sizes(c.traits.body.maxBiomass)) {
        const v = speedOf(c, b);
        // A dash adds speed × √(thrust ÷ drag): √0.6 to √1.6 of the starter's.
        if (!(v >= band.min && v <= band.max)) outside++;
      }
    }
    expect(outside).toBe(0);
  }, 60_000);

  it('never makes the faster of two bodies the slower', () => {
    const made = Array.from({ length: 600 }, () => buildCreature(decodeGenome(randomBytes())));
    for (const b of [80, 400, 4_000]) {
      const rows = made
        .map((c) => ({ before: formSpeed(c.plan, c.traits, b), after: speedOf(c, b) }))
        .sort((x, y) => x.before - y.before);
      for (let i = 1; i < rows.length; i++) {
        expect((rows[i] as (typeof rows)[0]).after).toBeGreaterThanOrEqual(
          (rows[i - 1] as (typeof rows)[0]).after,
        );
      }
    }
  });

  it('leaves the starter, and a body inside the middle, as form made it', () => {
    const c = buildCreature(starterGenome());
    expect(c.phys.thrust).toBeCloseTo(1, 12);
    expect(c.phys.drag).toBeCloseTo(1, 12);
    expect(speedOf(c, c.traits.body.maxBiomass)).toBeCloseTo(1, 12);
  });

  it('gives genesis hatchlings a median of 1.0-1.3x the starter and a p10 of at least 0.7x', () => {
    const hatch = RULES.mating.hatchlingMinBiomass;
    const speeds = Array.from({ length: 1_000 }, (_, i) => {
      const c = buildCreature(genesisGenome(seedFromString(`speed-genesis-${i}`)));
      // The sim gives a body its adult phys at every size; only the scale term changes with biomass.
      return (
        (c.phys.thrust / c.phys.drag) * (hatch / RULES.starter.biomass) ** RULES.movement.thrustExp
      );
    });
    speeds.sort((x, y) => x - y);
    const starter = (hatch / RULES.starter.biomass) ** RULES.movement.thrustExp;
    expect((speeds[500] as number) / starter).toBeGreaterThanOrEqual(1);
    expect((speeds[500] as number) / starter).toBeLessThanOrEqual(1.3);
    expect((speeds[100] as number) / starter).toBeGreaterThanOrEqual(0.7);
  });
});

describe('computeStats: every benefit has a cost', () => {
  const bytesList = Array.from({ length: 1_000 }, () => bare(randomBytes()));

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

describe('computeStats: development v2 follows form (ADR 0025)', () => {
  const bytesList = Array.from({ length: 1_000 }, () =>
    withLoci(bare(randomBytes()), {
      curve: 0,
      curveMode: 0,
      fusion: 0,
      symmetry: 0,
      drape: 0,
      eyeSize: 0,
      eyeStalk: 0,
    }),
  );
  const build = (bytes: Uint8Array) => buildCreature(decodeGenome(bytes));
  // Curling or ringing can free a part that the bounds had clamped, which is a different body; the
  // comparisons below keep to bodies whose parts are the same before and after.
  const parts = (c: ReturnType<typeof build>): string =>
    c.plan.appendages
      .map((a) => a.length * a.width)
      .sort((x, y) => x - y)
      .join();

  it('makes a curl turn faster and swim draggier', () => {
    let tested = 0;
    // Few random bodies keep every part's length when they curl, so this draws more of them.
    for (const bytes of [...bytesList, ...bytesList.map((b) => withLoci(b, { segDrive1: 255 }))]) {
      const straight = build(bytes);
      if (straight.plan.segments.length < 3) continue;
      const curled = build(withLoci(bytes, { curve: 230 }));
      if (parts(curled) !== parts(straight)) continue;
      tested++;
      expect(curled.stats.turn).toBeGreaterThan(straight.stats.turn);
      expect(curled.stats.drag).toBeGreaterThan(straight.stats.drag);
    }
    expect(tested).toBeGreaterThan(80);
  });

  it('makes a carapace add armour and mass to an unplated body, and stiffen it', () => {
    for (const bytes of bytesList) {
      const plain = build(withLoci(bytes, { plating1: 0, plating2: 0 }));
      const shelled = build(withLoci(bytes, { plating1: 0, plating2: 0, fusion: 255 }));
      expect(shelled.stats.combat.armour).toBeGreaterThan(plain.stats.combat.armour);
      expect(shelled.stats.mass).toBeGreaterThan(plain.stats.mass);
      expect(shelled.plan.flexibility).toBeLessThanOrEqual(plain.plan.flexibility);
    }
  });

  it('makes a radial body turn better and thrust worse forward', () => {
    let tested = 0;
    for (const bytes of bytesList) {
      const bilateral = build(bytes);
      const radial = build(withLoci(bytes, { symmetry: 255 }));
      // Ringing moves every part to the core, so only the number of parts can stay the same.
      if (radial.plan.appendages.length !== bilateral.plan.appendages.length) continue;
      tested++;
      expect(radial.stats.turn).toBeGreaterThan(bilateral.stats.turn);
      // Read before the speed band, which eases a fast form toward the same limit.
      const speed = (c: Creature): number => formSpeed(c.plan, c.traits, c.traits.body.maxBiomass);
      expect(speed(radial)).toBeLessThan(speed(bilateral));
    }
    expect(tested).toBeGreaterThan(100);
  });

  it('makes eyes widen the detection ring and cost metabolism', () => {
    for (const bytes of bytesList) {
      const blind = build(bytes);
      const eyed = build(withLoci(bytes, { eyeSize: 200, eyeStalk: 128 }));
      expect(eyed.stats.sense).toBeGreaterThan(blind.stats.sense);
      expect(eyed.stats.basal).toBeGreaterThan(blind.stats.basal);
    }
  });

  /** `bytes` with one extension byte set on every module slot, in both haplotypes. */
  const withExt = (bytes: Uint8Array, k: number, value: number): Uint8Array => {
    const out = bytes.slice();
    for (const hap of [0, HAPLOTYPE_BYTES])
      for (const m of MODULE_LOCI) out[hap + m.ext + k] = value;
    return out;
  };
  const EXT = { webbing: 0, setaeDensity: 1, setaeLength: 2, bulb: 3, chela: 4, beads: 5 };

  it('prices every fine part: never lighter, cheaper or less draggy (M6 T8)', () => {
    let webbed = 0;
    for (const bytes of bytesList) {
      const plain = build(bytes);
      const web = build(withExt(bytes, EXT.webbing, 255));
      const hairy = build(withExt(withExt(bytes, EXT.setaeDensity, 255), EXT.setaeLength, 128));
      const bulbs = build(withExt(bytes, EXT.bulb, 255));
      const claws = build(withExt(bytes, EXT.chela, 255));
      const beads = build(withExt(bytes, EXT.beads, 255));
      // Webbing and setae never move a part; a bulb can shorten one to make room.
      expect(parts(web)).toBe(parts(plain));
      expect(parts(hairy)).toBe(parts(plain));
      if (web.plan.membranes.length > 0) {
        webbed++;
        expect(web.stats.drag).toBeGreaterThan(plain.stats.drag);
        expect(web.stats.mass).toBeGreaterThan(plain.stats.mass);
        expect(web.stats.basal).toBeGreaterThan(plain.stats.basal);
      }
      expect(hairy.stats.drag).toBeGreaterThan(plain.stats.drag);
      expect(hairy.stats.basal).toBeGreaterThan(plain.stats.basal);
      expect(hairy.stats.sense).toBeGreaterThan(plain.stats.sense);
      expect(bulbs.stats.basal).toBeGreaterThan(plain.stats.basal);
      expect(bulbs.stats.combat.spines).toBeGreaterThanOrEqual(plain.stats.combat.spines);
      expect(claws.stats.basal).toBeGreaterThanOrEqual(plain.stats.basal);
      expect(claws.stats.mass).toBeGreaterThanOrEqual(plain.stats.mass);
      expect(beads.stats.basal).toBeGreaterThan(plain.stats.basal);
    }
    expect(webbed).toBeGreaterThan(300);
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

  it('gives nobody more than 3 of the 9 metrics at any size', () => {
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
