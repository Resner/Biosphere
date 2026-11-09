import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CSP_PAGES, CSP_PLACEHOLDER, cspPolicy, withCsp } from './csp.mjs';

const directives = (policy: string): Map<string, string[]> =>
  new Map(
    policy
      .split(';')
      .map((d) => d.trim().split(/\s+/))
      .filter((d) => d[0])
      .map(([name, ...values]) => [name as string, values]),
  );

const AUTHORITY = 'https://biosphere-authority.example.workers.dev';
const LOCAL = ['http://localhost:*', 'ws://localhost:*', 'http://127.0.0.1:*', 'ws://127.0.0.1:*'];

describe('the pages’ Content-Security-Policy', () => {
  it('runs scripts and workers from the site alone, never eval or inline script', () => {
    const policy = cspPolicy(AUTHORITY);
    const d = directives(policy);
    expect(d.get('default-src')).toEqual(["'self'"]);
    expect(d.get('script-src')).toEqual(["'self'"]);
    expect(d.get('worker-src')).toEqual(["'self'"]);
    expect(d.get('object-src')).toEqual(["'none'"]);
    expect(d.get('base-uri')).toEqual(["'none'"]);
    expect(d.get('form-action')).toEqual(["'none'"]);
    expect(policy).not.toContain('unsafe-eval');
    expect(policy).not.toContain('wasm-unsafe-eval');
    expect(policy).not.toMatch(/(^|\s)\*(\s|;|$)/);
  });

  it('connects to the site, the build’s authority and local hubs only', () => {
    expect(directives(cspPolicy(AUTHORITY)).get('connect-src')).toEqual([
      "'self'",
      AUTHORITY,
      'wss://biosphere-authority.example.workers.dev',
      ...LOCAL,
    ]);
    // The authority's origin alone, from any form the build is given.
    for (const url of ['wss://biosphere-authority.example.workers.dev/v1/hub', `${AUTHORITY}/`]) {
      expect(directives(cspPolicy(url)).get('connect-src')?.slice(1, 3)).toEqual([
        AUTHORITY,
        'wss://biosphere-authority.example.workers.dev',
      ]);
    }
    // A build without one (E2E, a fork) reaches local hubs only.
    expect(directives(cspPolicy('')).get('connect-src')).toEqual(["'self'", ...LOCAL]);
    expect(() => cspPolicy('not a url')).toThrow(/AUTHORITY_URL/);
    expect(() => cspPolicy('ftp://x.example')).toThrow(/AUTHORITY_URL/);
  });

  it.each(CSP_PAGES)('%s carries the policy’s meta before any script or link', (page) => {
    const html = readFileSync(new URL(`../${page}`, import.meta.url), 'utf8');
    const meta = `<meta http-equiv="Content-Security-Policy" content="${CSP_PLACEHOLDER}" />`;
    const at = html.indexOf(meta);
    expect(at, `${page} has the CSP meta`).toBeGreaterThan(0);
    expect(at).toBeLessThan(html.indexOf('<link'));
    expect(at).toBeLessThan(html.indexOf('<script'));
    // No inline script or handler the policy would block.
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(withCsp(html, cspPolicy(''))).toContain(`content="${cspPolicy('')}"`);
  });

  it('fails the build of a page without the meta', () => {
    expect(() => withCsp('<html><head></head></html>', cspPolicy(''))).toThrow(/CSP meta/);
  });

  it('the build writes it into every page it builds', () => {
    const config = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
    for (const page of CSP_PAGES) expect(config).toContain(`'${page}'`);
    expect(config).toMatch(/withCsp\(/);
  });
});
