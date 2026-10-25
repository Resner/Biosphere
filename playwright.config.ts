import { existsSync } from 'node:fs';
import { chromium, defineConfig } from '@playwright/test';

// Cloud sessions pre-install one Chromium build. When the pinned Playwright expects a different
// build (for example after a Dependabot bump), launch the pre-installed one instead.
const preinstalled = '/opt/pw-browsers/chromium';
const executablePath =
  !existsSync(chromium.executablePath()) && existsSync(preinstalled) ? preinstalled : undefined;

const port = 4173;
const hubPort = 8787;
// Files run in parallel and a hub fills the fullest pond first, so each file that uses a hub gets
// its own (m2-online.spec.ts: 8787, m2-social.spec.ts: 8788, m2-pond.spec.ts: 8789).
const socialHubPort = 8788;
const pondHubPort = 8789;
const SOCIAL = /m2-social\.spec\.ts/;
const POND = /m2-pond\.spec\.ts/;

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
    // Chromium hides local IPs behind mDNS names that the sandbox cannot resolve; the E2E peers
    // connect over host candidates only (no STUN, TURN or relays).
    launchOptions: {
      ...(executablePath ? { executablePath } : {}),
      args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
    },
  },
  projects: [
    { name: 'chromium', testIgnore: [SOCIAL, POND], use: { browserName: 'chromium' } },
    // Three-browser scenarios are CPU-bound under software GL: running this one after the rest
    // keeps CI runners from starving the online spec into its timeout.
    {
      name: 'social',
      testMatch: SOCIAL,
      dependencies: ['chromium'],
      use: { browserName: 'chromium' },
    },
    // The same for the three-context pond check, after the social one.
    {
      name: 'pond',
      testMatch: POND,
      dependencies: ['social'],
      use: { browserName: 'chromium' },
    },
  ],
  webServer: [
    {
      command: `npm run preview -- --port ${port} --strictPort`,
      url: `http://localhost:${port}/`,
      reuseExistingServer: !process.env.CI,
    },
    {
      // The authority, locally: the same Worker and Durable Object, with fresh state per run.
      command: `npm run worker:dev -- --port ${hubPort} --persist-to .wrangler/e2e-state`,
      url: `http://localhost:${hubPort}/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `npm run worker:dev -- --port ${socialHubPort} --persist-to .wrangler/e2e-state-social`,
      url: `http://localhost:${socialHubPort}/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `npm run worker:dev -- --port ${pondHubPort} --persist-to .wrangler/e2e-state-pond`,
      url: `http://localhost:${pondHubPort}/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
