// The total genome codec (ADR 0018, ADR 0025): any byte string decodes, encoding is canonical, and
// the hash covers the canonical bytes only. A genome keeps its own karyotype: exactly 328 bytes is a
// v1 genome and stays one (so living v1 creatures keep their hashes); any other length is v2.

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { GENOME_BYTES, HAPLOTYPE_BYTES, LOCI, MODULE_EXT_BYTES } from './karyotype';
import { GENOME_BYTES_V1, HAPLOTYPE_BYTES_V1, LOCI_V1, type Locus } from './karyotype-v1';

/** One haplotype in canonical form, indexed like the karyotype bytes (module slots span 15 entries). */
export interface Haplotype {
  readonly alleles: readonly number[];
}

/** A v1 genome's haplotypes hold `HAPLOTYPE_BYTES_V1` alleles, a v2 genome's `HAPLOTYPE_BYTES`. */
export interface Genome {
  readonly haplotypes: readonly [Haplotype, Haplotype];
}

const DOMAIN = new TextEncoder().encode('bs/genome/v1\n');

/** 1 when both haplotypes have exactly the v1 length, otherwise 2. */
export function genomeKaryotype(g: Genome): 1 | 2 {
  return g.haplotypes[0].alleles.length === HAPLOTYPE_BYTES_V1 &&
    g.haplotypes[1].alleles.length === HAPLOTYPE_BYTES_V1
    ? 1
    : 2;
}

/** Folds one haplotype's raw bytes (any values) into canonical form, in place. */
function canonicalise(bytes: Uint8Array, base: number, loci: readonly Locus[]): void {
  for (const locus of loci) {
    const at = base + locus.offset;
    const raw = bytes[at] as number;
    if (locus.kind === 'mendel') bytes[at] = raw % locus.alleles.length;
    else if (locus.kind === 'load') bytes[at] = raw & 1;
    else if (locus.kind === 'module') {
      const present = raw & 1;
      bytes[at] = present;
      if (present === 0) {
        bytes.fill(0, at + 1, at + locus.size);
        // A v1 table has no extension; a v2 slot's extension clears with it.
        if (locus.ext !== undefined)
          bytes.fill(0, base + locus.ext, base + locus.ext + MODULE_EXT_BYTES);
      }
    }
  }
}

/**
 * Any bytes to canonical bytes: exactly `GENOME_BYTES_V1` stays a v1 genome; anything else becomes
 * `GENOME_BYTES` of v2, zero-padded or truncated. Values are folded into their tables.
 */
function canonicalBytes(input: Uint8Array): Uint8Array {
  const v1 = input.length === GENOME_BYTES_V1;
  const size = v1 ? GENOME_BYTES_V1 : GENOME_BYTES;
  const hap = size / 2;
  const loci: readonly Locus[] = v1 ? LOCI_V1 : LOCI;
  const flat = new Uint8Array(size);
  flat.set(input.length > size ? input.subarray(0, size) : input);
  canonicalise(flat, 0, loci);
  canonicalise(flat, hap, loci);
  return flat;
}

export function decodeGenome(bytes: Uint8Array): Genome {
  const flat = canonicalBytes(bytes);
  const hap = flat.length / 2;
  return {
    haplotypes: [
      { alleles: Array.from(flat.subarray(0, hap)) },
      { alleles: Array.from(flat.subarray(hap)) },
    ],
  };
}

/** The canonical bytes at the genome's own karyotype (`genomeKaryotype`). */
export function encodeGenome(g: Genome): Uint8Array {
  const hap = genomeKaryotype(g) === 1 ? HAPLOTYPE_BYTES_V1 : HAPLOTYPE_BYTES;
  return canonicalBytes(
    Uint8Array.from(
      g.haplotypes.flatMap((h) => Array.from({ length: hap }, (_, k) => h.alleles[k] ?? 0)),
    ),
  );
}

/** A v1 genome padded to v2: its bytes in place and every new locus 0. A v2 genome comes back as is. */
export function upgrade(g: Genome): Genome {
  if (genomeKaryotype(g) === 2) return g;
  const bytes = encodeGenome(g);
  const out = new Uint8Array(GENOME_BYTES);
  out.set(bytes.subarray(0, HAPLOTYPE_BYTES_V1));
  out.set(bytes.subarray(HAPLOTYPE_BYTES_V1), HAPLOTYPE_BYTES);
  return decodeGenome(out);
}

/** Hex SHA-256 of the domain tag and the canonical bytes at the genome's own length. */
export function genomeHash(g: Genome): string {
  const body = encodeGenome(g);
  const input = new Uint8Array(DOMAIN.length + body.length);
  input.set(DOMAIN);
  input.set(body, DOMAIN.length);
  return bytesToHex(sha256(input));
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const SEXTET = new Map<string, number>([...ALPHABET].map((c, i) => [c, i]));

export function genomeToBase64url(g: Genome): string {
  const bytes = encodeGenome(g);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += ALPHABET[(n >> 18) & 63] as string;
    out += ALPHABET[(n >> 12) & 63] as string;
    if (i + 1 < bytes.length) out += ALPHABET[(n >> 6) & 63] as string;
    if (i + 2 < bytes.length) out += ALPHABET[n & 63] as string;
  }
  return out;
}

/** Null only when the text is not unpadded base64url; any other text decodes (see `decodeGenome`). */
export function genomeFromBase64url(text: string): Genome | null {
  if (text.length % 4 === 1) return null;
  const bytes = new Uint8Array(Math.floor((text.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let at = 0;
  for (const c of text) {
    const v = SEXTET.get(c);
    if (v === undefined) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[at++] = (acc >> bits) & 0xff;
      acc &= (1 << bits) - 1;
    }
  }
  return decodeGenome(bytes);
}

/** The length of `genomeToBase64url` text for a v2 genome. */
export const GENOME_TEXT_LENGTH: number = Math.ceil((GENOME_BYTES * 4) / 3);
/** The length of a v1 genome's text. */
export const GENOME_TEXT_LENGTH_V1: number = Math.ceil((GENOME_BYTES_V1 * 4) / 3);

/**
 * A genome typed or pasted by a person: surrounding space is ignored and the text must be exactly
 * one genome long, v1 or v2. `genomeFromBase64url` alone would also turn "hello" into a genome.
 */
export function parseGenomeText(text: string): Genome | null {
  const trimmed = text.trim();
  return trimmed.length === GENOME_TEXT_LENGTH || trimmed.length === GENOME_TEXT_LENGTH_V1
    ? genomeFromBase64url(trimmed)
    : null;
}
