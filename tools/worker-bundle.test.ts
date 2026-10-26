import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import rounds from '../tests/fixtures/drand/rounds.json';

// The recorded drand rounds serve the E2E Worker only: the production bundle must not carry them.

const out = mkdtempSync(join(tmpdir(), 'bs-bundle-'));
afterAll(() => rmSync(out, { recursive: true, force: true }));

function bundle(config: string, main: string): string {
  const dir = join(out, config);
  const path = fileURLToPath(new URL(`../worker/${config}`, import.meta.url));
  const run = spawnSync(
    'npx',
    ['wrangler', 'deploy', '--dry-run', '--outdir', dir, '-c', path, '--define', '__VERSION__:"t"'],
    { encoding: 'utf8' },
  );
  expect(run.status, run.stderr).toBe(0);
  return readFileSync(join(dir, main), 'utf8');
}

describe('worker bundles', () => {
  const marker = rounds.beacons[0]?.signature as string;

  it('production has no fixture data', () => {
    const code = bundle('wrangler.jsonc', 'index.js');
    expect(code).not.toContain(marker);
    expect(code).not.toContain('fixtureSource');
  }, 60_000);

  it('the E2E entry carries the recorded rounds', () => {
    const code = bundle('wrangler.e2e.jsonc', 'e2e-entry.js');
    expect(code).toContain(marker);
  }, 60_000);
});
