import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type FrozenEntry, type FrozenManifest, withLiveEntry } from '../src/ledger/frozen';
import { RELEASED } from '../src/ledger/registry';
import { RULES_VERSION } from '../src/sim/rules';

// The frozen manifest's file side (ADR 0074): the hashes of every golden file under
// `src/*/__golden__/` (the manifest itself aside), and `npm run goldens:manifest`, which rewrites
// the live rules version's entry and never a released one. The check is `src/ledger/frozen.ts`.

/** The manifest's path from the repository root. */
export const MANIFEST = 'src/ledger/__golden__/frozen.json';

function filesUnder(root: string, dir: string): string[] {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const path = `${dir}/${name}`;
    return statSync(join(root, path)).isDirectory() ? filesUnder(root, path) : [path];
  });
}

/** Every golden file's repository path → the SHA-256 hex of its bytes. */
export function goldenHashes(root: string): FrozenEntry {
  const out: Record<string, string> = {};
  for (const area of readdirSync(join(root, 'src')).sort()) {
    const dir = `src/${area}/__golden__`;
    if (!existsSync(join(root, dir))) continue;
    for (const path of filesUnder(root, dir).sort()) {
      if (path === MANIFEST) continue;
      out[path] = createHash('sha256')
        .update(readFileSync(join(root, path)))
        .digest('hex');
    }
  }
  return out;
}

export function readManifest(root: string): FrozenManifest {
  return JSON.parse(readFileSync(join(root, MANIFEST), 'utf8')) as FrozenManifest;
}

/** Rewrites the live version's entry from the golden files as they are; throws for a released one. */
export function writeManifest(root: string): FrozenManifest {
  // No manifest yet: the live entry starts it.
  const current: FrozenManifest = existsSync(join(root, MANIFEST)) ? readManifest(root) : {};
  const next = withLiveEntry(RULES_VERSION, goldenHashes(root), current, RELEASED);
  writeFileSync(join(root, MANIFEST), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}
