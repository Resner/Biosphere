import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createRng, seedFromString } from '../sim/prng';
import {
  decodeGenome,
  encodeGenome,
  GENOME_TEXT_LENGTH,
  GENOME_TEXT_LENGTH_V1,
  type Genome,
  genomeHash,
  genomeKaryotype,
  genomeToBase64url,
  parseGenomeText,
  upgrade,
} from './codec';
import { express, type Traits } from './express';
import {
  GENOME_BYTES,
  HAPLOTYPE_BYTES,
  KARYOTYPE_VERSION,
  karyotypeForRules,
  LOCI,
  MODULE_EXT,
  MODULE_EXT_BYTES,
  type ModuleLocus,
  SHAPE_LOCI,
} from './karyotype';
import { GENOME_BYTES_V1, HAPLOTYPE_BYTES_V1, LOCI_V1 } from './karyotype-v1';

const rng = createRng(seedFromString('karyotype-v2-tests'), 'bytes');
const randomBytes = (length: number): Uint8Array =>
  Uint8Array.from({ length }, () => rng.nextU32() & 0xff);

const locus = (id: string) => LOCI.find((l) => l.id === id) as (typeof LOCI)[number];
const modules = LOCI.filter((l): l is ModuleLocus => l.kind === 'module');

/** JSON with sorted keys, so a digest does not depend on the order fields were built in. */
const stable = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(stable).join(',')}]`
    : v !== null && typeof v === 'object'
      ? `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
          .join(',')}}`
      : JSON.stringify(v);

/** The traits as karyotype v1 expressed them: no shape group and no slot extensions. */
function v1Fields(t: Traits): unknown {
  const { shape: _shape, ...rest } = t;
  return { ...rest, modules: t.modules.map(({ ext: _ext, ...m }) => m) };
}

describe('karyotype v2 layout', () => {
  it('is version 2, and rules version 6 is its first', () => {
    expect(KARYOTYPE_VERSION).toBe(2);
    expect(karyotypeForRules(3)).toBe(1);
    expect(karyotypeForRules(5)).toBe(1);
    expect(karyotypeForRules(6)).toBe(2);
  });

  it('freezes the v1 table: 164 bytes a haplotype, 328 a genome, the M5 layout to the byte', () => {
    expect(HAPLOTYPE_BYTES_V1).toBe(164);
    expect(GENOME_BYTES_V1).toBe(328);
    // The digest of the table as rules v5 shipped it (computed before karyotype v2 existed).
    expect(createHash('sha256').update(JSON.stringify(LOCI_V1)).digest('hex')).toBe(
      'bae8fc943ed7e264f6b9a359a582281887ddc94a61dc48e79b61054f8e42aff3',
    );
  });

  it('keeps every v1 locus at its v1 offset, size, chromosome and kind', () => {
    for (const old of LOCI_V1) {
      const now = locus(old.id);
      expect({ ...now, ext: undefined }, old.id).toEqual({ ...old, ext: undefined });
    }
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
  it('decodes exactly 328 bytes as v1 and any other length as v2, never throwing', () => {
    const lengths = [0, 1, 163, 327, 328, 329, 445, 446, 447, 4096];
    for (let i = 0; i < 2000; i++) {
      const length = lengths[i % lengths.length] as number;
      const g = decodeGenome(randomBytes(length));
      const want = length === GENOME_BYTES_V1 ? 1 : 2;
      expect(genomeKaryotype(g), `${length}`).toBe(want);
      const hap = want === 1 ? HAPLOTYPE_BYTES_V1 : HAPLOTYPE_BYTES;
      expect(g.haplotypes[0].alleles).toHaveLength(hap);
      expect(g.haplotypes[1].alleles).toHaveLength(hap);
    }
  });

  it('zero-pads or truncates any other length to a v2 genome', () => {
    const base = randomBytes(GENOME_BYTES);
    const canonical = encodeGenome(decodeGenome(base));
    const longer = new Uint8Array(GENOME_BYTES + 40).fill(0x55);
    longer.set(base);
    expect(encodeGenome(decodeGenome(longer))).toEqual(canonical);
    const short = base.slice(0, 300);
    const padded = new Uint8Array(GENOME_BYTES);
    padded.set(short);
    expect(encodeGenome(decodeGenome(short))).toEqual(encodeGenome(decodeGenome(padded)));
  });

  it('keeps a genome at its own length in bytes and text, and parses both text lengths', () => {
    const v1 = decodeGenome(randomBytes(GENOME_BYTES_V1));
    const v2 = decodeGenome(randomBytes(GENOME_BYTES));
    expect(encodeGenome(v1)).toHaveLength(GENOME_BYTES_V1);
    expect(encodeGenome(v2)).toHaveLength(GENOME_BYTES);
    expect(GENOME_TEXT_LENGTH_V1).toBe(438);
    expect(GENOME_TEXT_LENGTH).toBe(595);
    for (const g of [v1, v2]) {
      const text = genomeToBase64url(g);
      const parsed = parseGenomeText(`  ${text}\n`) as Genome;
      expect(parsed).not.toBeNull();
      expect(genomeKaryotype(parsed)).toBe(genomeKaryotype(g));
      expect(genomeHash(parsed)).toBe(genomeHash(g));
    }
    expect(genomeToBase64url(v1)).toHaveLength(GENOME_TEXT_LENGTH_V1);
    expect(genomeToBase64url(v2)).toHaveLength(GENOME_TEXT_LENGTH);
    for (const n of [0, 437, 439, 594, 596])
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

describe('v1 genomes under karyotype v2', () => {
  it('10,000 random v1 genomes: every new locus is 0 and the traits equal v1 field by field', () => {
    const r = createRng(seedFromString('karyotype-v1-traits'), 'bytes');
    const digest = createHash('sha256');
    for (let i = 0; i < 10_000; i++) {
      const bytes = Uint8Array.from({ length: GENOME_BYTES_V1 }, () => r.nextU32() & 0xff);
      const g = decodeGenome(bytes);
      const t = express(g);
      digest.update(stable(v1Fields(t))).update('\n');
      for (const [k, v] of Object.entries(t.shape)) if (v !== 0) expect({ i, k, v }).toBeNull();
      for (const m of t.modules)
        for (const [k, v] of Object.entries(m.ext)) if (v !== 0) expect({ i, k, v }).toBeNull();
      if (i % 50 === 0) expect(express(upgrade(g))).toEqual(t);
    }
    // The digest of the same 10,000 genomes' traits under karyotype v1 (rules v5), before v2 existed.
    expect(digest.digest('hex')).toBe(
      'ddf2b1208115efb73017a2dbcec0735dd35cf2c7f10ba84790433b505f523568',
    );
  });

  it('upgrade pads a v1 genome to v2: same bytes in place, zeros after, a different stable hash', () => {
    const r = createRng(seedFromString('genome-golden'), 'bytes');
    const v1 = decodeGenome(Uint8Array.from({ length: GENOME_BYTES_V1 }, () => r.nextU32() & 0xff));
    const up = upgrade(v1);
    expect(genomeKaryotype(up)).toBe(2);
    for (const hap of [0, 1] as const) {
      const a = up.haplotypes[hap].alleles;
      expect(a.slice(0, HAPLOTYPE_BYTES_V1)).toEqual(v1.haplotypes[hap].alleles);
      expect(a.slice(HAPLOTYPE_BYTES_V1).every((b) => b === 0)).toBe(true);
    }
    expect(genomeHash(up)).not.toBe(genomeHash(v1));
    expect(genomeHash(upgrade(v1))).toBe(genomeHash(up));
    expect(upgrade(up)).toEqual(up);
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
