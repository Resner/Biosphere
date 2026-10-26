import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('..', import.meta.url);

function sources(dir: string): { path: string; text: string }[] {
  return readdirSync(new URL(`${dir}/`, root), { recursive: true })
    .map(String)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => ({
      path: `${dir}/${name}`,
      text: readFileSync(new URL(`${dir}/${name}`, root), 'utf8'),
    }));
}

const specifiers = (text: string): string[] =>
  [...text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1] as string);

describe('dependency direction (ADR 0018)', () => {
  it('src/genome imports only src/sim, itself and noble hashes', () => {
    const files = sources('genome');
    expect(files.length).toBeGreaterThan(0);
    for (const { path, text } of files) {
      for (const spec of specifiers(text)) {
        const ok =
          spec.startsWith('./') || spec.startsWith('../sim/') || spec.startsWith('@noble/hashes/');
        expect(ok, `${path} imports ${spec}`).toBe(true);
      }
      expect(text, path).not.toMatch(/\b(document|window|navigator)\./);
    }
  });

  it('src/sim never imports src/genome', () => {
    for (const { path, text } of sources('sim')) {
      for (const spec of specifiers(text)) expect(spec, path).not.toMatch(/genome/);
    }
  });
});
