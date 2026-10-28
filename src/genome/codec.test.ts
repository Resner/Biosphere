import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createRng, seedFromString } from '../sim/prng';
import { RULES_VERSION } from '../sim/rules';
import {
  decodeGenome,
  encodeGenome,
  GENOME_TEXT_LENGTH,
  type Genome,
  genomeFromBase64url,
  genomeHash,
  genomeToBase64url,
  parseGenomeText,
  upgrade,
} from './codec';
import { genesisGenome } from './genesis';
import { GENOME_BYTES, HAPLOTYPE_BYTES, LOCI } from './karyotype';
import { GENOME_BYTES_V1, HAPLOTYPE_BYTES_V1, LOCI_V1 } from './karyotype-v1';

const rng = createRng(seedFromString('genome-codec-tests'), 'bytes');

function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = rng.nextU32() & 0xff;
  return out;
}

/** The golden inputs at one length: zeros, a counter and seeded random bytes. */
const inputsOf = (length: number) => ({
  zero: new Uint8Array(length),
  counter: Uint8Array.from({ length }, (_, i) => i & 0xff),
  random: (() => {
    const r = createRng(seedFromString('genome-golden'), 'bytes');
    return Uint8Array.from({ length }, () => r.nextU32() & 0xff);
  })(),
});
const goldenInputs = inputsOf(GENOME_BYTES);
const counter = goldenInputs.counter;

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

describe('karyotype', () => {
  it('lays the v1 loci out contiguously over six chromosomes', () => {
    let offset = 0;
    for (const locus of LOCI_V1) {
      expect(locus.offset).toBe(offset);
      offset += locus.size;
    }
    expect(offset).toBe(HAPLOTYPE_BYTES_V1);
    expect(GENOME_BYTES_V1).toBe(2 * HAPLOTYPE_BYTES_V1);
    expect(new Set(LOCI_V1.map((l) => l.chr))).toEqual(new Set([1, 2, 3, 4, 5, 6]));
    expect(LOCI_V1.map((l) => l.chr)).toEqual([...LOCI_V1.map((l) => l.chr)].sort());
    expect(new Set(LOCI.map((l) => l.id)).size).toBe(LOCI.length);
  });

  it('has 8 module slots of 15 bytes and the four load loci', () => {
    const modules = LOCI.filter((l) => l.kind === 'module');
    expect(modules.map((l) => l.id)).toEqual(['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8']);
    for (const m of modules) expect(m.size).toBe(15);
    expect(LOCI.filter((l) => l.kind === 'load').map((l) => l.id)).toEqual([
      'L1',
      'L2',
      'L3',
      'L4',
    ]);
  });

  it('gives every mendel table a complete rank and a novel allele', () => {
    const mendel = LOCI.filter((l) => l.kind === 'mendel');
    expect(mendel.length).toBeGreaterThanOrEqual(5);
    const kinds = new Set(mendel.map((l) => l.dominance));
    expect(kinds).toEqual(new Set(['complete', 'incomplete']));
    for (const l of mendel) {
      expect(l.rank).toHaveLength(l.alleles.length);
      expect(l.novelFrom).toBeGreaterThanOrEqual(2);
      expect(l.novelFrom).toBeLessThan(l.alleles.length);
    }
  });
});

describe('decodeGenome', () => {
  it('never throws on short, long or extreme input', () => {
    const lengths = [0, 1, GENOME_BYTES - 1, GENOME_BYTES, GENOME_BYTES + 1, 4096];
    for (let i = 0; i < 10_000; i++) {
      const bytes = randomBytes(lengths[i % lengths.length] as number);
      expect(() => decodeGenome(bytes)).not.toThrow();
    }
    for (const length of lengths) {
      decodeGenome(new Uint8Array(length));
      decodeGenome(new Uint8Array(length).fill(0xff));
    }
  });

  it('zero-pads short input and ignores extra bytes', () => {
    const base = randomBytes(GENOME_BYTES);
    const canonical = encodeGenome(decodeGenome(base));
    const short = base.slice(0, GENOME_BYTES - 10);
    const padded = new Uint8Array(GENOME_BYTES);
    padded.set(short);
    expect(encodeGenome(decodeGenome(short))).toEqual(encodeGenome(decodeGenome(padded)));
    const longer = new Uint8Array(GENOME_BYTES + 50).fill(0x55);
    longer.set(base);
    expect(encodeGenome(decodeGenome(longer))).toEqual(canonical);
  });
});

describe('canonical form', () => {
  it('encodes to GENOME_BYTES, decodes back deep-equal, and is idempotent', () => {
    for (let i = 0; i < 500; i++) {
      const g = decodeGenome(randomBytes(GENOME_BYTES));
      const bytes = encodeGenome(g);
      expect(bytes).toHaveLength(GENOME_BYTES);
      expect(decodeGenome(bytes)).toEqual(g);
      expect(encodeGenome(decodeGenome(bytes))).toEqual(bytes);
    }
  });

  it('hashes non-canonical bits the same', () => {
    const raw = randomBytes(GENOME_BYTES);
    const reference = genomeHash(decodeGenome(raw));
    for (const hap of [0, 1]) {
      const base = hap * HAPLOTYPE_BYTES;
      for (const locus of LOCI) {
        const at = base + locus.offset;
        const changed = raw.slice();
        if (locus.kind === 'mendel') {
          changed[at] = ((changed[at] as number) % locus.alleles.length) + locus.alleles.length * 3;
        } else if (locus.kind === 'load') {
          changed[at] = (changed[at] as number) ^ 0xfe;
        } else if (locus.kind === 'module') {
          const present = ((raw[at] as number) & 1) === 1;
          changed[at] = (raw[at] as number) ^ 0xfe;
          if (!present) for (let p = 1; p < 15; p++) changed[at + p] = 0x9c;
        } else continue;
        expect(genomeHash(decodeGenome(changed)), `${locus.id}`).toBe(reference);
      }
    }
  });

  it('hashes expressed differences differently', () => {
    const canonical = encodeGenome(decodeGenome(randomBytes(GENOME_BYTES)));
    const byHash = new Map<string, string>([[genomeHash(decodeGenome(canonical)), hex(canonical)]]);
    let distinct = 0;
    for (let i = 0; i < 1000; i++) {
      const changed = canonical.slice();
      const at = rng.int(0, GENOME_BYTES - 1);
      changed[at] = ((changed[at] as number) + 1 + rng.int(0, 254)) & 0xff;
      const next = encodeGenome(decodeGenome(changed));
      if (hex(next) === hex(canonical)) continue; // folded back onto the same allele
      distinct++;
      const hash = genomeHash(decodeGenome(next));
      const known = byHash.get(hash);
      if (known !== undefined) expect(known).toBe(hex(next));
      byHash.set(hash, hex(next));
    }
    expect(distinct).toBeGreaterThan(500);
    expect(hex(canonical)).not.toBe('');
  });
});

describe('genomeHash', () => {
  it('is SHA-256 of the domain tag and the canonical bytes', () => {
    for (const bytes of Object.values(goldenInputs)) {
      const g = decodeGenome(bytes);
      const expected = createHash('sha256')
        .update('bs/genome/v1\n')
        .update(encodeGenome(g))
        .digest('hex');
      expect(genomeHash(g)).toBe(expected);
    }
  });

  it('keeps the karyotype v1 golden hashes (frozen, ADR 0025)', () => {
    const file = new URL('./__golden__/genome-hash-v1.json', import.meta.url);
    const golden = JSON.parse(readFileSync(file, 'utf8')) as {
      rulesVersion: number;
      karyotype: number;
      vectors: Record<string, { input: string; canonical: string; hash: string }>;
    };
    expect(golden).toMatchObject({ rulesVersion: 5, karyotype: 1 });
    const inputs = inputsOf(GENOME_BYTES_V1);
    expect(Object.keys(golden.vectors)).toEqual(Object.keys(inputs));
    for (const [name, bytes] of Object.entries(inputs)) {
      const v = golden.vectors[name] as { input: string; canonical: string; hash: string };
      expect(v.input).toBe(hex(bytes));
      const g = decodeGenome(bytes);
      expect(hex(encodeGenome(g))).toBe(v.canonical);
      expect(genomeHash(g)).toBe(v.hash);
    }
  });

  const file = new URL('./__golden__/genome-hash.json', import.meta.url);
  const vectorsOf = (inputs: Record<string, Uint8Array>) =>
    Object.fromEntries(
      Object.entries(inputs).map(([name, bytes]) => {
        const g = decodeGenome(bytes);
        return [name, { input: hex(bytes), canonical: hex(encodeGenome(g)), hash: genomeHash(g) }];
      }),
    );
  /** The v2 vectors, and the v1 inputs upgraded to v2 (`upgrade`). */
  const compute = () => ({
    vectors: vectorsOf(goldenInputs),
    upgraded: Object.fromEntries(
      Object.entries(inputsOf(GENOME_BYTES_V1)).map(([name, bytes]) => [
        name,
        genomeHash(upgrade(decodeGenome(bytes))),
      ]),
    ),
  });
  if (process.env.UPDATE_GOLDENS) {
    writeFileSync(
      file,
      `${JSON.stringify({ rulesVersion: RULES_VERSION, karyotype: 2, ...compute() }, null, 2)}\n`,
    );
  }

  it('matches the committed karyotype v2 golden vectors', () => {
    const { rulesVersion, karyotype, ...vectors } = JSON.parse(readFileSync(file, 'utf8')) as {
      rulesVersion: number;
      karyotype: number;
    };
    expect(rulesVersion).toBe(RULES_VERSION);
    expect(karyotype).toBe(2);
    expect(compute()).toEqual(vectors);
  });
});

describe('base64url', () => {
  it('round-trips 1000 random genomes', () => {
    for (let i = 0; i < 1000; i++) {
      const g = decodeGenome(randomBytes(GENOME_BYTES));
      const text = genomeToBase64url(g);
      expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(genomeFromBase64url(text)).toEqual(g);
    }
    expect(genomeToBase64url(decodeGenome(counter))).toHaveLength(
      Math.ceil((GENOME_BYTES * 4) / 3),
    );
  });

  it('never throws on hostile text', () => {
    const texts = [
      '',
      'A',
      '====',
      'a b',
      'é',
      '+/',
      'A'.repeat(5000),
      'AAAA'.repeat(2000),
      '\u0000',
    ];
    for (const text of texts) {
      let result: ReturnType<typeof genomeFromBase64url> | undefined;
      expect(() => {
        result = genomeFromBase64url(text);
      }).not.toThrow();
      expect(result === null || typeof result === 'object').toBe(true);
    }
    expect(genomeFromBase64url('a b')).toBeNull();
    expect(genomeFromBase64url('A+/=')).toBeNull();
    expect(genomeFromBase64url('A')).toBeNull();
    expect(genomeFromBase64url('')).not.toBeNull();
    expect(genomeFromBase64url('A'.repeat(5000))).not.toBeNull();
  });
});

describe('parseGenomeText', () => {
  const g = genesisGenome(seedFromString('parse-text'));

  it('round-trips the text of a genome, ignoring surrounding space', () => {
    const text = genomeToBase64url(g);
    expect(text).toHaveLength(GENOME_TEXT_LENGTH);
    expect(genomeHash(parseGenomeText(` ${text}\n`) as Genome)).toBe(genomeHash(g));
  });

  it('rejects anything that is not exactly one genome', () => {
    const text = genomeToBase64url(g);
    for (const bad of ['', 'hello', 'not a genome', text.slice(1), `${text}A`, `${text}=`]) {
      expect(parseGenomeText(bad), bad).toBeNull();
    }
    expect(parseGenomeText(`${text.slice(0, -1)}!`)).toBeNull();
  });
});
