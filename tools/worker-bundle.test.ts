import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect } from 'vitest';
import rounds from '../tests/fixtures/drand/rounds.json';
import { heavyTest } from '../tests/heavy';

// The recorded drand rounds serve the E2E Worker only: the production bundle must not carry them.

const out = mkdtempSync(join(tmpdir(), 'bs-bundle-'));
afterAll(() => rmSync(out, { recursive: true, force: true }));

const built = new Map<string, string>();

function bundle(e2e: boolean, main: string): string {
  const cached = built.get(main);
  if (cached !== undefined) return cached;
  const dir = join(out, main);
  const tool = fileURLToPath(new URL('./worker.mjs', import.meta.url));
  const run = spawnSync(
    'node',
    [tool, 'deploy', '--dry-run', '--outdir', dir, ...(e2e ? ['--e2e'] : [])],
    { encoding: 'utf8' },
  );
  expect(run.status, run.stderr).toBe(0);
  const code = readFileSync(join(dir, main), 'utf8');
  built.set(main, code);
  return code;
}

describe('worker bundles', () => {
  const marker = rounds.beacons[0]?.signature as string;

  heavyTest('production has no fixture data', () => {
    const code = bundle(false, 'index.js');
    expect(code).not.toContain(marker);
    expect(code).not.toContain('fixtureSource');
    // Nor the E2E hook that stages a player from before the world renewal (M6c T2).
    expect(code).not.toContain('/v1/e2e/');
  });

  // The scales that shorten a test world's clocks (ADR 0055) are read in one place, behind the
  // fixture source, so production always runs the live rulebook.
  heavyTest('production honours no scale outside fixture mode', () => {
    const code = bundle(false, 'index.js');
    const reads = code.match(/[\w$.]*\b(LIFESPAN|MATING)_SCALE\b/g) ?? [];
    expect(reads.sort()).toEqual(['env.LIFESPAN_SCALE', 'env.MATING_SCALE']);
    expect(code).toContain('fixtureScale(env, env.LIFESPAN_SCALE)');
    expect(code).toContain('fixtureScale(env, env.MATING_SCALE)');
    expect(code).toMatch(
      /function fixtureScale\(env, value\) \{\s*const scale = Number\(value\);\s*return env\.DRAND_SOURCE === "fixture" && /,
    );
  });

  // The witness variables (M10 T4): the play needed, the IP check and a pond's capacity are each
  // read once, behind the fixture source.
  heavyTest('production honours no witness variable outside fixture mode', () => {
    const code = bundle(false, 'index.js');
    const reads =
      code.match(/[\w$.]*\b(WITNESS_PLAY_MS|WITNESS_IP_CHECK|POND_MAX)\b(?! = )/g) ?? [];
    expect(reads.sort()).toEqual([
      'WITNESS_PLAY_MS',
      'WITNESS_PLAY_MS',
      'env.POND_MAX',
      'env.WITNESS_IP_CHECK',
      'env.WITNESS_PLAY_MS',
    ]);
    expect(code).toContain(
      'env.DRAND_SOURCE === "fixture" ? Number(env.WITNESS_PLAY_MS) : Number.NaN',
    );
    expect(code).toContain('env.DRAND_SOURCE === "fixture" && env.WITNESS_IP_CHECK === "off"');
    expect(code).toContain('env.DRAND_SOURCE === "fixture" ? Number(env.POND_MAX) : Number.NaN');
  });

  // The directory's leaf cap and its jumps (M11 T6) follow the fixture source too.
  heavyTest('production honours no directory variable outside fixture mode', () => {
    const code = bundle(false, 'index.js');
    expect(code.match(/[\w$.]*\bLEAF_MAX\b(?! = )/g)?.filter((r) => r.startsWith('env.'))).toEqual([
      'env.LEAF_MAX',
    ]);
    expect(code).toContain('env.DRAND_SOURCE === "fixture" ? Number(env.LEAF_MAX) : Number.NaN');
    expect(code).toContain('const jumpsTaken = (env) => env.DRAND_SOURCE === "fixture"');
  });

  heavyTest('the E2E entry carries the recorded rounds', () => {
    const code = bundle(true, 'e2e-entry.js');
    expect(code).toContain(marker);
    expect(code).toContain('/v1/e2e/pre-reset');
    // And the restart hook (M8 T5), which only the E2E entry may carry.
    expect(code).toContain('/v1/e2e/restart');
    // And the fight state a scenario waits on (M8 T9).
    expect(code).toContain('/v1/e2e/encounter/');
    // And an event's witnesses (M10 T4).
    expect(code).toContain('/v1/e2e/witness/');
    // And the directory (M11 T6).
    expect(code).toContain('/v1/e2e/directory');
  });
});
