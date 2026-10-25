import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const BANNED_WORDS = [
  'Date',
  'performance',
  'crypto',
  'setTimeout',
  'setInterval',
  'requestAnimationFrame',
  'window',
  'document',
];
const BANNED_IMPORTS = [/from\s+['"]three['"]/, /from\s+['"]\.\.\/render/, /from\s+['"]\.\.\/net/];
// Only these Math members are exactly specified; the rest are engine-dependent (ADR 0005).
const ALLOWED_MATH = new Set([
  'sqrt',
  'floor',
  'ceil',
  'round',
  'trunc',
  'abs',
  'min',
  'max',
  'sign',
  'fround',
  'imul',
  'clz32',
  'PI',
  'SQRT2',
  'LOG2E',
]);

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/** Returns one message per banned construct found in non-comment source. */
function scanSource(source: string): string[] {
  const code = stripComments(source);
  const found: string[] = [];
  for (const m of code.matchAll(/\bMath\s*\??\.\s*(\w+)/g)) {
    const member = m[1] as string;
    if (!ALLOWED_MATH.has(member)) found.push(`Math.${member}`);
  }
  for (const word of BANNED_WORDS) {
    if (new RegExp(`\\b${word}\\b`).test(code)) found.push(word);
  }
  if (/\*\*/.test(code)) found.push('**'); // same engine-dependent pow as Math.pow
  if (/\bglobalThis\b|\bimport\s*\(|=\s*Math\s*[;,)]|\bMath\s*\[/.test(code))
    found.push('indirect');
  for (const re of BANNED_IMPORTS) {
    if (re.test(code)) found.push(String(re));
  }
  return found;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

describe('sim determinism guard', () => {
  it('reports banned constructs in a fixture', () => {
    expect(scanSource('const x = Math.random();')).toEqual(['Math.random']);
    expect(scanSource('const t = Date.now();')).toEqual(['Date']);
    expect(scanSource("import * as T from 'three';")).toHaveLength(1);
    expect(scanSource('const y = 2 ** x;')).toEqual(['**']);
    expect(scanSource("const M = Math; M.sin(1); Math['cos'](1);")).toEqual(['indirect']);
    expect(scanSource('const { sin } = Math;')).toEqual(['indirect']);
    expect(scanSource('Math?.sin(1); Math . exp(1);')).toEqual(['Math.sin', 'Math.exp']);
    expect(scanSource('// Math.random() in a comment\nconst y = Math.sqrt(2);')).toEqual([]);
  });

  it('finds no banned API in src/sim', () => {
    const root = fileURLToPath(new URL('.', import.meta.url));
    const offenders: string[] = [];
    for (const file of sourceFiles(root)) {
      for (const hit of scanSource(readFileSync(file, 'utf8'))) offenders.push(`${file}: ${hit}`);
    }
    expect(offenders).toEqual([]);
  });
});
