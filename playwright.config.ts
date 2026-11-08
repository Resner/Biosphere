import { existsSync } from 'node:fs';
import { cpus } from 'node:os';
import { chromium, defineConfig } from '@playwright/test';

// Cloud sessions pre-install one Chromium build. When the pinned Playwright expects a different
// build (for example after a Dependabot bump), launch the pre-installed one instead.
const preinstalled = '/opt/pw-browsers/chromium';
const executablePath =
  !existsSync(chromium.executablePath()) && existsSync(preinstalled) ? preinstalled : undefined;

// CI pins two workers (ADR 0044): since 2026-11-01 the default (half the CPUs Node reports) has
// given one worker on runners that report four cores to every other probe, which doubled the suite's
// time. The main process logs what it sees, so a runner change shows in the log.
const CI_WORKERS = 2;
if (process.env.CI && !process.env.TEST_WORKER_INDEX) {
  console.log(`playwright: ${cpus().length} CPUs reported, ${CI_WORKERS} workers`);
}

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
// The M6 finding spec (8797): two players alone in a pond, placed apart by teleport.
const m6FindHubPort = 8797;
// The M6 egg spec (8798), with the M5 hooks: two players mate and hatch, alone in their pond.
const m6EggHubPort = 8798;
// The M6 wheel spec (8799): two players alone in a pond send pings and emotes from the wheel.
const m6WheelHubPort = 8799;
// The M6 lifecycle spec (8800), with the M5 hooks: two players hatch, grow, find each other, mate and promote.
const m6LifecycleHubPort = 8800;
// The M6b egg spec (8801), with the M5 hooks: genesis reveals on the title and death screens.
const m6bEggHubPort = 8801;
// The M6b minimap spec (8802): two players alone in a pond, placed apart by teleport.
const m6bMinimapHubPort = 8802;
// The M6b lifecycle spec (8803), with the M5 hooks: the end-to-end scenario of the M6b exit criteria.
const m6bLifecycleHubPort = 8803;
// The M6c reset spec (8804): a player staged from before the world renewal sees the notice once.
const m6cResetHubPort = 8804;
// The M6c egg spec (8805), with the M5 hooks: the still scene, the charge and the paced crack.
const m6cEggHubPort = 8805;
// The M6c lifecycle spec (8806), with the M5 hooks and the E2E hook that stages a pre-reset player.
const m6cLifecycleHubPort = 8806;
// The M7 duel spec (8807): two players hatch, one engages the other with F and kills it.
const m7DuelHubPort = 8807;
// The M7 HUD spec (8808): a duel with the combat HUD, the telegraphs and the fight's cues.
const m7HudHubPort = 8808;
// The M7 kill spec (8809), with the M5 hooks: a mating, then a kill that eats the victim's egg.
const m7KillHubPort = 8809;
// The M7 carrion spec (8810): a kill seen by a spectator, who eats a piece.
const m7CarrionHubPort = 8810;
// The M7 melee spec (8811): a third player joins a running fight.
const m7MeleeHubPort = 8811;
// The M7 lifecycle spec (8812), with the M5 hooks: the whole encounter line in one scenario.
const m7LifecycleHubPort = 8812;
// The M8 resume spec (8813): B reloads mid-fight and goes back to it.
const m8ResumeHubPort = 8813;
// The M8 restart spec (8814): the authority restarts mid-fight, and both clients reconnect into it.
const m8RestartHubPort = 8814;
// The M8 away spec (8816): pages close mid-fight; `AWAY_GRACE_MS` shortens the wait to 500 ms.
const m8AwayHubPort = 8816;
// The M8 proxy spec (8815): B's page closes mid-fight; A and the spectator C still see it, away.
const m8ProxyHubPort = 8815;
// The M8 lifecycle spec (8817): one fight through a reload, a restart and a closed tab (no `AWAY_GRACE_MS`: a restart empties the hub, and a 500 ms wait would settle the fight first).
const m8LifecycleHubPort = 8817;
// The M9 card spec (8818): a creature's card opened after its owner's page closed.
const m9CardHubPort = 8818;
// The M9 share spec (8820): from the game's Lineage to a creature's card and its image.
const m9ShareHubPort = 8820;
// The M9 lineage spec (8819), with the M5 hooks: two players mate and promote, then a card shows both parents.
const m9LineageHubPort = 8819;
// The M9 lifecycle spec (8821), with the M5 hooks: genesis, a mating, a fight, a death and a return, then cards and the CLI.
const m9LifecycleHubPort = 8821;
// The M10 witness specs (8822, 8823): every play counts and the IP check is off (every context shares
// localhost), so the third page can referee. `m10-cross` holds two seats a pond, so it sits apart.
const m10WitnessHubPort = 8822;
const m10CrossHubPort = 8823;
/** No spec file is named on the command line, or this one is. */
const wantsSpec = (stem: string): boolean => {
  const named = process.argv.filter((a) => a.endsWith('.spec.ts'));
  return named.length === 0 || named.some((a) => a.includes(stem));
};
const WITNESS_VARS = '--var WITNESS_PLAY_MS:0 --var WITNESS_IP_CHECK:off';
// The M10 audit spec (8825), with the M5 hooks and the witness variables: every play counts and
// the IP check is off (every context shares localhost), so the third and fourth pages can audit.
const m10AuditHubPort = 8825;
// The M10 card spec (8826), with the witness variables: a fight two witnesses saw, then A's card.
const m10CardHubPort = 8826;
// The M10 lifecycle spec (8827): the mating scale and the witness variables, with lives of normal length (a slow runner's fights would outlast short ones): mating, two witnessed fights, cards and the CLI.
const m10LifecycleHubPort = 8827;
// The M11 link specs (M11 T13): leaves crossed with `LEAF_MAX=2` (8828), the cap (8829), a peer's relay (8830);
// the tiers (8831, M11 T17).
const m11HandoffHubPort = 8828;
const m11CapHubPort = 8829;
const m11RelayHubPort = 8830;
const m11TiersHubPort = 8831;
// The M11 lifecycle spec (M11 T19, 8832): four players in the one world.
const m11LifecycleHubPort = 8832;
// The M12 crowd spec (M12 T6, 8834): instances of 2 that merge after 3 s quiet, small leaves so a
// page that swims out reports at once.
const m12CrowdHubPort = 8834;
// The M12 spawning spec (M12 T4, 8833): four players placed by the authority.
const m12SpawnHubPort = 8833;
// The M12 ride spec (M12 T7, 8835): a lone player rides the current back, after 3 s alone.
const m12RideHubPort = 8835;
// The M12 lifecycle spec (M12 T11, 8836): four players through spawning, a crowd, a reload in a fight, a ride and a merge.
const m12LifecycleHubPort = 8836;
// `--grep-invert` does not reach a project's dependencies, which would run the slow scenarios in the
// PR gate; `test:e2e` sets this instead and every project skips them itself.
// The post chain (M6 T2) makes software rendering several times slower, which starves specs that
// do not look at the picture. Every context starts on the low preset; the look and preset specs
// clear this and choose their own (`?quality=`).
const lowQuality = {
  cookies: [],
  origins: [
    {
      origin: `http://localhost:${port}`,
      localStorage: [{ name: 'bs.settings', value: JSON.stringify({ quality: 'low' }) }],
    },
  ],
};
const skipSlow = process.env.E2E_SKIP_SLOW ? { grepInvert: /@slow/ } : {};
const SOCIAL = /m2-social\.spec\.ts/;
const POND = /m2-pond\.spec\.ts/;
const POST =
  /m6-(post|dof|gallery|creature-mesh|readable|budget)\.spec\.ts|m6b-(look|clip)\.spec\.ts|m6c-(glass|organs)\.spec\.ts/;
// Firefox (M6c T8): `m6c-firefox` (Firefox only; it skips itself elsewhere) and `m6c-flash` (both
// browsers). Only `E2E full`'s firefox part sets `E2E_FIREFOX`, after installing Firefox; PR CI and
// a plain `test:e2e:full` stay Chromium. Headless Firefox finds no GL driver on a runner (no EGL), so
// it runs headed under `xvfb-run`, where it draws WebGL2 through Mesa like Chromium.
const FIREFOX = /m6c-(firefox|flash)\.spec\.ts/;
const firefox = process.env.E2E_FIREFOX
  ? [
      {
        name: 'firefox',
        testMatch: FIREFOX,
        use: {
          browserName: 'firefox' as const,
          headless: false,
          launchOptions: { firefoxUserPrefs: { 'webgl.force-enabled': true } },
        },
        ...skipSlow,
      },
    ]
  : [];

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  ...(process.env.CI ? { workers: CI_WORKERS } : {}),
  forbidOnly: !!process.env.CI,
  retries: 0,
  // A test's ceiling, not a pace it asserts. Under software GL two workers on a CI runner take
  // 16-25 s for a hatch and a few frames, and a slower runner (E2E main after M11 T17: every test
  // 1.3-1.5x slower) pushed three such tests over the 30 s default that pass in 7 s locally.
  timeout: process.env.CI ? 60_000 : 30_000,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://localhost:${port}/`,
    storageState: lowQuality,
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
    {
      name: 'chromium',
      testIgnore: [SOCIAL, POND, POST],
      use: { browserName: 'chromium' },
      ...skipSlow,
    },
    // Three-browser scenarios are CPU-bound under software GL: running this one after the rest
    // keeps CI runners from starving the online spec into its timeout.
    {
      name: 'social',
      testMatch: SOCIAL,
      dependencies: ['chromium'],
      use: { browserName: 'chromium' },
      ...skipSlow,
    },
    // The same for the three-context pond check, after the social one.
    {
      name: 'pond',
      testMatch: POND,
      dependencies: ['social'],
      use: { browserName: 'chromium' },
      ...skipSlow,
    },
    // The post chain, DOF, gallery and budget checks render the high preset in software; beside the old-age spec
    // (which counts the ticks a loaded runner manages to play) they starve it.
    {
      name: 'post',
      testMatch: POST,
      dependencies: ['pond'],
      use: { browserName: 'chromium' },
      ...skipSlow,
    },
    ...firefox,
  ],
  webServer: [
    {
      command: `npm run preview -- --port ${port} --strictPort`,
      url: `http://localhost:${port}/`,
      reuseExistingServer: !process.env.CI,
    },
    {
      // The authority, locally: the same Worker and Durable Object, with fresh state per run.
      command: `node tools/worker.mjs dev --e2e --port ${hubPort} --persist-to .wrangler/e2e-state`,
      url: `http://localhost:${hubPort}/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `node tools/worker.mjs dev --e2e --port ${socialHubPort} --persist-to .wrangler/e2e-state-social`,
      url: `http://localhost:${socialHubPort}/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `node tools/worker.mjs dev --e2e --port ${pondHubPort} --persist-to .wrangler/e2e-state-pond`,
      url: `http://localhost:${pondHubPort}/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `node tools/worker.mjs dev --e2e --port ${m4HubPort} --persist-to .wrangler/e2e-state-m4`,
      url: `http://localhost:${m4HubPort}/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `node tools/worker.mjs dev --e2e --port ${oldAgeHubPort} --persist-to .wrangler/e2e-state-oldage --var LIFESPAN_SCALE:0.01`,
      url: `http://localhost:${oldAgeHubPort}/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `node tools/worker.mjs dev --e2e --port ${lifecycleHubPort} --persist-to .wrangler/e2e-state-lifecycle --var MAX_SESSIONS:2`,
      url: `http://localhost:${lifecycleHubPort}/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `node tools/worker.mjs dev --e2e --port ${m5HubPort} --persist-to .wrangler/e2e-state-m5 --var LIFESPAN_SCALE:0.05 --var MATING_SCALE:0.01`,
      url: `http://localhost:${m5HubPort}/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `node tools/worker.mjs dev --e2e --port ${m5PromoteHubPort} --persist-to .wrangler/e2e-state-m5-promote --var LIFESPAN_SCALE:0.05 --var MATING_SCALE:0.01`,
      url: `http://localhost:${m5PromoteHubPort}/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `node tools/worker.mjs dev --e2e --port ${m5InspectHubPort} --persist-to .wrangler/e2e-state-m5-inspect --var LIFESPAN_SCALE:0.05 --var MATING_SCALE:0.01`,
      url: `http://localhost:${m5InspectHubPort}/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `node tools/worker.mjs dev --e2e --port ${m5LifecycleHubPort} --persist-to .wrangler/e2e-state-m5-lifecycle --var LIFESPAN_SCALE:0.02 --var MATING_SCALE:0.01`,
      url: `http://localhost:${m5LifecycleHubPort}/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `node tools/worker.mjs dev --e2e --port ${m6FindHubPort} --persist-to .wrangler/e2e-state-m6-find`,
      url: `http://localhost:${m6FindHubPort}/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `node tools/worker.mjs dev --e2e --port ${m6EggHubPort} --persist-to .wrangler/e2e-state-m6-egg --var LIFESPAN_SCALE:0.05 --var MATING_SCALE:0.01`,
      url: `http://localhost:${m6EggHubPort}/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `node tools/worker.mjs dev --e2e --port ${m6WheelHubPort} --persist-to .wrangler/e2e-state-m6-wheel`,
      url: `http://localhost:${m6WheelHubPort}/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `node tools/worker.mjs dev --e2e --port ${m6bEggHubPort} --persist-to .wrangler/e2e-state-m6b-egg --var LIFESPAN_SCALE:0.05 --var MATING_SCALE:0.01`,
      url: `http://localhost:${m6bEggHubPort}/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `node tools/worker.mjs dev --e2e --port ${m6bMinimapHubPort} --persist-to .wrangler/e2e-state-m6b-minimap`,
      url: `http://localhost:${m6bMinimapHubPort}/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `node tools/worker.mjs dev --e2e --port ${m6LifecycleHubPort} --persist-to .wrangler/e2e-state-m6-lifecycle --var LIFESPAN_SCALE:0.05 --var MATING_SCALE:0.01`,
      url: `http://localhost:${m6LifecycleHubPort}/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `node tools/worker.mjs dev --e2e --port ${m6bLifecycleHubPort} --persist-to .wrangler/e2e-state-m6b-lifecycle --var LIFESPAN_SCALE:0.05 --var MATING_SCALE:0.01`,
      url: `http://localhost:${m6bLifecycleHubPort}/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `node tools/worker.mjs dev --e2e --port ${m6cResetHubPort} --persist-to .wrangler/e2e-state-m6c-reset`,
      url: `http://localhost:${m6cResetHubPort}/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `node tools/worker.mjs dev --e2e --port ${m6cEggHubPort} --persist-to .wrangler/e2e-state-m6c-egg --var LIFESPAN_SCALE:0.05 --var MATING_SCALE:0.01`,
      url: `http://localhost:${m6cEggHubPort}/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `node tools/worker.mjs dev --e2e --port ${m6cLifecycleHubPort} --persist-to .wrangler/e2e-state-m6c-lifecycle --var LIFESPAN_SCALE:0.05 --var MATING_SCALE:0.01`,
      url: `http://localhost:${m6cLifecycleHubPort}/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `node tools/worker.mjs dev --e2e --port ${m7DuelHubPort} --persist-to .wrangler/e2e-state-m7-duel`,
      url: `http://localhost:${m7DuelHubPort}/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `node tools/worker.mjs dev --e2e --port ${m7HudHubPort} --persist-to .wrangler/e2e-state-m7-hud`,
      url: `http://localhost:${m7HudHubPort}/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `node tools/worker.mjs dev --e2e --port ${m7KillHubPort} --persist-to .wrangler/e2e-state-m7-kill --var LIFESPAN_SCALE:0.05 --var MATING_SCALE:0.01`,
      url: `http://localhost:${m7KillHubPort}/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `node tools/worker.mjs dev --e2e --port ${m7CarrionHubPort} --persist-to .wrangler/e2e-state-m7-carrion`,
      url: `http://localhost:${m7CarrionHubPort}/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `node tools/worker.mjs dev --e2e --port ${m7MeleeHubPort} --persist-to .wrangler/e2e-state-m7-melee`,
      url: `http://localhost:${m7MeleeHubPort}/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `node tools/worker.mjs dev --e2e --port ${m7LifecycleHubPort} --persist-to .wrangler/e2e-state-m7-lifecycle --var MATING_SCALE:0.01`,
      url: `http://localhost:${m7LifecycleHubPort}/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `node tools/worker.mjs dev --e2e --port ${m8ResumeHubPort} --persist-to .wrangler/e2e-state-m8-resume`,
      url: `http://localhost:${m8ResumeHubPort}/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `node tools/worker.mjs dev --e2e --port ${m8RestartHubPort} --persist-to .wrangler/e2e-state-m8-restart`,
      url: `http://localhost:${m8RestartHubPort}/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `node tools/worker.mjs dev --e2e --port ${m8AwayHubPort} --persist-to .wrangler/e2e-state-m8-away --var AWAY_GRACE_MS:500`,
      url: `http://localhost:${m8AwayHubPort}/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `node tools/worker.mjs dev --e2e --port ${m8ProxyHubPort} --persist-to .wrangler/e2e-state-m8-proxy`,
      url: `http://localhost:${m8ProxyHubPort}/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `node tools/worker.mjs dev --e2e --port ${m8LifecycleHubPort} --persist-to .wrangler/e2e-state-m8-lifecycle`,
      url: `http://localhost:${m8LifecycleHubPort}/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `node tools/worker.mjs dev --e2e --port ${m9CardHubPort} --persist-to .wrangler/e2e-state-m9-card`,
      url: `http://localhost:${m9CardHubPort}/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `node tools/worker.mjs dev --e2e --port ${m9ShareHubPort} --persist-to .wrangler/e2e-state-m9-share`,
      url: `http://localhost:${m9ShareHubPort}/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `node tools/worker.mjs dev --e2e --port ${m9LineageHubPort} --persist-to .wrangler/e2e-state-m9-lineage --var LIFESPAN_SCALE:0.05 --var MATING_SCALE:0.01`,
      url: `http://localhost:${m9LineageHubPort}/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `node tools/worker.mjs dev --e2e --port ${m9LifecycleHubPort} --persist-to .wrangler/e2e-state-m9-lifecycle --var LIFESPAN_SCALE:0.05 --var MATING_SCALE:0.01`,
      url: `http://localhost:${m9LifecycleHubPort}/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    // The M10, M11 and M12 specs are all `@slow`, so the PR parts start none of their hubs, and a run that names
    // spec files (CI's repeat of the changed ones) starts only the hubs of the M10 specs it names:
    // 39 idle `wrangler dev` processes beside a browser took the runners down.
    ...[
      ['m10-witness', m10WitnessHubPort, WITNESS_VARS],
      ['m10-cross', m10CrossHubPort, WITNESS_VARS],
      [
        'm10-audit',
        m10AuditHubPort,
        '--var LIFESPAN_SCALE:0.05 --var MATING_SCALE:0.01 --var WITNESS_PLAY_MS:0 --var WITNESS_IP_CHECK:off',
      ],
      ['m10-card', m10CardHubPort, WITNESS_VARS],
      ['m11-handoff', m11HandoffHubPort, '--var LEAF_MAX:2'],
      ['m11-cap', m11CapHubPort, ''],
      ['m11-relay', m11RelayHubPort, ''],
      ['m11-tiers', m11TiersHubPort, ''],
      ['m12-crowd', m12CrowdHubPort, '--var INSTANCE_MAX:2 --var QUIET_MS:3000 --var LEAF_MAX:2'],
      ['m12-spawn', m12SpawnHubPort, ''],
      ['m12-ride', m12RideHubPort, '--var RIDE_ALONE_MS:3000'],
      [
        'm12-lifecycle',
        m12LifecycleHubPort,
        '--var INSTANCE_MAX:2 --var QUIET_MS:3000 --var RIDE_ALONE_MS:3000 --var MATING_SCALE:0.01',
      ],
      [
        'm11-lifecycle',
        m11LifecycleHubPort,
        '--var LEAF_MAX:2 --var MATING_SCALE:0.01 --var WITNESS_PLAY_MS:0 --var WITNESS_IP_CHECK:off',
      ],
      [
        'm10-lifecycle',
        m10LifecycleHubPort,
        '--var MATING_SCALE:0.01 --var WITNESS_PLAY_MS:0 --var WITNESS_IP_CHECK:off',
      ],
    ]
      .filter(([spec]) => !process.env.E2E_SKIP_SLOW && wantsSpec(String(spec)))
      .map(([spec, port, vars]) => ({
        command: `node tools/worker.mjs dev --e2e --port ${port} --persist-to .wrangler/e2e-state-${spec} ${vars}`,
        url: `http://localhost:${port}/v1/health`,
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
      })),
  ],
});
