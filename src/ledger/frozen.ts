import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { canonicalize } from './canonical';

// Frozen rules versions (ADR 0074): `__golden__/frozen.json` lists, per rules version, the SHA-256
// of every golden file that pins it, and `RELEASED` (`registry.ts`) pins a released version's
// entry by the hash of its canonical JSON. So a released version's goldens never change unnoticed,
// and changing a released entry takes a deliberate edit in two places. Pure: no DOM, no Node APIs.

/** A repository path (`src/sim/__golden__/math.json`) → the SHA-256 hex of the file's bytes. */
export type FrozenEntry = Readonly<Record<string, string>>;
/** Rules version (as a decimal key) → its entry. */
export type FrozenManifest = Readonly<Record<string, FrozenEntry>>;

/** SHA-256 hex of the entry's canonical JSON (RFC 8785): what `RELEASED` pins. */
export function entryHash(entry: FrozenEntry): string {
  return bytesToHex(sha256(utf8ToBytes(canonicalize(entry))));
}

/** The entry with its paths in order, so the manifest's text stays stable. */
function sorted(files: FrozenEntry): FrozenEntry {
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/**
 * What is wrong with the manifest, `[]` when it holds:
 * - `no-entry:<live>`: the live version has no entry;
 * - `unlisted:<path>`, `changed:<path>`, `gone:<path>`: a golden file the live entry doesn't
 *   list, one whose hash differs, one it lists that no longer exists;
 * - `released-missing:<v>`, `released-changed:<v>`: a released version with no entry, or whose
 *   entry hashes to anything but its pin.
 */
export function manifestProblems(
  live: number,
  files: FrozenEntry,
  manifest: FrozenManifest,
  released: Readonly<Record<number, string>>,
): string[] {
  const problems: string[] = [];
  const entry = manifest[String(live)];
  if (entry === undefined) problems.push(`no-entry:${live}`);
  else {
    for (const [path, hash] of Object.entries(files)) {
      if (!Object.hasOwn(entry, path)) problems.push(`unlisted:${path}`);
      else if (entry[path] !== hash) problems.push(`changed:${path}`);
    }
    for (const path of Object.keys(entry)) {
      if (!Object.hasOwn(files, path)) problems.push(`gone:${path}`);
    }
  }
  for (const [version, pin] of Object.entries(released)) {
    const frozen = manifest[version];
    if (frozen === undefined) problems.push(`released-missing:${version}`);
    else if (entryHash(frozen) !== pin) problems.push(`released-changed:${version}`);
  }
  return problems;
}

/**
 * The manifest with the live version's entry rewritten from `files` (`npm run goldens:manifest`).
 * Throws for a released version: its entry never changes.
 */
export function withLiveEntry(
  live: number,
  files: FrozenEntry,
  manifest: FrozenManifest,
  released: Readonly<Record<number, string>>,
): FrozenManifest {
  if (Object.hasOwn(released, live)) {
    throw new Error(`rules ${live} is released: its goldens and manifest entry never change`);
  }
  return { ...manifest, [String(live)]: sorted(files) };
}
