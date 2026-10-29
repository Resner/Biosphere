import { fileURLToPath } from 'node:url';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { versionDefine } from './tools/version.mjs';

// Node tests for the shared code, and workerd tests for the Worker (ADRs 0003, 0017).
export default defineConfig({
  test: {
    projects: [
      {
        extends: './vite.config.ts',
        test: {
          name: 'node',
          include: ['src/**/*.test.ts', 'tools/**/*.test.ts'],
          // The 10,000-genome property tests take 3-7 s here and over 5 s on a loaded
          // CI runner; the v0.7.0 release run timed out in one.
          testTimeout: 30_000,
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
        test: { name: 'worker', include: ['worker/**/*.test.ts'] },
      },
    ],
  },
});
