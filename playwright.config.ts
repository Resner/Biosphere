import { existsSync } from 'node:fs';
import { chromium, defineConfig } from '@playwright/test';

// Cloud sessions pre-install one Chromium build. When the pinned Playwright expects a different
// build (for example after a Dependabot bump), launch the pre-installed one instead.
const preinstalled = '/opt/pw-browsers/chromium';
const executablePath =
  !existsSync(chromium.executablePath()) && existsSync(preinstalled) ? preinstalled : undefined;

const port = 4173;

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://localhost:${port}/`,
    viewport: { width: 960, height: 540 },
    trace: 'retain-on-failure',
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: `npm run preview -- --port ${port} --strictPort`,
    url: `http://localhost:${port}/`,
    reuseExistingServer: !process.env.CI,
  },
});
