import { describe, expect, it } from 'vitest';
import { type Genome, genomeHash } from '../genome/codec';
import { bodyViolations } from '../genome/develop';
import { genesisGenome } from '../genome/genesis';
import { LOCI } from '../genome/karyotype';
import { buildCreature } from '../genome/stats';
import { seedFromString } from '../sim/prng';
import { BREED_COUNT, breedBatch, labRandomness, mutateStep } from './breed';

const genome = (label: string): Genome => genesisGenome(seedFromString(label));
const A = genome('breed-a');
const B = genome('breed-b');
const hashes = (list: readonly Genome[]): string[] => list.map(genomeHash);
const slot = (g: Genome, hap: 0 | 1, l: (typeof LOCI)[number]): string =>
  g.haplotypes[hap].alleles.slice(l.offset, l.offset + l.size).join(',');

describe('labRandomness', () => {
  it('is 32 bytes that depend on the page seed alone', () => {
    expect(labRandomness('x')).toHaveLength(32);
    expect(labRandomness('x')).toEqual(labRandomness('x'));
    expect(labRandomness('x')).not.toEqual(labRandomness('y'));
  });
});

describe('breedBatch', () => {
  const rand = labRandomness('lab-fixed');

  it('gives exactly 8 valid children, the same 8 every time', () => {
    const kids = breedBatch(A, B, rand);
    expect(kids).toHaveLength(BREED_COUNT);
    expect(BREED_COUNT).toBe(8);
    expect(hashes(breedBatch(A, B, rand))).toEqual(hashes(kids));
    for (const kid of kids) expect(bodyViolations(buildCreature(kid).plan)).toEqual([]);
  });

  it('changes with the randomness and with the parents', () => {
    const kids = hashes(breedBatch(A, B, rand));
    expect(hashes(breedBatch(A, B, labRandomness('lab-other')))).not.toEqual(kids);
    expect(hashes(breedBatch(B, A, rand))).not.toEqual(kids);
  });

  it('makes siblings that differ from each other and from both parents', () => {
    for (const seed of ['lab-fixed', 'lab-1', 'lab-2']) {
      const kids = hashes(breedBatch(A, B, labRandomness(seed)));
      const distinct = new Set(kids);
      for (const parent of hashes([A, B])) distinct.delete(parent);
      expect(distinct.size, seed).toBeGreaterThanOrEqual(6);
    }
  });

  it('with mutation off, every locus of a child comes from its own parent', () => {
    for (const seed of ['lab-fixed', 'lab-1', 'lab-2']) {
      for (const kid of breedBatch(A, B, labRandomness(seed), { mutation: 0 })) {
        for (const l of LOCI) {
          expect([slot(A, 0, l), slot(A, 1, l)]).toContain(slot(kid, 0, l));
          expect([slot(B, 0, l), slot(B, 1, l)]).toContain(slot(kid, 1, l));
        }
      }
    }
  });
});

describe('mutateStep', () => {
  it('always changes the hash and keeps a valid body, for 200 genomes', () => {
    for (let i = 0; i < 200; i++) {
      const g = genome(`mutate-${i}`);
      const next = mutateStep(g, `lab-${i}`, i % 5);
      expect(genomeHash(next)).not.toBe(genomeHash(g));
      expect(bodyViolations(buildCreature(next).plan)).toEqual([]);
    }
  });

  it('is deterministic and steps differently each time', () => {
    expect(genomeHash(mutateStep(A, 's', 0))).toBe(genomeHash(mutateStep(A, 's', 0)));
    expect(genomeHash(mutateStep(A, 's', 0))).not.toBe(genomeHash(mutateStep(A, 's', 1)));
    expect(genomeHash(mutateStep(A, 's', 0))).not.toBe(genomeHash(mutateStep(A, 't', 0)));
  });
});
