// The total genome codec (ADR 0018): any byte string decodes, encoding is canonical, and the hash
// covers the canonical bytes only.

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { GENOME_BYTES, HAPLOTYPE_BYTES, LOCI } from './karyotype';

/** One haplotype in canonical form, indexed like the karyotype bytes (module slots span 15 entries). */
export interface Haplotype {
  readonly alleles: readonly number[];
}

export interface Genome {
  readonly haplotypes: readonly [Haplotype, Haplotype];
}

const DOMAIN = new TextEncoder().encode('bs/genome/v1\n');

/** Folds one haplotype's raw bytes (any values) into canonical form, in place. */
function canonicalise(bytes: Uint8Array, base: number): void {
  for (const locus of LOCI) {
    const at = base + locus.offset;
    const raw = bytes[at] as number;
    if (locus.kind === 'mendel') bytes[at] = raw % locus.alleles.length;
    else if (locus.kind === 'load') bytes[at] = raw & 1;
    else if (locus.kind === 'module') {
      const present = raw & 1;
      bytes[at] = present;
      if (present === 0) bytes.fill(0, at + 1, at + locus.size);
    }
  }
}

/** Any bytes to exactly GENOME_BYTES canonical bytes: zero-padded, truncated, folded into tables. */
function canonicalBytes(input: Uint8Array): Uint8Array {
  const flat = new Uint8Array(GENOME_BYTES);
  flat.set(input.length > GENOME_BYTES ? input.subarray(0, GENOME_BYTES) : input);
  canonicalise(flat, 0);
  canonicalise(flat, HAPLOTYPE_BYTES);
  return flat;
}

export function decodeGenome(bytes: Uint8Array): Genome {
  const flat = canonicalBytes(bytes);
  return {
    haplotypes: [
      { alleles: Array.from(flat.subarray(0, HAPLOTYPE_BYTES)) },
      { alleles: Array.from(flat.subarray(HAPLOTYPE_BYTES)) },
    ],
  };
}

export function encodeGenome(g: Genome): Uint8Array {
  return canonicalBytes(
    Uint8Array.from(
      g.haplotypes.flatMap((h) =>
        Array.from({ length: HAPLOTYPE_BYTES }, (_, k) => h.alleles[k] ?? 0),
      ),
    ),
  );
}

/** Hex SHA-256 of the domain tag and the canonical bytes. */
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
