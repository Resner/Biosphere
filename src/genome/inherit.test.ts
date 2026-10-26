import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createRng, type Rng, type Seed, seedFromString } from '../sim/prng';
import { RULES, RULES_VERSION } from '../sim/rules';
import { decodeGenome, encodeGenome, type Genome, genomeHash } from './codec';
import { bodyViolations, develop } from './develop';
import { express } from './express';
import { genesisGenome } from './genesis';
import {
  applyMutation,
  breed,
  MUTATION_KINDS,
  type MutationKind,
  meiosis,
  mutateGenome,
  mutateHaplotype,
  offspringSeed,
} from './inherit';
import { HAPLOTYPE_BYTES, LOCI, MODULE_BYTES } from './karyotype';
import { buildCreature } from './stats';

const G = RULES.genetics;
const seedOf = (label: string, i: number): Seed => seedFromString(`${label}-${i}`);
const parents = new Map<number, Genome>();
const parent = (i: number): Genome => {
  const known = parents.get(i);
  if (known) return known;
  const g = genesisGenome(seedOf('inherit-parent', i));
  parents.set(i, g);
  return g;
};
const locus = (id: string) => LOCI.find((l) => l.id === id) as (typeof LOCI)[number];
const tol = (p: number, n: number): number => 4 * Math.sqrt((p * (1 - p)) / n);
const near = (count: number, p: number, n: number): void => {
  expect(Math.abs(count / n - p), `${count}/${n} vs ${p}`).toBeLessThanOrEqual(tol(p, n));
};

/** `base` with these loci set per haplotype (`[first, second]`). */
function withAlleles(base: Genome, set: Record<string, [number, number]>): Genome {
  const bytes = encodeGenome(base);
  for (const [id, [x, y]] of Object.entries(set)) {
    bytes[locus(id).offset] = x;
    bytes[HAPLOTYPE_BYTES + locus(id).offset] = y;
  }
  return decodeGenome(bytes);
}

const alleleAt = (g: Genome, hap: 0 | 1, id: string): number =>
  g.haplotypes[hap].alleles[locus(id).offset] as number;

const slotAt = (g: Genome, hap: 0 | 1, l: (typeof LOCI)[number]): string =>
  g.haplotypes[hap].alleles.slice(l.offset, l.offset + l.size).join(',');

describe('offspringSeed', () => {
  it('matches a known answer, computed independently with node:crypto', () => {
    expect(offspringSeed(new Uint8Array(32).fill(7), 'commit-1', 0)).toEqual([
      3758602977, 3159663232, 1492754589, 2700271875,
    ]);
  });

  it('differs between slots, commits and randomness', () => {
    const r = new Uint8Array(32).fill(7);
    const s0 = offspringSeed(r, 'commit-1', 0);
    expect(offspringSeed(r, 'commit-1', 1)).not.toEqual(s0);
    expect(offspringSeed(r, 'commit-2', 0)).not.toEqual(s0);
    expect(offspringSeed(new Uint8Array(32).fill(8), 'commit-1', 0)).not.toEqual(s0);
  });
});

describe('breed: structure', () => {
  it('takes haplotype one from a alone and haplotype two from b alone, locus by locus', () => {
    for (let i = 0; i < 1000; i++) {
      const a = parent(2 * i);
      const b = parent(2 * i + 1);
      const child = breed(a, b, seedOf('structure', i), { mutation: 0 });
      for (const l of LOCI) {
        const fromA = [slotAt(a, 0, l), slotAt(a, 1, l)].includes(slotAt(child, 0, l));
        const fromB = [slotAt(b, 0, l), slotAt(b, 1, l)].includes(slotAt(child, 1, l));
        if (!(fromA && fromB)) expect({ pair: i, locus: l.id, fromA, fromB }).toBeNull();
      }
    }
  });

  it('is deterministic and changes with the seed', () => {
    const a = parent(1);
    const b = parent(2);
    const x = breed(a, b, seedOf('det', 0));
    expect(genomeHash(breed(a, b, seedOf('det', 0)))).toBe(genomeHash(x));
    expect(genomeHash(breed(a, b, seedOf('det', 1)))).not.toBe(genomeHash(x));
  });

  it('gives the two slots of a pair different children (99% of 1,000 pairs)', () => {
    const randomness = new Uint8Array(32).fill(3);
    let differ = 0;
    for (let i = 0; i < 1000; i++) {
      const a = parent(2 * i);
      const b = parent(2 * i + 1);
      const c0 = breed(a, b, offspringSeed(randomness, `pair-${i}`, 0));
      const c1 = breed(a, b, offspringSeed(randomness, `pair-${i}`, 1));
      if (genomeHash(c0) !== genomeHash(c1)) differ++;
    }
    expect(differ).toBeGreaterThanOrEqual(990);
  });
});

describe('meiosis: Mendelian ratios', () => {
  const N = 4000;
  const base = parent(0);
  const hetIri = withAlleles(base, { iridescence: [0, 1] });

  it('Aa × Aa gives 3 plain : 1 iridescent and 1 : 2 : 1 genotypes', () => {
    let plain = 0;
    const genotype = [0, 0, 0];
    for (let i = 0; i < N; i++) {
      const c = breed(hetIri, hetIri, seedOf('aa-aa', i), { mutation: 0 });
      if (express(c).skin.iridescence === 'plain') plain++;
      const k = alleleAt(c, 0, 'iridescence') + alleleAt(c, 1, 'iridescence');
      genotype[k] = (genotype[k] as number) + 1;
    }
    near(plain, 0.75, N);
    near(genotype[0] as number, 0.25, N);
    near(genotype[1] as number, 0.5, N);
    near(genotype[2] as number, 0.25, N);
  });

  it('a test cross Aa × aa gives 1 : 1', () => {
    const aa = withAlleles(base, { iridescence: [1, 1] });
    let plain = 0;
    for (let i = 0; i < N; i++) {
      const c = breed(hetIri, aa, seedOf('test-cross', i), { mutation: 0 });
      if (express(c).skin.iridescence === 'plain') plain++;
    }
    near(plain, 0.5, N);
  });

  it('the dihybrid iridescence × albino gives 9 : 3 : 3 : 1', () => {
    const dihybrid = withAlleles(base, { iridescence: [0, 1], albino: [0, 1] });
    const counts: Record<string, number> = {};
    for (let i = 0; i < N; i++) {
      const t = express(breed(dihybrid, dihybrid, seedOf('dihybrid', i), { mutation: 0 }));
      const key = `${t.skin.iridescence}/${t.colour.albino}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    near(counts['plain/normal'] ?? 0, 9 / 16, N);
    near(counts['plain/albino'] ?? 0, 3 / 16, N);
    near(counts['iridescent/normal'] ?? 0, 3 / 16, N);
    near(counts['iridescent/albino'] ?? 0, 1 / 16, N);
  });
});

describe('meiosis: linkage', () => {
  const N = 6000;
  /** A parent whose first haplotype holds 0 at these loci and whose second holds 255. */
  const marked = (ids: string[]): Genome =>
    withAlleles(parent(5), Object.fromEntries(ids.map((id) => [id, [0, 255] as [number, number]])));

  /** The share of gametes whose two loci come from different parental haplotypes. */
  function recombination(a: string, b: string): number {
    const g = marked([a, b]);
    let n = 0;
    for (let i = 0; i < N; i++) {
      const h = meiosis(g, createRng(seedOf('linkage', i), 'meiosis-a'));
      if (h[locus(a).offset] !== h[locus(b).offset]) n++;
    }
    return n / N;
  }

  /** The exact rate for loci `d` apart on a chromosome with `boundaries` boundaries. */
  function predicted(d: number, boundaries: number): number {
    const q = d / boundaries;
    return (G.crossovers[1] as number) * q + (G.crossovers[2] as number) * 2 * q * (1 - q);
  }

  it('neighbours recombine at the rate the crossover model predicts', () => {
    // Chromosome 2 has 8 loci, so 7 boundaries.
    const p = predicted(1, 7);
    expect(Math.abs(recombination('membrane', 'translucency') - p)).toBeLessThan(tol(p, N));
  });

  it('loci near opposite ends recombine in 35-50%', () => {
    // Chromosome 6 has 16 loci, so 15 boundaries; the last quant locus is 14 from the first.
    const r = recombination('hue1', 'pressureTolerance');
    expect(r).toBeGreaterThan(0.35);
    expect(r).toBeLessThan(0.5);
    expect(Math.abs(r - predicted(14, 15))).toBeLessThan(tol(predicted(14, 15), N));
  });

  it('loci on different chromosomes assort independently', () => {
    const r = recombination('segDrive1', 'hue1');
    expect(Math.abs(r - 0.5)).toBeLessThan(tol(0.5, N));
  });
});

describe('mutation', () => {
  const haplotype = (i: number): number[] => [...(parent(i).haplotypes[0]?.alleles ?? [])];

  it('treats a non-finite mutation factor as off', () => {
    const h = [...(parent(1).haplotypes[0]?.alleles ?? [])];
    expect(mutateHaplotype(h, createRng(seedOf('nan', 0), 'm'), Number.NaN)).toEqual([]);
  });

  it('is off at mutation 0 and fires at most three events', () => {
    const events: number[] = [0, 0, 0, 0];
    for (let i = 0; i < 20_000; i++) {
      const h = haplotype(i % 50);
      const before = [...h];
      const off = mutateHaplotype(h, createRng(seedOf('off', i), 'm'), 0);
      if (off.length > 0 || h.some((v, k) => v !== before[k])) expect({ i, off }).toBeNull();
      const n = mutateHaplotype(h, createRng(seedOf('on', i), 'm'), 4).length;
      expect(n).toBeLessThanOrEqual(G.maxEvents);
      events[n] = (events[n] as number) + 1;
    }
    expect(events.reduce((a, b) => a + b, 0)).toBe(20_000);
  });

  it('draws the event count from the binomial in RULES.genetics', () => {
    for (const mutation of [1, 4]) {
      const p = Math.min(1, G.eventChance * mutation);
      const counts = [0, 0, 0, 0];
      const N = 20_000;
      for (let i = 0; i < N; i++) {
        const n = mutateHaplotype(
          haplotype(i % 50),
          createRng(seedOf(`count-${mutation}`, i), 'm'),
          mutation,
        ).length;
        counts[n] = (counts[n] as number) + 1;
      }
      const choose = [1, 3, 3, 1];
      counts.forEach((c, k) => {
        near(c, (choose[k] as number) * p ** k * (1 - p) ** (3 - k), N);
      });
    }
  });

  it('shows every kind, with the weights of RULES.genetics, over 20,000 gametes', () => {
    const seen = new Map<MutationKind, { fired: number; applied: number }>();
    let total = 0;
    for (let i = 0; i < 20_000; i++) {
      for (const e of mutateHaplotype(haplotype(i % 50), createRng(seedOf('kinds', i), 'm'), 1)) {
        const s = seen.get(e.kind) ?? { fired: 0, applied: 0 };
        s.fired++;
        if (e.applied) s.applied++;
        seen.set(e.kind, s);
        total++;
      }
    }
    const weight = MUTATION_KINDS.reduce((sum, k) => sum + G.kinds[k], 0);
    for (const kind of MUTATION_KINDS) {
      const s = seen.get(kind);
      expect(s?.applied, kind).toBeGreaterThan(0);
      near(s?.fired ?? 0, G.kinds[kind] / weight, total);
    }
  });

  it('with mutation 0 gives every child byte a value a parent has there', () => {
    for (let i = 0; i < 1000; i++) {
      const a = parent(i);
      const b = parent(i + 1000);
      const child = breed(a, b, seedOf('no-mutation', i), { mutation: 0 });
      for (let at = 0; at < HAPLOTYPE_BYTES; at++) {
        const byte = (g: Genome, hap: 0 | 1) => g.haplotypes[hap].alleles[at];
        const fromA = byte(child, 0) === byte(a, 0) || byte(child, 0) === byte(a, 1);
        const fromB = byte(child, 1) === byte(b, 0) || byte(child, 1) === byte(b, 1);
        if (!(fromA && fromB)) expect({ pair: i, at, fromA, fromB }).toBeNull();
      }
    }
  });

  it('changes at most three loci per haplotype, whatever the meiosis did', () => {
    let changed = 0;
    for (let i = 0; i < 300; i++) {
      const a = parent(i);
      const b = parent(i + 300);
      const off = breed(a, b, seedOf('isolation', i), { mutation: 0 });
      const on = breed(a, b, seedOf('isolation', i), { mutation: 4 });
      for (const hap of [0, 1] as const) {
        const differing = LOCI.filter((l) => slotAt(off, hap, l) !== slotAt(on, hap, l));
        expect(differing.length).toBeLessThanOrEqual(G.maxEvents);
        changed += differing.length;
      }
    }
    expect(changed).toBeGreaterThan(100);
  });

  it('keeps novel alleles for mutation only: genesis never has them, mutation reaches them', () => {
    const novel = (g: Genome): boolean =>
      LOCI.some(
        (l) =>
          l.kind === 'mendel' &&
          g.haplotypes.some((h) => (h.alleles[l.offset] as number) >= l.novelFrom),
      );
    let genesis = 0;
    let bred = 0;
    for (let i = 0; i < 2000; i++) {
      if (novel(parent(i))) genesis++;
      if (novel(mutateGenome(parent(i), seedOf('novel', i), { mutation: 4 }))) bred++;
    }
    expect(genesis).toBe(0);
    expect(bred).toBeGreaterThan(20);
  });

  it('copies a duplicated module, and the copies then drift apart', () => {
    const rng = createRng(seedOf('dup', 0), 'm');
    const h = [...(parent(3).haplotypes[0]?.alleles ?? [])];
    const slots = LOCI.filter((l) => l.kind === 'module');
    const live = (): typeof slots => slots.filter((l) => h[l.offset] === 1);
    const before = live().map((l) => l.id);
    for (let i = 0; i < 1000 && live().length === before.length; i++)
      applyMutation(h, 'moduleDuplicate', rng);
    const added = live().filter((l) => !before.includes(l.id));
    expect(added).toHaveLength(1);
    const copy = added[0] as (typeof slots)[number];
    const bytes = (l: (typeof slots)[number]): number[] =>
      h.slice(l.offset, l.offset + MODULE_BYTES);
    const original = live().filter((l) => l !== copy && bytes(l).join() === bytes(copy).join());
    expect(original.length).toBeGreaterThanOrEqual(1);
    const twin = original[0] as (typeof slots)[number];
    for (let i = 0; i < 400; i++) applyMutation(h, 'paramDrift', rng);
    expect(bytes(copy)).not.toEqual(bytes(twin));
  });

  it('does nothing when a kind has no target', () => {
    const h = new Array<number>(HAPLOTYPE_BYTES).fill(0);
    const rng = createRng(seedOf('empty', 0), 'm');
    for (const kind of ['paramDrift', 'moduleDuplicate', 'moduleDelete'] as const) {
      expect(applyMutation(h, kind, rng)).toBe(false);
      expect(h.every((v) => v === 0)).toBe(true);
    }
  });
});

describe('mutateGenome', () => {
  it('is deterministic, a no-op at mutation 0, and moves the genome at higher rates', () => {
    const g = parent(9);
    expect(genomeHash(mutateGenome(g, seedOf('lab', 0), { mutation: 0 }))).toBe(genomeHash(g));
    const a = mutateGenome(g, seedOf('lab', 1), { mutation: 4 });
    expect(genomeHash(mutateGenome(g, seedOf('lab', 1), { mutation: 4 }))).toBe(genomeHash(a));
    let moved = 0;
    for (let i = 0; i < 100; i++)
      if (genomeHash(mutateGenome(g, seedOf('lab-moves', i), { mutation: 4 })) !== genomeHash(g))
        moved++;
    expect(moved).toBeGreaterThan(80);
  });
});

/** The path of the first non-finite number inside `value`, or null. */
function notFinite(value: unknown, path: string): string | null {
  if (typeof value === 'number') return Number.isFinite(value) ? null : path;
  if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) {
      const bad = notFinite(v, `${path}.${k}`);
      if (bad) return bad;
    }
  return null;
}

function viable(g: Genome, label: string): void {
  const bad = bodyViolations(develop(express(g)));
  if (bad.length > 0) expect(bad, label).toEqual([]);
  const c = buildCreature(g);
  const bad2 = notFinite(c.traits, `${label}.traits`) ?? notFinite(c.stats, `${label}.stats`);
  if (bad2) expect(bad2).toBeNull();
}

describe('viability', () => {
  it('10,000 children of random genesis pairs are all valid bodies', () => {
    for (let i = 0; i < 10_000; i++)
      viable(breed(parent(i), parent(i + 10_000), seedOf('pairs', i)), `pair ${i}`);
  });

  it('10,000 descendants after 5 generations at mutation ×4 are all valid bodies', () => {
    const pick: Rng = createRng(seedOf('lineage', 0), 'pick');
    let pool = Array.from({ length: 2000 }, (_, i) => parent(i + 50_000));
    for (let gen = 1; gen <= 5; gen++) {
      const size = gen === 5 ? 10_000 : 2000;
      const next: Genome[] = [];
      for (let i = 0; i < size; i++) {
        const a = pool[pick.int(0, pool.length - 1)] as Genome;
        const b = pool[pick.int(0, pool.length - 1)] as Genome;
        const child = breed(a, b, seedOf(`gen-${gen}`, i), { mutation: 4 });
        if (gen === 5) viable(child, `descendant ${i}`);
        next.push(child);
      }
      pool = next;
    }
  });
});

describe('goldens', () => {
  it('matches three committed child hashes', () => {
    const file = new URL('./__golden__/inherit.json', import.meta.url);
    const actual = Object.fromEntries(
      [0, 1, 2].map((i) => [
        `child-${i}`,
        genomeHash(
          breed(
            parent(i),
            parent(i + 100),
            offspringSeed(new Uint8Array(32).fill(i), `golden-${i}`, 0),
          ),
        ),
      ]),
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
