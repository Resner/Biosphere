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
// its own (m2-online.spec.ts: 8787, m2-social.spec.ts: 8788, m2-pond.spec.ts: 8789). The M4 specs
// share one (8790): they use one identity per context, so a crowded pond does not matter to them.
// m4-oldage.spec.ts has its own (8791) with `LIFESPAN_SCALE=0.01`, m4-lifecycle.spec.ts (8792) with `MAX_SESSIONS=2`.
// Every hub runs with `--e2e`, so a hatch without a pinned body finds its drand rounds on disk.
const socialHubPort = 8788;
const pondHubPort = 8789;
const m4HubPort = 8790;
// The old-age spec needs lifespans of 1% (about 45 s), which would cut the other M4 specs short.
const oldAgeHubPort = 8791;
// The lifecycle spec fills a two-seat authority to see the admission queue.
const lifecycleHubPort = 8792;
// The M5 specs share one (8793) with `LIFESPAN_SCALE=0.05` and `MATING_SCALE=0.01`: lives of about 4 min and maturity in seconds.
const m5HubPort = 8793;
// The inspect spec has its own (8794): its creatures would otherwise share a pond with the M5 specs running beside it.
const m5InspectHubPort = 8794;
// The promote spec has its own (8795) for the same reason.
const m5PromoteHubPort = 8795;
// The lifecycle spec has its own (8796) too.
const m5LifecycleHubPort = 8796;
// `--grep-invert` does not reach a project's dependencies, which would run the slow scenarios in the
// PR gate; `test:e2e` sets this instead and every project skips them itself.
const grepInvert = process.env.E2E_SKIP_SLOW ? /@slow/ : undefined;
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
    { name: 'chromium', testIgnore: [SOCIAL, POND], use: { browserName: 'chromium' }, grepInvert },
    // Three-browser scenarios are CPU-bound under software GL: running this one after the rest
    // keeps CI runners from starving the online spec into its timeout.
    {
      name: 'social',
      testMatch: SOCIAL,
      dependencies: ['chromium'],
      use: { browserName: 'chromium' },
      grepInvert,
    },
    // The same for the three-context pond check, after the social one.
    {
      name: 'pond',
      testMatch: POND,
      dependencies: ['social'],
      use: { browserName: 'chromium' },
      grepInvert,
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
      command: `npm run worker:dev -- --e2e --port ${hubPort} --persist-to .wrangler/e2e-state`,
      url: `http://localhost:${hubPort}/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `npm run worker:dev -- --e2e --port ${socialHubPort} --persist-to .wrangler/e2e-state-social`,
      url: `http://localhost:${socialHubPort}/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `npm run worker:dev -- --e2e --port ${pondHubPort} --persist-to .wrangler/e2e-state-pond`,
      url: `http://localhost:${pondHubPort}/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `npm run worker:dev -- --e2e --port ${m4HubPort} --persist-to .wrangler/e2e-state-m4`,
      url: `http://localhost:${m4HubPort}/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `npm run worker:dev -- --e2e --port ${oldAgeHubPort} --persist-to .wrangler/e2e-state-oldage --var LIFESPAN_SCALE:0.01`,
      url: `http://localhost:${oldAgeHubPort}/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `npm run worker:dev -- --e2e --port ${lifecycleHubPort} --persist-to .wrangler/e2e-state-lifecycle --var MAX_SESSIONS:2`,
      url: `http://localhost:${lifecycleHubPort}/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `npm run worker:dev -- --e2e --port ${m5HubPort} --persist-to .wrangler/e2e-state-m5 --var LIFESPAN_SCALE:0.05 --var MATING_SCALE:0.01`,
      url: `http://localhost:${m5HubPort}/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `npm run worker:dev -- --e2e --port ${m5PromoteHubPort} --persist-to .wrangler/e2e-state-m5-promote --var LIFESPAN_SCALE:0.05 --var MATING_SCALE:0.01`,
      url: `http://localhost:${m5PromoteHubPort}/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `npm run worker:dev -- --e2e --port ${m5InspectHubPort} --persist-to .wrangler/e2e-state-m5-inspect --var LIFESPAN_SCALE:0.05 --var MATING_SCALE:0.01`,
      url: `http://localhost:${m5InspectHubPort}/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `npm run worker:dev -- --e2e --port ${m5LifecycleHubPort} --persist-to .wrangler/e2e-state-m5-lifecycle --var LIFESPAN_SCALE:0.02 --var MATING_SCALE:0.01`,
      url: `http://localhost:${m5LifecycleHubPort}/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
