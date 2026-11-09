import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// The security review's source checks (M14 T16, docs/SECURITY.md).

const ROOT = new URL('..', import.meta.url).pathname;

/** Shipped source: the pages' code and the Worker, without tests and test kits. */
function sources(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts'))
    .map((e) => relative(ROOT, join(e.parentPath, e.name)));
}

const SINK =
  /\.(innerHTML|outerHTML)\s*\+?=\s*([^;\n]+)|\b(insertAdjacentHTML|document\.write(?:ln)?)\s*\(/g;

/**
 * Every place that hands markup to the DOM, as `file: the markup's expression`. Each is a static
 * template of the file's own (a constant, or a constant picked by a key the file defines), never
 * text from a player, a peer, the authority or the URL.
 */
const STATIC_MARKUP = new Set([
  // The pond map's marks: `MARKS`, one SVG body per mark kind.
  'src/game/pond-map.ts: MARKS[mark.mark]',
  // The edge indicators' arrows and heart: `ARROWS` by size class, and `HEART`.
  'src/game/indicators.ts: ARROWS[shape]',
  'src/game/indicators.ts: HEART',
  // The icon set: `iconMarkup(name)` builds from `ICONS`, keyed by `IconName`.
  'src/game/icons.ts: iconMarkup(name)',
]);

describe('markup sinks', () => {
  const found = ['src', 'worker'].flatMap((dir) =>
    sources(dir).flatMap((file) =>
      [...readFileSync(join(ROOT, file), 'utf8').matchAll(SINK)].map((m) =>
        m[2] ? `${file}: ${m[2].trim()}` : `${file}: ${m[3]}(`,
      ),
    ),
  );

  it('hand the DOM only static templates: no innerHTML, outerHTML, insertAdjacentHTML or document.write of anything else', () => {
    expect(found.filter((f) => !STATIC_MARKUP.has(f))).toEqual([]);
  });

  it('list no place that is gone', () => {
    expect([...STATIC_MARKUP].filter((f) => !found.includes(f))).toEqual([]);
  });

  it('each allowed template is the file’s own constant', () => {
    const constants: Record<string, RegExp> = {
      'src/game/pond-map.ts': /^const MARKS: Record<[^>]+> = \{$/m,
      'src/game/indicators.ts': /^const (ARROWS: Record<[^>]+> = \{|HEART = '<path )/m,
      'src/game/icons.ts': /^export function iconMarkup\(name: IconName\): string \{$/m,
    };
    for (const [file, decl] of Object.entries(constants)) {
      expect(readFileSync(join(ROOT, file), 'utf8'), file).toMatch(decl);
    }
    // The icon markup's only inputs are the icon table's own strings.
    const icons = readFileSync(join(ROOT, 'src/game/icons.ts'), 'utf8');
    const body = icons.slice(icons.indexOf('export function iconMarkup'));
    expect(body.slice(0, body.indexOf('\n}\n'))).toMatch(
      /const \{ title, body \} = ICONS\[name\];/,
    );
  });

  it('no shipped code evaluates strings as code', () => {
    const evals = ['src', 'worker'].flatMap((dir) =>
      sources(dir).filter((file) =>
        /\beval\s*\(|new Function\s*\(|setTimeout\s*\(\s*['"`]|setInterval\s*\(\s*['"`]/.test(
          readFileSync(join(ROOT, file), 'utf8'),
        ),
      ),
    );
    expect(evals).toEqual([]);
  });
});

describe('the built site', () => {
  it('bakes in two public values only: the release tag and the authority’s URL', () => {
    const config = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8');
    const define = config.slice(
      config.indexOf('define: {'),
      config.indexOf('},', config.indexOf('define: {')),
    );
    expect([...define.matchAll(/process\.env\.(\w+)/g)].map((m) => m[1])).toEqual([
      'BUILD_LABEL',
      'AUTHORITY_URL',
    ]);
    expect([...config.matchAll(/process\.env\.(\w+)/g)].map((m) => m[1]).sort()).toEqual([
      'AUTHORITY_URL',
      'AUTHORITY_URL',
      'BUILD_LABEL',
    ]);
    // Nothing reads the environment from the pages' code, where Vite would inline it.
    const reading = sources('src').filter((file) =>
      /import\.meta\.env|process\.env/.test(readFileSync(join(ROOT, file), 'utf8')),
    );
    expect(reading).toEqual([]);
  });
});

/** The surfaces docs/SECURITY.md must cover, by the words its table names them with. */
const SURFACES = [
  'hub messages',
  'peer events',
  'snapshots',
  'witness messages',
  '/v1/proof',
  '/v1/fight',
  '/v1/metrics',
  '/v1/audit',
  '/v1/pubkeys',
  '/v1/health',
  '?hub=',
  '?genome=',
  '?c=',
  'paste box',
  'recovery import',
  'names',
  'chat',
  'E2E entry',
  'secrets',
  'the built site',
  'deterministic replay',
  'the pages',
] as const;

describe('docs/SECURITY.md', () => {
  const doc = readFileSync(join(ROOT, 'docs/SECURITY.md'), 'utf8');
  const surfaceRows = doc
    .slice(doc.indexOf('## Surfaces'), doc.indexOf('\n## ', doc.indexOf('## Surfaces') + 1))
    .split('\n')
    .filter((l) => l.startsWith('| ') && !l.startsWith('| Surface') && !l.startsWith('|--'));

  it('has a row for every surface', () => {
    for (const surface of SURFACES) {
      expect(
        surfaceRows.some((row) =>
          (row.split('|')[1] ?? '').toLowerCase().includes(surface.toLowerCase()),
        ),
        surface,
      ).toBe(true);
    }
  });

  it('names an existing test or document for every surface', () => {
    for (const row of surfaceRows) {
      const checks = row.split('|')[3] ?? '';
      const paths = [...checks.matchAll(/`([\w./-]+\.(?:ts|md|mjs|yml|jsonc))(?:::[^`]*)?`/g)].map(
        (m) => m[1] as string,
      );
      expect(paths.length, row).toBeGreaterThan(0);
      for (const path of paths)
        expect(existsSync(join(ROOT, path)), `${path} in ${row}`).toBe(true);
    }
  });

  it('every file it cites exists', () => {
    const cited = [
      ...doc.matchAll(/`((?:src|worker|tools|tests|docs|\.github)\/[\w./-]+)(?:::[^`]*)?`/g),
    ];
    for (const [, path] of cited) {
      expect(existsSync(join(ROOT, path as string)), path).toBe(true);
    }
  });

  it('records the dependency audit', () => {
    expect(doc).toMatch(/`npm audit --omit=dev`/);
  });
});
