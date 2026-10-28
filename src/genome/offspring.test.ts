import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { withAlleles } from '../../tests/archetypes';
import { type Beacon, randomnessOf } from '../ledger/drand';
import { genesisFor } from '../ledger/genesis';
import { type Seed, seedFromString } from '../sim/prng';
import { RULES_VERSION } from '../sim/rules';
import {
  decodeGenome,
  encodeGenome,
  type Genome,
  genomeHash,
  genomeKaryotype,
  upgrade,
} from './codec';
import { bodyViolations, develop } from './develop';
import { express } from './express';
import { genesisGenome } from './genesis';
import { breed, mutateGenome, offspringSeed } from './inherit';
import { HAPLOTYPE_BYTES } from './karyotype';
import { offspringPair } from './offspring';

const seedOf = (label: string, i: number): Seed => seedFromString(`${label}-${i}`);
const parents = new Map<number, Genome>();
const parent = (i: number): Genome => {
  const known = parents.get(i);
  if (known) return known;
  const g = genesisGenome(seedOf('offspring-parent', i));
  parents.set(i, g);
  return g;
};
const randomness = (i: number): Uint8Array => new Uint8Array(32).fill(i & 255);
const commitOf = (i: number): string => i.toString(16).padStart(64, '0');
const tol = (p: number, n: number): number => 4 * Math.sqrt((p * (1 - p)) / n);

describe('offspringPair', () => {
  it('is deterministic and slot 0 is the plain breed of the slot-0 seed', () => {
    for (let i = 0; i < 50; i++) {
      const a = parent(2 * i);
      const b = parent(2 * i + 1);
      const x = offspringPair(randomness(i), commitOf(i), a, b);
      const y = offspringPair(randomness(i), commitOf(i), a, b);
      expect(x.children.map(genomeHash)).toEqual(y.children.map(genomeHash));
      expect(x.slots).toEqual(y.slots);
      expect(genomeHash(x.children[0])).toBe(
        genomeHash(breed(a, b, offspringSeed(randomness(i), commitOf(i), 0))),
      );
      expect(genomeHash(x.children[1])).toBe(
        genomeHash(breed(a, b, offspringSeed(randomness(i), commitOf(i), x.slots[1]))),
      );
    }
  });

  it('keeps the two children distinct over random, sibling and clone pairs', () => {
    const check = (a: Genome, b: Genome, i: number, label: string): void => {
      const { children, slots } = offspringPair(randomness(i), commitOf(i), a, b);
      if (genomeHash(children[0]) === genomeHash(children[1])) expect({ label, i }).toBeNull();
      expect(slots[0]).toBe(0);
      expect(slots[1]).toBeGreaterThanOrEqual(1);
      expect(slots[1]).toBeLessThanOrEqual(255);
      const plain1 = breed(a, b, offspringSeed(randomness(i), commitOf(i), 1));
      if (genomeHash(plain1) !== genomeHash(children[0])) expect(slots[1]).toBe(1);
      else expect(slots[1]).toBeGreaterThan(1);
    };
    for (let i = 0; i < 1000; i++) check(parent(2 * i), parent(2 * i + 1), i, 'random');
    for (let i = 0; i < 500; i++) {
      const a = parent(4000 + 2 * i);
      const b = parent(4001 + 2 * i);
      const kids = offspringPair(randomness(i), commitOf(10_000 + i), a, b).children;
      check(kids[0], kids[1], i + 20_000, 'siblings');
    }
    for (let i = 0; i < 500; i++) check(parent(i), parent(i), i + 30_000, 'clones');
  });

  it('retries later slots for homozygous clones, whose slot 1 often equals slot 0', () => {
    // Both haplotypes identical: meiosis is a no-op, so only mutation separates the children.
    const bytes = encodeGenome(parent(3));
    const half = bytes.slice(0, HAPLOTYPE_BYTES);
    const clone = decodeGenome(Uint8Array.from([...half, ...half]));
    let retried = 0;
    for (let i = 0; i < 400; i++) {
      const { children, slots } = offspringPair(randomness(i), commitOf(i), clone, clone);
      expect(genomeHash(children[0])).not.toBe(genomeHash(children[1]));
      if (slots[1] > 1) retried++;
    }
    expect(retried).toBeGreaterThan(20);
  });

  it('gives different randomness or commit ids different pairs (500 samples)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const { children } = offspringPair(randomness(i), commitOf(i), parent(1), parent(2));
      seen.add(children.map(genomeHash).join('/'));
    }
    expect(seen.size).toBe(500);
    const base = offspringPair(randomness(1), commitOf(1), parent(1), parent(2)).children;
    const other = offspringPair(randomness(1), commitOf(2), parent(1), parent(2)).children;
    expect(base.map(genomeHash)).not.toEqual(other.map(genomeHash));
  });

  const rounds: { beacons: Beacon[] } = JSON.parse(
    readFileSync(new URL('../../tests/fixtures/drand/rounds.json', import.meta.url), 'utf8'),
  );
  /** Three fixture rounds × two pairs of genesis parents, bred under `rules`. */
  const vectors = (rules: number) => {
    const beacon0 = randomnessOf(rounds.beacons[0] as Beacon);
    return [1, 2, 3].flatMap((round) =>
      [0, 1].map((pair) => {
        const a = genesisFor(beacon0, commitOf(10 * pair + 1), rules);
        const b = genesisFor(beacon0, commitOf(10 * pair + 2), rules);
        const r = randomnessOf(rounds.beacons[round] as Beacon);
        const { children, slots } = offspringPair(r, commitOf(100 + round), a, b, rules);
        return {
          round: (rounds.beacons[round] as Beacon).round,
          parents: [genomeHash(a), genomeHash(b)],
          children: children.map(genomeHash),
          slots,
        };
      }),
    );
  };

  it('keeps the M5 birth goldens: rules 5 breeds v1 children with the frozen code', () => {
    const file = new URL('./__golden__/offspring-v5.json', import.meta.url);
    const golden = JSON.parse(readFileSync(file, 'utf8')) as {
      rulesVersion: number;
      vectors: unknown;
    };
    expect(golden.rulesVersion).toBe(5);
    expect(vectors(5)).toEqual(golden.vectors);
  });

  it('pads v1 parents under rules 6, and breeds v2 children', () => {
    const r = randomnessOf(rounds.beacons[1] as Beacon);
    const a = genesisFor(r, commitOf(1), 5);
    const b = genesisFor(r, commitOf(2), 5);
    const v5 = offspringPair(r, commitOf(3), a, b, 5);
    const v6 = offspringPair(r, commitOf(3), a, b, 6);
    expect(v5.children.map(genomeKaryotype)).toEqual([1, 1]);
    expect(v6.children.map(genomeKaryotype)).toEqual([2, 2]);
    expect(v6.children.map(genomeHash)).toEqual(
      offspringPair(r, commitOf(3), upgrade(a), upgrade(b), 6).children.map(genomeHash),
    );
  });

  it('matches the committed golden vectors (three fixture rounds × two parent pairs)', () => {
    const file = new URL('./__golden__/offspring.json', import.meta.url);
    const actual = vectors(RULES_VERSION);
    if (process.env.UPDATE_GOLDENS === '1') {
      writeFileSync(
        file,
        `${JSON.stringify({ rulesVersion: RULES_VERSION, vectors: actual }, null, 2)}\n`,
      );
    }
    const golden = JSON.parse(readFileSync(file, 'utf8')) as {
      rulesVersion: number;
      vectors: unknown;
    };
    expect(golden.rulesVersion).toBe(RULES_VERSION);
    expect(actual).toEqual(golden.vectors);
  });
});

describe('offspringPair: viability', () => {
  it('10,000 children of random and mutated parents are all valid bodies', () => {
    for (let i = 0; i < 5000; i++) {
      const a = i % 2 ? mutateGenome(parent(i), seedOf('mut', i), { mutation: 4 }) : parent(i);
      const b = parent(i + 50_000);
      for (const child of offspringPair(randomness(i), commitOf(i), a, b).children) {
        const bad = bodyViolations(develop(express(child)));
        if (bad.length > 0) expect({ i, bad }).toBeNull();
      }
    }
  });
});

describe('Mendelian shares of the children (mutation off)', () => {
  const N = 6000;
  const base = parent(7);
  /** The share of N children, bred from the pair's own slot seeds, for which `pick` is true. */
  const share = (a: Genome, b: Genome, pick: (g: Genome) => boolean): number => {
    let hits = 0;
    for (let i = 0; i < N; i++) {
      const child = breed(a, b, offspringSeed(randomness(i), commitOf(i), 0), { mutation: 0 });
      if (pick(child)) hits++;
    }
    return hits / N;
  };
  const near = (got: number, p: number): void => {
    expect(Math.abs(got - p), `${got} vs ${p}`).toBeLessThanOrEqual(tol(p, N));
  };
  const albino = (g: Genome): boolean => express(g).colour.albino === 'albino';
  const iridescent = (g: Genome): boolean => express(g).skin.iridescence !== 'plain';
  const lit = (g: Genome): boolean => express(g).colour.luminescence !== 'off';

  it('two albino carriers: 25% albino, and the same for iridescence', () => {
    const c = withAlleles(base, { albino: [0, 1], iridescence: [0, 1] });
    near(share(c, c, albino), 0.25);
    near(share(c, c, iridescent), 0.25);
  });

  it('carrier × albino: 50%', () => {
    const c = withAlleles(base, { albino: [0, 1], iridescence: [0, 1] });
    const aa = withAlleles(base, { albino: [1, 1], iridescence: [1, 1] });
    near(share(c, aa, albino), 0.5);
    near(share(c, aa, iridescent), 0.5);
  });

  it('a normal parent hides every albino allele', () => {
    const c = withAlleles(base, { albino: [0, 1] });
    const nn = withAlleles(base, { albino: [0, 0] });
    expect(share(c, nn, albino)).toBe(0);
  });

  it('two carriers of the dominant luminescence allele: 75% lit', () => {
    const c = withAlleles(base, { luminescence: [0, 1] });
    near(share(c, c, lit), 0.75);
  });
});
