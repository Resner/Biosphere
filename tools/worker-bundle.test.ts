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

function bundle(e2e: boolean, main: string): string {
  const dir = join(out, main);
  const tool = fileURLToPath(new URL('./worker.mjs', import.meta.url));
  const run = spawnSync(
    'node',
    [tool, 'deploy', '--dry-run', '--outdir', dir, ...(e2e ? ['--e2e'] : [])],
    { encoding: 'utf8' },
  );
  expect(run.status, run.stderr).toBe(0);
  return readFileSync(join(dir, main), 'utf8');
}

describe('worker bundles', () => {
  const marker = rounds.beacons[0]?.signature as string;

  it('production has no fixture data', () => {
    const code = bundle(false, 'index.js');
    expect(code).not.toContain(marker);
    expect(code).not.toContain('fixtureSource');
    // Nor the E2E hook that stages a player from before the world renewal (M6c T2).
    expect(code).not.toContain('/v1/e2e/');
  }, 60_000);

  it('the E2E entry carries the recorded rounds', () => {
    const code = bundle(true, 'e2e-entry.js');
    expect(code).toContain(marker);
    expect(code).toContain('/v1/e2e/pre-reset');
  }, 60_000);
});
