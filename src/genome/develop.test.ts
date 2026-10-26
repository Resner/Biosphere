import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { STARTER_PHYS, sanitizePhys } from '../sim/body';
import { lerp } from '../sim/math';
import { createRng, seedFromString } from '../sim/prng';
import { RULES, RULES_VERSION } from '../sim/rules';
import { decodeGenome, type Genome } from './codec';
import {
  type BodyPlan,
  bodyViolations,
  develop,
  estimateVertices,
  hashPlan,
  motileArea,
} from './develop';
import { express } from './express';
import { mutateGenome } from './inherit';
import { GENOME_BYTES, HAPLOTYPE_BYTES, LOCI, MODULE_PARAMS } from './karyotype';

const D = RULES.develop;
const rng = createRng(seedFromString('genome-develop-tests'), 'bytes');

const randomBytes = (): Uint8Array =>
  Uint8Array.from({ length: GENOME_BYTES }, () => rng.nextU32() & 0xff);

const plan = (g: Genome): BodyPlan => develop(express(g));

const locus = (id: string) => LOCI.find((l) => l.id === id) as (typeof LOCI)[number];

type Params = Partial<Record<(typeof MODULE_PARAMS)[number], number>>;

/** Bytes of an all-zero genome with the given modules present in both haplotypes and `set` loci raised. */
function build(
  modules: Record<string, Params> = {},
  set: Record<string, number> = {},
  base = 0,
): Uint8Array {
  const bytes = new Uint8Array(GENOME_BYTES).fill(base);
  for (let hap = 0; hap < 2; hap++) {
    const at = hap * HAPLOTYPE_BYTES;
    for (const [id, v] of Object.entries(set)) bytes[at + locus(id).offset] = v;
    for (const [id, params] of Object.entries(modules)) {
      const o = at + locus(id).offset;
      bytes[o] = 1;
      MODULE_PARAMS.forEach((name, k) => {
        bytes[o + 1 + k] = params[name] ?? 0;
      });
    }
  }
  return bytes;
}

const MODULE_IDS = LOCI.filter((l) => l.kind === 'module').map((l) => l.id);

function allModules(value: number): Record<string, Params> {
  const params = Object.fromEntries(MODULE_PARAMS.map((p) => [p, value])) as Params;
  return Object.fromEntries(MODULE_IDS.map((id) => [id, params]));
}

/** A cruder stand-in for `mutateGenome`: flips 1-6 random bytes of a random genome. */
function flipped(): Uint8Array {
  const bytes = randomBytes();
  const flips = 1 + (rng.nextU32() % 6);
  for (let i = 0; i < flips; i++) bytes[rng.nextU32() % GENOME_BYTES] = rng.nextU32() & 0xff;
  return bytes;
}

const extremes: Record<string, Uint8Array> = {
  zero: new Uint8Array(GENOME_BYTES),
  ones: new Uint8Array(GENOME_BYTES).fill(0xff),
  alternating: Uint8Array.from({ length: GENOME_BYTES }, (_, i) => (i % 2 ? 0xff : 0)),
  modulesZero: build(allModules(0)),
  modulesFull: build(allModules(255)),
  eightSegmentsModulesFull: build(allModules(255), { segDrive1: 255, segDrive2: 255 }),
};

const complete = (name: string, g: Genome): void => {
  const p = plan(g);
  const bad = bodyViolations(p);
  expect(bad, name).toEqual([]);
};

describe('develop: caps and guarantees', () => {
  it('agrees with the body limits the sim enforces', () => {
    expect(D.caps.colliders).toBe(RULES.body.maxColliders);
    expect(D.caps.bounds).toBe(RULES.body.maxReach);
    expect(D.caps.segments).toBe(RULES.genes.segments);
  });

  it('repairs 10,000 random genomes into valid plans', () => {
    for (let i = 0; i < 10_000; i++) {
      const p = plan(decodeGenome(randomBytes()));
      const bad = bodyViolations(p);
      if (bad.length > 0) expect(bad, `random genome ${i}`).toEqual([]);
    }
  });

  it('repairs 10,000 byte-flipped genomes into valid plans', () => {
    for (let i = 0; i < 10_000; i++) {
      const bad = bodyViolations(plan(decodeGenome(flipped())));
      if (bad.length > 0) expect(bad, `flipped genome ${i}`).toEqual([]);
    }
  });

  it('repairs 10,000 random genomes after mutateGenome at mutation ×4', () => {
    for (let i = 0; i < 10_000; i++) {
      const g = mutateGenome(decodeGenome(randomBytes()), seedFromString(`mutated-${i}`), {
        mutation: 4,
      });
      const bad = bodyViolations(plan(g));
      if (bad.length > 0) expect(bad, `mutated genome ${i}`).toEqual([]);
    }
  });

  it('repairs the extreme genomes', () => {
    for (const [name, bytes] of Object.entries(extremes)) complete(name, decodeGenome(bytes));
  });

  it('keeps meshes inside the vertex budget', () => {
    const genomes = [
      ...Object.values(extremes),
      ...Array.from({ length: 2_000 }, () => randomBytes()),
    ].map((b) => plan(decodeGenome(b)));
    for (const p of genomes) {
      expect(estimateVertices(p, 'full')).toBeLessThanOrEqual(D.vertices.full.cap);
      expect(estimateVertices(p, 'low')).toBeLessThanOrEqual(D.vertices.low.cap);
    }
  });

  it('is plain data: a clone hashes the same and nothing is NaN', () => {
    const p = plan(decodeGenome(randomBytes()));
    expect(hashPlan(structuredClone(p))).toBe(hashPlan(p));
    expect(JSON.stringify(p)).not.toMatch(/null|NaN/);
  });

  it('is deterministic', () => {
    const g = decodeGenome(randomBytes());
    expect(plan(g)).toEqual(plan(g));
  });

  it('builds the segments the traits ask for, with the core first', () => {
    const one = plan(decodeGenome(build({}, {})));
    expect(one.segments).toHaveLength(1);
    expect(one.colliders[0]).toEqual({ x: 0, y: 0, r: 1 });
    const eight = plan(decodeGenome(build({}, { segDrive1: 255, segDrive2: 255 })));
    expect(eight.segments).toHaveLength(8);
    const xs = eight.segments.map((s) => s.x);
    expect([...xs].sort((a, b) => b - a)).toEqual(xs);
    expect(new Set(xs).size).toBe(8);
  });

  it('keeps the colliders symmetric, pair by pair', () => {
    for (let n = 1; n <= 8; n++) {
      const seg = Math.round(((n - 1) / 7) * 255);
      const p = plan(
        decodeGenome(build(allModules(255), { segDrive1: seg, segDrive2: seg, aspect: 40 })),
      );
      const rest = p.colliders.slice(p.segments.length);
      expect(rest.length % 2, `${n} segments`).toBe(0);
      for (let i = 0; i < rest.length; i += 2) {
        const [l, r] = [rest[i], rest[i + 1]] as BodyPlan['colliders'];
        expect(r).toEqual({
          x: (l as { x: number }).x,
          y: -(l as { y: number }).y,
          r: (l as { r: number }).r,
        });
      }
    }
  });

  it('hands the rules a body they accept as it is', () => {
    for (let i = 0; i < 500; i++) {
      const p = plan(decodeGenome(randomBytes()));
      const phys = { ...STARTER_PHYS, mouth: p.mouth, colliders: p.colliders };
      expect(sanitizePhys(phys)).toEqual(phys);
    }
  });
});

describe('develop: repairs', () => {
  const slot = (id: string, params: Params): Record<string, Params> => ({ [id]: params });

  it('adds a ciliary band when nothing propels', () => {
    const p = plan(decodeGenome(new Uint8Array(GENOME_BYTES)));
    expect(p.appendages.length).toBeGreaterThan(0);
    expect(p.appendages.every((a) => a.module === -1)).toBe(true);
    expect(motileArea(p.appendages)).toBeGreaterThanOrEqual(D.minThrustArea);
    // A present module that never beats is not propulsion either.
    const still = plan(decodeGenome(build(slot('M1', { length: 200, thickness: 200 }))));
    expect(still.appendages.some((a) => a.module === -1)).toBe(true);
  });

  it('leaves a body that already swims alone', () => {
    const p = plan(
      decodeGenome(build(slot('M1', { length: 200, thickness: 200, beat: 255, joints: 100 }))),
    );
    expect(p.appendages.every((a) => a.module === 0)).toBe(true);
    expect(p.appendages).toHaveLength(2);
  });

  it('puts the mouth at the front', () => {
    for (const type of [0, 128, 255]) {
      const m = plan(decodeGenome(build({}, { mouthType: type, mouthSize: 255 }))).mouth;
      expect(m.offset).toBeGreaterThanOrEqual(0);
      expect(m.radius).toBeGreaterThan(0);
      expect(m.arc).toBeGreaterThan(0);
    }
    const filter = plan(decodeGenome(build({}, { mouthType: 0, mouthSize: 255 }))).mouth;
    const jaw = plan(decodeGenome(build({}, { mouthType: 255, mouthSize: 255 }))).mouth;
    expect(filter.radius).toBeGreaterThan(jaw.radius);
    expect(jaw.offset).toBeGreaterThan(filter.offset);
    expect(jaw.arc).toBeLessThan(filter.arc);
  });

  it('spreads appendages that would sit on top of each other', () => {
    const same: Params = { length: 100, thickness: 100, beat: 200, angle: 0, pairs: 255 };
    const g = decodeGenome(build({ M1: same, M2: same, M3: same }));
    const p = plan(g);
    expect(bodyViolations(p)).toEqual([]);
    const left = p.appendages.filter((a) => a.side === 1).map((a) => a.angle);
    expect(left).toHaveLength(9);
    left.sort((a, b) => a - b);
    for (let i = 1; i < left.length; i++) {
      expect((left[i] as number) - (left[i - 1] as number)).toBeGreaterThanOrEqual(
        D.minAngleGap - 1e-9,
      );
    }
    // The first keeps its angle and the rest fan out behind it.
    expect(left[0]).toBeCloseTo(D.angleMargin, 9);
  });

  it('merges what cannot be spread', () => {
    const same: Params = { length: 100, thickness: 100, beat: 200, angle: 250, pairs: 255 };
    const p = plan(decodeGenome(build({ M1: same, M2: same, M3: same, M4: same })));
    expect(bodyViolations(p)).toEqual([]);
    const left = p.appendages.filter((a) => a.side === 1);
    expect(left.length).toBeLessThan(12);
    const [lo, hi] = D.width as readonly [number, number];
    expect(Math.max(...left.map((a) => a.width))).toBeGreaterThan(lerp(lo, hi, 100 / 255));
  });

  it('clamps lengths so the bounds hold', () => {
    const long: Params = {
      length: 255,
      thickness: 255,
      beat: 255,
      branching: 255,
      attachStart: 255,
      angle: 128,
    };
    const g = decodeGenome(
      build(
        { M1: long, M2: { ...long, angle: 0 }, M3: { ...long, angle: 255 } },
        { segDrive1: 255, segDrive2: 255 },
      ),
    );
    const p = plan(g);
    expect(bodyViolations(p)).toEqual([]);
    const raw = D.length[1] as number;
    expect(Math.max(...p.appendages.map((a) => a.length))).toBeLessThan(raw);
  });

  it('trims appendages in module order, never by anything else', () => {
    const p = plan(decodeGenome(extremes.eightSegmentsModulesFull as Uint8Array));
    expect(p.appendages.length).toBeLessThanOrEqual(D.caps.appendages);
    const modules = p.appendages.map((a) => a.module);
    expect([...modules].sort((a, b) => a - b)).toEqual(modules);
    expect(p.appendages.length % 2).toBe(0);
    for (let i = 0; i < p.appendages.length; i += 2) {
      const [l, r] = [p.appendages[i], p.appendages[i + 1]];
      expect(l?.side).toBe(1);
      expect({ ...r, side: 1 }).toEqual(l);
    }
  });

  it('shrinks the malformed part under a homozygous L2 loss of function', () => {
    const m: Params = { length: 200, thickness: 200, beat: 255 };
    const fine = plan(decodeGenome(build({ M1: m, M2: m })));
    const bytes = build({ M1: m, M2: m }, { L2: 1 });
    const bad = plan(decodeGenome(bytes));
    const firstOf = (p: BodyPlan, module: number) => p.appendages.find((a) => a.module === module);
    expect(firstOf(bad, 0)?.length).toBeCloseTo(
      (firstOf(fine, 0)?.length as number) * RULES.genes.lof.partScale,
      9,
    );
    expect(firstOf(bad, 1)?.length).toBe(firstOf(fine, 1)?.length);
  });

  it('plates the segments by the plating trait', () => {
    expect(plan(decodeGenome(build())).plates).toEqual([]);
    const plated = plan(
      decodeGenome(build({}, { plating1: 255, plating2: 255, segDrive1: 255, segDrive2: 255 })),
    );
    expect(plated.plates).toHaveLength(8);
    expect(plated.plates[0]?.coverage).toBe(1);
  });
});

describe('bodyViolations: each rule', () => {
  const base = (): BodyPlan =>
    plan(decodeGenome(build({ M1: { length: 200, thickness: 200, beat: 255, pairs: 255 } })));
  const first = (p: BodyPlan) => p.appendages[0] as BodyPlan['appendages'][number];

  it('accepts a developed plan', () => {
    expect(bodyViolations(base())).toEqual([]);
  });

  it('flags too many segments', () => {
    const p = base();
    for (let i = 0; i < 9; i++) p.segments.push({ x: -0.1 * i, rx: 0.1, ry: 0.1 });
    expect(bodyViolations(p).join()).toMatch(/segments/);
  });

  it('flags overlapping appendages', () => {
    const p = base();
    p.appendages.push({ ...first(p) }, { ...first(p), side: -1 });
    expect(bodyViolations(p).join()).toMatch(/overlap/);
  });

  it('flags too many appendages, joints and branches', () => {
    const p = base();
    p.appendages = Array.from({ length: 26 }, (_, i) => ({ ...first(p), angle: 0.3 + 0.1 * i }));
    expect(bodyViolations(p).join()).toMatch(/appendages: 26/);
    const q = base();
    first(q).joints = 5;
    first(q).branches = 3;
    const text = bodyViolations(q).join();
    expect(text).toMatch(/joints/);
    expect(text).toMatch(/branches/);
  });

  it('flags a missing mouth', () => {
    const p = base();
    p.mouth = { ...p.mouth, radius: 0 };
    expect(bodyViolations(p).join()).toMatch(/mouth/);
    const q = base();
    q.mouth = { ...q.mouth, offset: -0.5 };
    expect(bodyViolations(q).join()).toMatch(/mouth/);
  });

  it('flags a body with no propulsion', () => {
    const p = base();
    for (const a of p.appendages) a.beat = 0;
    expect(bodyViolations(p).join()).toMatch(/propulsion/);
  });

  it('flags oversized bounds', () => {
    const p = base();
    first(p).length = 3;
    expect(bodyViolations(p).join()).toMatch(/bounds/);
  });

  it('flags a bad collider list', () => {
    const p = base();
    p.colliders = [{ x: 0.5, y: 0, r: 1 }];
    expect(bodyViolations(p).join()).toMatch(/core/);
    const q = base();
    q.colliders = Array.from({ length: 13 }, () => ({ x: 0, y: 0, r: 1 }));
    expect(bodyViolations(q).join()).toMatch(/colliders: 13/);
  });

  it('flags a vertex budget overrun', () => {
    const p = base();
    p.appendages = Array.from({ length: 24 }, (_, i) => ({
      ...first(p),
      joints: 4,
      branches: 2,
      angle: 0.3 + 0.1 * i,
    }));
    expect(bodyViolations(p).join()).toMatch(/vertices/);
  });

  it('flags values outside the body limits', () => {
    const p = base();
    first(p).length = 0;
    p.colliders.push({ x: 0.5, y: 0, r: 3 });
    p.mouth = { ...p.mouth, arc: 4 };
    const text = bodyViolations(p).join();
    expect(text).toMatch(/length or width/);
    expect(text).toMatch(/radius 3/);
    expect(text).toMatch(/mouth/);
  });

  it('flags appendages that are not mirrored', () => {
    const p = base();
    p.appendages.pop();
    expect(bodyViolations(p).join()).toMatch(/mirrored/);
    const q = base();
    (q.appendages[1] as BodyPlan['appendages'][number]).angle += 0.1;
    expect(bodyViolations(q).join()).toMatch(/mirrored/);
  });

  it('flags non-finite numbers', () => {
    const p = base();
    first(p).length = Number.NaN;
    expect(bodyViolations(p).join()).toMatch(/malformed/);
  });
});

describe('develop: speed', () => {
  it('develops in well under a tenth of a millisecond at the median', () => {
    const traits = Array.from({ length: 1000 }, () => express(decodeGenome(randomBytes())));
    for (const t of traits) develop(t); // warm up
    // The best of three runs, so that a busy runner does not fail the build.
    const median = Math.min(
      ...[0, 1, 2].map(() => {
        const times = traits.map((t) => {
          const start = performance.now();
          develop(t);
          return performance.now() - start;
        });
        times.sort((a, b) => a - b);
        return times[500] as number;
      }),
    );
    expect(median).toBeLessThan(0.1);
  });
});

describe('develop: golden vectors', () => {
  const inputs: Record<string, Uint8Array> = {};
  const r = createRng(seedFromString('genome-develop-golden'), 'bytes');
  for (const [name, bytes] of Object.entries(extremes)) inputs[name] = bytes;
  for (let i = 0; i < 14; i++) {
    inputs[`random${i}`] = Uint8Array.from({ length: GENOME_BYTES }, () => r.nextU32() & 0xff);
  }
  const file = new URL('./__golden__/develop.json', import.meta.url);
  const compute = (): Record<string, string> =>
    Object.fromEntries(
      Object.entries(inputs).map(([name, bytes]) => [name, hashPlan(plan(decodeGenome(bytes)))]),
    );

  it('has twenty fixed genomes', () => {
    expect(Object.keys(inputs)).toHaveLength(20);
  });

  if (process.env.UPDATE_GOLDENS) {
    writeFileSync(
      file,
      `${JSON.stringify({ rulesVersion: RULES_VERSION, vectors: compute() }, null, 2)}\n`,
    );
  }

  it('matches the committed plan hashes', () => {
    const golden = JSON.parse(readFileSync(file, 'utf8')) as {
      rulesVersion: number;
      vectors: Record<string, string>;
    };
    expect(golden.rulesVersion).toBe(RULES_VERSION);
    expect(compute()).toEqual(golden.vectors);
  });
});
