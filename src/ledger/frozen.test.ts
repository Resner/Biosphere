import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { goldenHashes, MANIFEST, readManifest } from '../../tools/goldens-manifest';
import { RULES_VERSION } from '../sim/rules';
import { entryHash, manifestProblems, withLiveEntry } from './frozen';
import { RELEASED } from './registry';

// The frozen manifest (M14 T1, ADR 0074): every golden file under `src/*/__golden__/` is listed
// with its hash under the live rules version, and a released version's entry is pinned by
// `RELEASED`. After a golden changes (allowed only while its version is unreleased), run
// `npm run goldens:manifest`.

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const files = goldenHashes(ROOT);
const manifest = readManifest(ROOT);

describe('the frozen manifest', () => {
  it('lists every golden file of the live rules version with its hash', () => {
    expect(Object.keys(files).length).toBeGreaterThan(20);
    expect(Object.keys(files)).not.toContain(MANIFEST);
    for (const area of ['genome', 'ledger', 'sim']) {
      expect(Object.keys(files).some((p) => p.startsWith(`src/${area}/__golden__/`))).toBe(true);
    }
    expect(
      manifestProblems(RULES_VERSION, files, manifest, RELEASED),
      'a golden file differs from src/ledger/__golden__/frozen.json: if its rules version is unreleased, run `npm run goldens:manifest`',
    ).toEqual([]);
  });

  it('pins rules 13, v1.0.0’s, to the hash of its manifest entry', () => {
    expect(RELEASED).toEqual({ 13: entryHash(manifest['13'] ?? {}) });
  });

  it('fails when one byte of a golden file changes, or a golden file is added or removed', () => {
    const [path, hash] = Object.entries(files)[0] ?? ['', ''];
    const flipped = `${hash[0] === '0' ? '1' : '0'}${hash.slice(1)}`;
    expect(manifestProblems(RULES_VERSION, { ...files, [path]: flipped }, manifest, {})).toEqual([
      `changed:${path}`,
    ]);
    const added = 'src/sim/__golden__/new.json';
    expect(manifestProblems(RULES_VERSION, { ...files, [added]: hash }, manifest, {})).toEqual([
      `unlisted:${added}`,
    ]);
    const { [path]: _gone, ...fewer } = files;
    expect(manifestProblems(RULES_VERSION, fewer, manifest, {})).toEqual([`gone:${path}`]);
    expect(manifestProblems(RULES_VERSION + 1, files, manifest, {})).toEqual([
      `no-entry:${RULES_VERSION + 1}`,
    ]);
  });

  it('passes again once the live entry is rewritten (`npm run goldens:manifest`)', () => {
    const changed = { ...files, 'src/sim/__golden__/new.json': 'ab'.repeat(32) };
    expect(manifestProblems(RULES_VERSION, changed, manifest, {})).not.toEqual([]);
    const rewritten = withLiveEntry(RULES_VERSION, changed, manifest, {});
    expect(manifestProblems(RULES_VERSION, changed, rewritten, {})).toEqual([]);
    // Paths stay in order, so the file's text is stable.
    const paths = Object.keys(rewritten[String(RULES_VERSION)] ?? {});
    expect(paths).toEqual([...paths].sort());
  });

  it('fails when a released version’s entry hashes to anything but its pin', () => {
    const entry = manifest[String(RULES_VERSION)] ?? {};
    const pin = entryHash(entry);
    expect(pin).toMatch(/^[0-9a-f]{64}$/);
    expect(manifestProblems(RULES_VERSION, files, manifest, { [RULES_VERSION]: pin })).toEqual([]);
    expect(
      manifestProblems(RULES_VERSION, files, manifest, { [RULES_VERSION]: 'ab'.repeat(32) }),
    ).toEqual([`released-changed:${RULES_VERSION}`]);
    expect(manifestProblems(RULES_VERSION, files, manifest, { 99: pin })).toEqual([
      'released-missing:99',
    ]);
  });

  it('never rewrites a released version’s entry', () => {
    const pin = entryHash(manifest[String(RULES_VERSION)] ?? {});
    expect(() => withLiveEntry(RULES_VERSION, files, manifest, { [RULES_VERSION]: pin })).toThrow(
      /released/,
    );
  });
});
