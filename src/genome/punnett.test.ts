import { describe, expect, it } from 'vitest';
import { withAlleles } from '../../tests/archetypes';
import { seedFromString } from '../sim/prng';
import { RULES } from '../sim/rules';
import { decodeGenome, type Genome } from './codec';
import { express } from './express';
import { genesisGenome } from './genesis';
import { breed } from './inherit';
import { HAPLOTYPE_BYTES, LOCI, type MendelLocus } from './karyotype';
import { type PunnettTrait, punnett } from './punnett';
import { starterGenome } from './starter';

const MENDEL = LOCI.filter((l): l is MendelLocus => l.kind === 'mendel');
const LOADS = LOCI.filter((l) => l.kind === 'load');
const mendelById = (id: string): MendelLocus => MENDEL.find((l) => l.id === id) as MendelLocus;
const tol = (p: number, n: number): number => 4 * Math.sqrt((p * (1 - p)) / n);

const base = starterGenome();
const albino = (x: number, y: number): Genome => withAlleles(base, { albino: [x, y] });
const chanceOf = (t: PunnettTrait, value: string): number =>
  t.outcomes.find((o) => o.value === value)?.chance ?? 0;
const trait = (g: Genome, h: Genome, id: string): PunnettTrait =>
  punnett(g, h).traits.find((t) => t.id === id) as PunnettTrait;

// An enumeration written without the codec: two alleles of each parent, four combinations, and the
// dominance rules read straight from the karyotype table.
function enumerate(a: Genome, b: Genome, locus: MendelLocus): Map<string, number> {
  const alleles = (g: Genome): number[] =>
    g.haplotypes.map((h) => (h.alleles[locus.offset] as number) % locus.alleles.length);
  const out = new Map<string, number>();
  const add = (key: string): void => void out.set(key, (out.get(key) ?? 0) + 0.25);
  for (const x of alleles(a))
    for (const y of alleles(b)) {
      const rx = locus.rank[x] as number;
      const ry = locus.rank[y] as number;
      if (locus.dominance === 'incomplete') add(String((rx + ry) / 2));
      else if (locus.dominance === 'complete' && rx !== ry)
        add(locus.alleles[rx > ry ? x : y] as string);
      else
        add(
          [...new Set([x, y])]
            .sort((p, q) => p - q)
            .map((i) => locus.alleles[i])
            .join('+'),
        );
    }
  return out;
}

describe('punnett: hand-built crosses', () => {
  // albino: ['normal', 'albino', 'pale'] with ranks [2, 1, 0]; the albino allele is index 1 and a
  // normal allele hides it. 'pale' (rank 0) loses to albino.
  it('gives a quarter for two carriers', () => {
    expect(chanceOf(trait(albino(0, 1), albino(0, 1), 'albino'), 'albino')).toBe(0.25);
  });
  it('gives a half for a carrier and an albino', () => {
    expect(chanceOf(trait(albino(0, 1), albino(1, 1), 'albino'), 'albino')).toBe(0.5);
  });
  it('gives nothing when one parent has no such allele', () => {
    expect(chanceOf(trait(albino(0, 1), albino(0, 0), 'albino'), 'albino')).toBe(0);
    expect(chanceOf(trait(albino(1, 1), albino(0, 0), 'albino'), 'albino')).toBe(0);
  });
  it('gives certainty for two albinos', () => {
    expect(chanceOf(trait(albino(1, 1), albino(1, 1), 'albino'), 'albino')).toBe(1);
  });

  it('shows the dominant glow and shimmer when either parent passes the allele', () => {
    const glow = (x: number, y: number): Genome => withAlleles(base, { luminescence: [x, y] });
    // luminescence: ['off', 'on', 'pulse'], ranks [0, 2, 1]: on beats pulse beats off.
    const t = trait(glow(1, 0), glow(0, 0), 'luminescence');
    expect(chanceOf(t, 'on')).toBe(0.5);
    expect(chanceOf(t, 'off')).toBe(0.5);
    const pulse = trait(glow(2, 0), glow(2, 0), 'luminescence');
    expect(chanceOf(pulse, 'pulse')).toBe(0.75);
    expect(chanceOf(pulse, 'off')).toBe(0.25);

    const iri = (x: number, y: number): Genome => withAlleles(base, { iridescence: [x, y] });
    // iridescence: ['plain', 'iridescent', 'oil'], ranks [2, 1, 0]: plain hides the others.
    const shimmer = trait(iri(1, 1), iri(1, 0), 'iridescence');
    expect(chanceOf(shimmer, 'iridescent')).toBe(0.5);
    expect(chanceOf(shimmer, 'plain')).toBe(0.5);
  });

  it('blends the texture and shows both of two equally ranked patterns', () => {
    const tex = (x: number, y: number): Genome => withAlleles(base, { texture: [x, y] });
    const t = trait(tex(0, 2), tex(1, 1), 'texture');
    // Ranks 0 and 2 against 1 and 1: every child lands on rank 0.5 or 1.5, so half and half.
    expect(t.outcomes.map((o) => o.chance)).toEqual([0.5, 0.5]);
    const pat = (x: number, y: number): Genome => withAlleles(base, { pattern: [x, y] });
    // pattern ranks [0, 1, 2, 2, 3]: spots (2) and stripes (3) share rank 2.
    const p = trait(pat(2, 2), pat(3, 3), 'pattern');
    expect(p.outcomes).toEqual([{ value: 'spots+stripes', chance: 1 }]);
  });

  it('reports the chance of a homozygous loss of function per load locus', () => {
    const load = (x: number, y: number): Genome => withAlleles(base, { L1: [x, y], L4: [x, y] });
    const hints = punnett(load(1, 0), load(1, 0));
    expect(hints.load.map((l) => l.id)).toEqual(LOADS.map((l) => l.id));
    expect(hints.load.find((l) => l.id === 'L1')?.chance).toBe(0.25);
    expect(hints.load.find((l) => l.id === 'L2')?.chance).toBe(0);
    expect(punnett(load(1, 1), load(1, 0)).load.find((l) => l.id === 'L4')?.chance).toBe(0.5);
    expect(punnett(load(1, 1), load(1, 1)).load.find((l) => l.id === 'L1')?.chance).toBe(1);
  });

  it('says how likely a mutation is somewhere in the child', () => {
    const { eventChance, maxEvents } = RULES.genetics;
    expect(punnett(base, base).mutationChance).toBeCloseTo(
      1 - (1 - eventChance) ** (2 * maxEvents),
      12,
    );
  });
});

describe('punnett: exact enumeration', () => {
  const parents = Array.from({ length: 200 }, (_, i) => [
    genesisGenome(seedFromString(`punnett-a-${i}`)),
    genesisGenome(seedFromString(`punnett-b-${i}`)),
  ]) as [Genome, Genome][];
  // Genesis hardly makes the rare alleles; sprinkle them so every table entry is exercised.
  const spiced = parents.map(([a, b], i): [Genome, Genome] => {
    const roll = (n: number): [number, number] => [(i * 7 + n) % 5, (i * 3 + n * 2) % 4];
    const set = (n: number): Record<string, [number, number]> => ({
      iridescence: roll(n),
      texture: roll(n + 1),
      targetPref: roll(n + 2),
      pattern: roll(n + 3),
      albino: roll(n + 4),
      luminescence: roll(n + 5),
    });
    return [withAlleles(a, set(0)), withAlleles(b, set(3))];
  });

  it('reports every Mendelian trait once, in karyotype order, with chances that sum to one', () => {
    for (const [a, b] of spiced) {
      const hints = punnett(a, b);
      expect(hints.traits.map((t) => t.id)).toEqual(MENDEL.map((l) => l.id));
      for (const t of hints.traits) {
        expect(t.outcomes.reduce((s, o) => s + o.chance, 0)).toBe(1);
        expect(new Set(t.outcomes.map((o) => o.value)).size).toBe(t.outcomes.length);
        for (const o of t.outcomes) expect(o.chance).toBeGreaterThan(0);
      }
    }
  });

  it('equals an independent enumeration of the four allele combinations', () => {
    for (const [a, b] of spiced) {
      for (const t of punnett(a, b).traits) {
        const locus = mendelById(t.id);
        const want = enumerate(a, b, locus);
        const got = new Map(t.outcomes.map((o) => [o.value, o.chance]));
        // The incomplete locus names a blended rank by words, the others by allele names.
        if (locus.dominance === 'incomplete') {
          expect([...got.values()].sort()).toEqual([...want.values()].sort());
        } else {
          expect(got).toEqual(want);
        }
      }
    }
  });

  it('matches the frequency over seeded children within four sigma', () => {
    const n = 3000;
    for (const [a, b] of spiced.slice(0, 6)) {
      const children = Array.from({ length: n }, (_, k) =>
        breed(a, b, seedFromString(`punnett-child-${k}`), { mutation: 0 }),
      );
      const hints = punnett(a, b);
      const within = (seen: number, chance: number): boolean =>
        Math.abs(seen / n - chance) < tol(chance, n) + 1e-9;
      const shown = (g: Genome, id: string): string => {
        const t = express(g);
        if (id === 'iridescence') return t.skin.iridescence;
        if (id === 'targetPref') return t.behaviour.targetPref;
        if (id === 'pattern') return t.colour.pattern.join('+');
        if (id === 'albino') return t.colour.albino;
        return t.colour.luminescence;
      };
      for (const t of hints.traits.filter((x) => x.id !== 'texture')) {
        const counts = new Map<string, number>();
        for (const g of children) {
          const v = shown(g, t.id);
          counts.set(v, (counts.get(v) ?? 0) + 1);
        }
        for (const o of t.outcomes) expect(within(counts.get(o.value) ?? 0, o.chance)).toBe(true);
        for (const value of counts.keys()) expect(chanceOf(t, value)).toBeGreaterThan(0);
      }
      // A load locus is homozygous when both gametes carry it.
      for (const l of hints.load) {
        const at = (LOADS.find((x) => x.id === l.id) as (typeof LOADS)[number]).offset;
        const hit = children.filter((g) =>
          g.haplotypes.every((h) => ((h.alleles[at] as number) & 1) === 1),
        ).length;
        expect(within(hit, l.chance)).toBe(true);
      }
    }
  }, 30_000);
});

describe('inbreeding load', () => {
  it('shows a child of full siblings at least three times as often with a homozygous load allele', () => {
    const n = 4000;
    const homozygous = (g: Genome): number =>
      LOADS.filter((l) => g.haplotypes.every((h) => ((h.alleles[l.offset] as number) & 1) === 1))
        .length;
    const off = { mutation: 0 };
    let siblings = 0;
    let unrelated = 0;
    for (let k = 0; k < n; k++) {
      const founder = (i: number): Genome => genesisGenome(seedFromString(`load-${k}-${i}`));
      const [f1, f2, f3, f4] = [founder(0), founder(1), founder(2), founder(3)] as [
        Genome,
        Genome,
        Genome,
        Genome,
      ];
      const s1 = breed(f1, f2, seedFromString(`load-s1-${k}`), off);
      const s2 = breed(f1, f2, seedFromString(`load-s2-${k}`), off);
      siblings += homozygous(breed(s1, s2, seedFromString(`load-kid-${k}`), off));
      unrelated += homozygous(breed(f3, f4, seedFromString(`load-kid-${k}`), off));
    }
    expect(unrelated).toBeGreaterThan(0);
    expect(siblings).toBeGreaterThanOrEqual(3 * unrelated);
  }, 30_000);
});

describe('punnett: totality', () => {
  it('handles any genome, including a zero one', () => {
    const zero = decodeGenome(new Uint8Array(2 * HAPLOTYPE_BYTES));
    const hints = punnett(zero, zero);
    expect(hints.traits).toHaveLength(MENDEL.length);
    expect(hints.load.every((l) => l.chance === 0)).toBe(true);
  });
});
