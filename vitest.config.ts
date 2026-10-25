import { defineConfig } from 'vitest/config';

// Node tests for the shared code, and workerd tests for the Worker (ADR 0003).
export default defineConfig({
  test: {
    projects: [
      { extends: './vite.config.ts', test: { name: 'node', include: ['src/**/*.test.ts'] } },
      './worker/vitest.config.ts',
    ],
  },
});
