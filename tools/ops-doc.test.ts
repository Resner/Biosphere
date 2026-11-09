import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import metrics from '../tests/fixtures/ops/metrics-idle.json';
import { SECTIONS } from './ops-lines';

// The runbook's references (M14 T15): everything `docs/OPERATIONS.md` names exists, so the page
// can't drift from the repository without a test saying so.

const root = new URL('..', import.meta.url).pathname;
const read = (path: string): string => readFileSync(join(root, path), 'utf8');
const doc = read('docs/OPERATIONS.md');

/** Every file under `dir` (relative to the root) whose name passes `keep`, as text joined. */
function sources(dir: string, keep: (name: string) => boolean): string {
  const out: string[] = [];
  const walk = (at: string) => {
    for (const name of readdirSync(join(root, at))) {
      const path = `${at}/${name}`;
      if (statSync(join(root, path)).isDirectory()) {
        if (name !== 'node_modules' && !name.startsWith('.wrangler')) walk(path);
      } else if (keep(name)) out.push(read(path));
    }
  };
  walk(dir);
  return out.join('\n');
}

const matches = (re: RegExp): string[] => [
  ...new Set([...doc.matchAll(re)].map((m) => m[1] as string)),
];
const spans = matches(/`([^`\n]+)`/g);

describe('docs/OPERATIONS.md', () => {
  it('names only npm scripts that exist', () => {
    const scripts = Object.keys(JSON.parse(read('package.json')).scripts as Record<string, string>);
    const named = matches(/npm run ([\w:-]+)/g);
    expect(named).toContain('ops:watch');
    for (const script of named) expect(scripts, `npm run ${script}`).toContain(script);
  });

  it('names only workflows that exist', () => {
    const files = readdirSync(join(root, '.github/workflows'));
    const named = matches(/\b([\w-]+\.yml)\b/g);
    expect(named).toContain('release.yml');
    for (const file of named) expect(files, file).toContain(file);
  });

  it('names only endpoints the Worker serves', () => {
    const worker = sources('worker', (n) => n.endsWith('.ts') && !n.endsWith('.test.ts'));
    const named = matches(/(\/v1\/[a-z]+)/g);
    expect(named).toEqual(expect.arrayContaining(['/v1/metrics', '/v1/audit', '/v1/health']));
    for (const path of named) expect(worker, path).toContain(`'${path}`);
  });

  it('names only variables and secrets that the workflows, the Worker or the setup page use', () => {
    const known = [
      sources('.github/workflows', () => true),
      sources('worker', (n) => /\.(ts|jsonc)$/.test(n) && !n.endsWith('.test.ts')),
      read('docs/SETUP.md'),
    ].join('\n');
    // `WARN` and `ERROR` are the labels of the watch's own lines.
    const named = spans.filter(
      (s) => /^[A-Z][A-Z0-9_]{3,}$/.test(s) && !['WARN', 'ERROR'].includes(s),
    );
    for (const s of ['CLOUDFLARE_PLAN', 'CLOUDFLARE_API_TOKEN', 'CF_TURN_KEY_ID', 'AUTHORITY_URL'])
      expect(named, s).toContain(s);
    for (const name of named) expect(known, name).toContain(name);
  });

  it('names only files that exist', () => {
    const named = spans.filter((s) => /^(docs|src|worker|tools|tests)\/[\w./-]+\.\w+$/.test(s));
    expect(named).toContain('docs/CAPACITY.md');
    for (const path of named) expect(() => statSync(join(root, path)), path).not.toThrow();
  });

  it('names only fields that /v1/metrics holds', () => {
    const named = spans.filter(
      (s) => /^[a-z]+\.[a-zA-Z.]+$/.test(s) && !/\.(yml|ts|md|json|mjs)$/.test(s),
    );
    expect(named).toContain('month.relayKb');
    for (const path of named) {
      let at: unknown = metrics;
      for (const key of path.split('.')) {
        expect(at, path).toBeTypeOf('object');
        expect(at, path).toHaveProperty(key);
        at = (at as Record<string, unknown>)[key];
      }
    }
  });

  it('explains every flag kind the authority raises, and names no other', () => {
    const audit = read('worker/audit.ts');
    const kinds = [...audit.matchAll(/^ {2}'?([a-z-]+)'?: '(?:request|creature)',$/gm)].map(
      (m) => m[1] as string,
    );
    expect(kinds.length).toBeGreaterThanOrEqual(17);
    for (const kind of kinds) expect(spans, `flag kind ${kind}`).toContain(kind);
    // A kind-like name in the flags section that the catalogue lacks would be a typo.
    const section = doc.slice(
      doc.indexOf('### A spike in flags'),
      doc.indexOf('### The authority is unreachable'),
    );
    const mentioned = [...section.matchAll(/`([a-z]+(?:-[a-z]+)+)`/g)].map((m) => m[1] as string);
    for (const kind of mentioned) expect(kinds, kind).toContain(kind);
  });

  it('has a section for every warning ops:watch points at', () => {
    const headings = [...doc.matchAll(/^### (.+)$/gm)].map((m) => m[1] as string);
    for (const section of Object.values(SECTIONS)) expect(headings, section).toContain(section);
  });

  it('is linked from the setup page and the project instructions', () => {
    expect(read('docs/SETUP.md')).toContain('docs/OPERATIONS.md');
    expect(read('CLAUDE.md')).toContain('docs/OPERATIONS.md');
  });
});
