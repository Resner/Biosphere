import { fileURLToPath } from 'node:url';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { versionDefine } from '../tools/version.ts';

export default defineConfig({
  define: versionDefine(),
  plugins: [
    cloudflareTest({
      wrangler: { configPath: fileURLToPath(new URL('./wrangler.jsonc', import.meta.url)) },
    }),
  ],
  test: { name: 'worker', include: ['**/*.test.ts'] },
});
