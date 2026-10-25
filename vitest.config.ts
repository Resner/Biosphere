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
        test: { name: 'node', include: ['src/**/*.test.ts', 'tools/**/*.test.ts'] },
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
