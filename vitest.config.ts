import { fileURLToPath } from 'node:url';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { versionDefine } from './tools/version.mjs';

// Unit tests that take seconds (`heavyTest` in `tests/heavy.ts`): `npm run check` skips them so that
// every stop stays quick, and `npm run check:full` and CI run them on every PR (ADR 0045). The
// timeout covers the slowest, a mesh budget over every archetype on a loaded runner.
const tags = [{ name: 'heavy', description: 'takes seconds; CI and check:full', timeout: 120_000 }];

// Node tests for the shared code, and workerd tests for the Worker (ADRs 0003, 0017).
export default defineConfig({
  test: {
    projects: [
      {
        extends: './vite.config.ts',
        test: {
          name: 'node',
          include: ['src/**/*.test.ts', 'tools/**/*.test.ts'],
          // Untagged tests take under about 2 s; this leaves room for a loaded runner.
          testTimeout: 20_000,
          tags,
        },
      },
      {
        define: versionDefine(),
        plugins: [
          cloudflareTest({
            wrangler: {
              configPath: fileURLToPath(new URL('./worker/wrangler.jsonc', import.meta.url)),
            },
          }),
        ],
        test: { name: 'worker', include: ['worker/**/*.test.ts'], tags },
      },
    ],
  },
});
