import { fileURLToPath } from 'node:url';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { versionDefine } from './tools/version.mjs';

// Unit tests that take seconds (`heavyTest` in `tests/heavy.ts`): `npm run check` skips them so that
// every stop stays quick, and `npm run check:full` and CI run them on every PR (ADR 0045). The
// timeout covers the slowest, a mesh budget over every archetype on a loaded runner.
const tags = [
  { name: 'heavy', description: 'takes seconds; CI and check:full', timeout: 120_000 },
  // Times the code against a budget: check:full runs these alone, after every other test (ADR 0047).
  { name: 'speed', description: 'a timing budget; run alone', timeout: 120_000 },
];

// Node tests for the shared code, and workerd tests for the Worker (ADRs 0003, 0017).
export default defineConfig({
  test: {
    projects: [
      {
        extends: './vite.config.ts',
        test: {
          name: 'node',
          include: [
            'src/**/*.test.ts',
            'tools/**/*.test.ts',
            'tests/*.test.ts',
            // The directory and the crowds are pure, so the headless harness (M11 T10) and their
            // tests run them here.
            'worker/directory.test.ts',
            'worker/crowds.test.ts',
            // The pure parts at 10,000 members (M13 T3): placement, the directory, the crowds.
            'worker/scale-parts.test.ts',
            // The capacity model is pure arithmetic (M13 T8).
            'worker/capacity.test.ts',
          ],
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
        test: {
          name: 'worker',
          include: ['worker/**/*.test.ts'],
          exclude: [
            'worker/directory.test.ts',
            'worker/crowds.test.ts',
            'worker/scale-parts.test.ts',
            'worker/capacity.test.ts',
          ],
          tags,
        },
      },
    ],
  },
});
