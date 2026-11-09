import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// docs/PRIVACY.md against what the code stores (M14 T16): every key this browser keeps and every
// table the authority keeps, by name, both ways.

const ROOT = new URL('..', import.meta.url).pathname;
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

function shipped(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts'))
    .map((e) => relative(ROOT, join(e.parentPath, e.name)));
}

/** The backticked names in the first column of the table under `heading`. */
function tableNames(doc: string, heading: string): string[] {
  const start = doc.indexOf(`## ${heading}`);
  expect(start, `docs/PRIVACY.md has "## ${heading}"`).toBeGreaterThanOrEqual(0);
  const end = doc.indexOf('\n## ', start + 1);
  return doc
    .slice(start, end < 0 ? undefined : end)
    .split('\n')
    .filter((l) => l.startsWith('| `'))
    .flatMap((l) => [...(l.split('|')[1] ?? '').matchAll(/`([^`]+)`/g)].map((m) => m[1] as string));
}

/** Each storage key the pages read or write: the constant each `getItem`, `setItem` or `removeItem` names. */
function storageKeys(): Map<string, string> {
  const keys = new Map<string, string>();
  for (const file of shipped('src')) {
    const code = read(file);
    for (const m of code.matchAll(/\.(?:getItem|setItem|removeItem)\(\s*([^,)]+)/g)) {
      const arg = (m[1] as string).trim();
      const literal = /^'([^']+)'$/.exec(arg)?.[1];
      const value =
        literal ?? new RegExp(`const ${arg} = '([^']+)'`).exec(code)?.[1] ?? `<${file}: ${arg}>`;
      keys.set(value, file);
    }
  }
  return keys;
}

/** The authority's tables once every migration in `worker/schema.ts` has run, in order. */
function schemaTables(): string[] {
  const code = read('worker/schema.ts');
  const tables = new Set<string>();
  const statement =
    /CREATE TABLE (?:IF NOT EXISTS )?(\w+)|DROP TABLE (\w+)|ALTER TABLE (\w+) RENAME TO (\w+)/g;
  for (const m of code.matchAll(statement)) {
    if (m[1]) tables.add(m[1]);
    else if (m[2]) tables.delete(m[2]);
    else if (m[3] && m[4]) {
      tables.delete(m[3]);
      tables.add(m[4]);
    }
  }
  return [...tables].sort();
}

describe('docs/PRIVACY.md', () => {
  const doc = read('docs/PRIVACY.md');

  it('names every key this browser keeps, and no other', () => {
    const keys = storageKeys();
    expect([...keys.keys()].filter((k) => k.startsWith('<'))).toEqual([]);
    const idb = read('src/ledger/idb-keystore.ts');
    const db = /const DB_NAME = '([^']+)'/.exec(idb)?.[1];
    const store = /const STORE = '([^']+)'/.exec(idb)?.[1];
    const seed = /const SEED_KEY = '([^']+)'/.exec(idb)?.[1];
    const expected = [...keys.keys(), `${db}/${store}/${seed}`].sort();
    expect(tableNames(doc, 'What this browser keeps').sort()).toEqual(expected);
  });

  it('only the known modules reach the browser’s storage, and none sets a cookie or session storage', () => {
    const touching = shipped('src').filter((file) =>
      /\b(localStorage|indexedDB)\b/.test(read(file)),
    );
    expect(touching.sort()).toEqual(
      [
        'src/card/main.ts',
        'src/game/app-session.ts',
        'src/game/capability.ts',
        'src/game/recovery-panel.ts',
        'src/ledger/idb-keystore.ts',
      ].sort(),
    );
    for (const file of shipped('src')) {
      expect(read(file), file).not.toMatch(/\bdocument\.cookie\b|\bsessionStorage\b/);
    }
    // The capability check only asks whether IndexedDB exists.
    expect(read('src/game/capability.ts')).not.toMatch(/indexedDB\.open/);
  });

  it('names every table the authority keeps, and no other', () => {
    expect(tableNames(doc, 'What the authority keeps').sort()).toEqual(schemaTables());
  });

  it('the help panel’s Privacy section follows it: no cookies, the 14-day log, the recovery code', () => {
    const help = read('src/game/help-text.ts');
    const privacy = help.slice(help.indexOf("id: 'privacy'"));
    expect(privacy).toMatch(/14 days/);
    expect(privacy).toMatch(/recovery code/);
    expect(doc).toMatch(/14 days/);
    expect(doc).toMatch(/no cookies/i);
  });
});
