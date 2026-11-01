import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { heavyTest } from '../../tests/heavy';
import { createRng, seedFromString } from '../sim/prng';
import {
  decodeGenome,
  encodeGenome,
  GENOME_TEXT_LENGTH,
  type Genome,
  genomeHash,
  genomeToBase64url,
  parseGenomeText,
} from './codec';
import { express, type Traits } from './express';
import {
  BASE_BYTES,
  GENOME_BYTES,
  HAPLOTYPE_BYTES,
  KARYOTYPE_VERSION,
  LOCI,
  MODULE_EXT,
  MODULE_EXT_BYTES,
  type ModuleLocus,
  SHAPE_LOCI,
} from './karyotype';

const rng = createRng(seedFromString('karyotype-v2-tests'), 'bytes');
const randomBytes = (length: number): Uint8Array =>
  Uint8Array.from({ length }, () => rng.nextU32() & 0xff);

const locus = (id: string) => LOCI.find((l) => l.id === id) as (typeof LOCI)[number];
const modules = LOCI.filter((l): l is ModuleLocus => l.kind === 'module');

describe('karyotype v2 layout', () => {
  it('is version 2', () => {
    expect(KARYOTYPE_VERSION).toBe(2);
  });

  it('starts with the base loci in 164 bytes, laid out as karyotype v1 had them', () => {
    expect(BASE_BYTES).toBe(164);
    const base = LOCI.filter((l) => l.offset < BASE_BYTES).map((l) =>
      l.kind === 'module' ? (({ ext: _ext, ...rest }) => rest)(l) : l,
    );
    // The digest of the table as rules v5 shipped it, so moving it inline (rules 8) kept every byte.
    expect(createHash('sha256').update(JSON.stringify(base)).digest('hex')).toBe(
      'bae8fc943ed7e264f6b9a359a582281887ddc94a61dc48e79b61054f8e42aff3',
    );
  });

  it('appends the body loci to chromosome 1, then an extension per module slot', () => {
    expect(SHAPE_LOCI).toEqual([
      'curve',
      'curveMode',
      'headScale',
      'trunkSwell',
      'tailLength',
      'tailTaper',
      'fusion',
      'symmetry',
      'drape',
      'eyeSize',
      'eyeStalk',
    ]);
    SHAPE_LOCI.forEach((id, i) => {
      expect(locus(id)).toMatchObject({ kind: 'quant', chr: 1, offset: 164 + i, size: 1 });
    });
    expect(MODULE_EXT).toEqual([
      'webbing',
      'setaeDensity',
      'setaeLength',
      'bulb',
      'chela',
      'beads',
    ]);
    expect(MODULE_EXT_BYTES).toBe(6);
    expect(modules).toHaveLength(8);
    modules.forEach((m, i) => {
      expect(m.ext, m.id).toBe(164 + SHAPE_LOCI.length + i * MODULE_EXT_BYTES);
    });
    expect(HAPLOTYPE_BYTES).toBe(164 + SHAPE_LOCI.length + 8 * MODULE_EXT_BYTES);
    expect(GENOME_BYTES).toBe(2 * HAPLOTYPE_BYTES);
    // Every byte of a v2 haplotype belongs to exactly one locus (a slot owns its extension).
    const owner = new Array<string | undefined>(HAPLOTYPE_BYTES);
    const claim = (at: number, id: string): void => {
      expect(owner[at], `byte ${at}`).toBeUndefined();
      owner[at] = id;
    };
    for (const l of LOCI) {
      for (let k = 0; k < l.size; k++) claim(l.offset + k, l.id);
      if (l.kind === 'module') for (let k = 0; k < MODULE_EXT_BYTES; k++) claim(l.ext + k, l.id);
    }
    expect(owner.every((id) => id !== undefined)).toBe(true);
  });
});

describe('decoding by length', () => {
  heavyTest('decodes any length as v2, zero-padded or truncated, never throwing', () => {
    const lengths = [0, 1, 163, 327, 328, 329, 445, 446, 447, 4096];
    for (let i = 0; i < 2000; i++) {
      const length = lengths[i % lengths.length] as number;
      const bytes = randomBytes(length);
      const g = decodeGenome(bytes);
      expect(g.haplotypes[0].alleles).toHaveLength(HAPLOTYPE_BYTES);
      expect(g.haplotypes[1].alleles).toHaveLength(HAPLOTYPE_BYTES);
      const padded = new Uint8Array(GENOME_BYTES);
      padded.set(bytes.subarray(0, GENOME_BYTES));
      expect(encodeGenome(g), `${length}`).toEqual(encodeGenome(decodeGenome(padded)));
    }
  });

  it('keeps a genome at GENOME_BYTES in bytes and text, and parses only that text length', () => {
    const g = decodeGenome(randomBytes(GENOME_BYTES));
    expect(encodeGenome(g)).toHaveLength(GENOME_BYTES);
    expect(GENOME_TEXT_LENGTH).toBe(595);
    const text = genomeToBase64url(g);
    expect(text).toHaveLength(GENOME_TEXT_LENGTH);
    expect(genomeHash(parseGenomeText(`  ${text}\n`) as Genome)).toBe(genomeHash(g));
    // 438 characters was a karyotype v1 genome's text, retired with rules 8 (ADR 0040).
    for (const n of [0, 437, 438, 439, 594, 596])
      expect(parseGenomeText('A'.repeat(n)), `${n}`).toBeNull();
  });

  it('clears the extension of an absent slot and keeps a present one', () => {
    const bytes = randomBytes(GENOME_BYTES);
    const m3 = locus('M3') as ModuleLocus;
    bytes[m3.offset] = 0;
    bytes[HAPLOTYPE_BYTES + m3.offset] = 1;
    bytes.fill(0x77, m3.ext, m3.ext + MODULE_EXT_BYTES);
    bytes.fill(0x66, HAPLOTYPE_BYTES + m3.ext, HAPLOTYPE_BYTES + m3.ext + MODULE_EXT_BYTES);
    const g = decodeGenome(bytes);
    expect(g.haplotypes[0].alleles.slice(m3.ext, m3.ext + MODULE_EXT_BYTES)).toEqual([
      0, 0, 0, 0, 0, 0,
    ]);
    expect(g.haplotypes[1].alleles.slice(m3.ext, m3.ext + MODULE_EXT_BYTES)).toEqual(
      new Array(MODULE_EXT_BYTES).fill(0x66),
    );
  });
});

describe('expressing the new loci', () => {
  /** A v2 genome of zeros with `values` written on both haplotypes. */
  function withBytes(values: Record<number, number>): Genome {
    const bytes = new Uint8Array(GENOME_BYTES);
    for (const [at, v] of Object.entries(values)) {
      bytes[Number(at)] = v;
      bytes[HAPLOTYPE_BYTES + Number(at)] = v;
    }
    return decodeGenome(bytes);
  }

  it('maps 0 to off and 255 to the top of every range', () => {
    const zero = express(withBytes({}));
    expect(Object.values(zero.shape).every((v) => v === 0)).toBe(true);
    const top = express(
      withBytes(Object.fromEntries(SHAPE_LOCI.map((id) => [locus(id).offset, 255]))),
    );
    for (const id of SHAPE_LOCI) expect(top.shape[id as keyof Traits['shape']], id).toBe(1);
    const half = express(
      withBytes({ [locus('curve').offset]: 51, [locus('eyeSize').offset]: 204 }),
    );
    expect(half.shape.curve).toBeCloseTo(0.2, 9);
    expect(half.shape.eyeSize).toBeCloseTo(0.8, 9);
  });

  it('expresses a slot extension as its parameters are: only where the slot is present, mean of both copies', () => {
    const m2 = locus('M2') as ModuleLocus;
    const absent = express(withBytes({ [m2.ext]: 255 }));
    expect(Object.values(absent.modules[1]?.ext ?? {}).every((v) => v === 0)).toBe(true);
    const present = express(
      withBytes(
        Object.fromEntries([[m2.offset, 1], ...MODULE_EXT.map((_, k) => [m2.ext + k, 255])]),
      ),
    );
    for (const name of MODULE_EXT) expect(present.modules[1]?.ext[name], name).toBe(1);
    // One haplotype carries the slot: its copy alone is expressed.
    const bytes = new Uint8Array(GENOME_BYTES);
    bytes[HAPLOTYPE_BYTES + m2.offset] = 1;
    bytes[HAPLOTYPE_BYTES + m2.ext + 4] = 153;
    expect(express(decodeGenome(bytes)).modules[1]?.ext.chela).toBeCloseTo(0.6, 9);
  });

  it('is symmetric in the haplotypes', () => {
    for (let i = 0; i < 200; i++) {
      const g = decodeGenome(randomBytes(GENOME_BYTES));
      const swapped: Genome = { haplotypes: [g.haplotypes[1], g.haplotypes[0]] };
      expect(express(swapped)).toEqual(express(g));
    }
  });
});
