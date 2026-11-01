---
paths:
  - "tests/**"
  - "**/*.test.ts"
  - "playwright.config.ts"
---

# Tests

- Offline and deterministic:
  - Relays, STUN, TURN, drand and the Cloudflare API are faked or replayed from recorded fixtures (`tests/fixtures/`).
  - The authority runs locally (workerd, `wrangler dev`), and E2E sets the authority URL at runtime (localhost only), never the production one.
  - Every random input is seeded.
- Unit tests sit next to the code (`src/**/*.test.ts`). E2E runs against `dist/` (`tests/e2e/*.spec.ts`).
- Tag scenarios longer than about 20 s with `@slow`, at the end of the title. They run only in `test:e2e:full`: `E2E main` and the release. The PR suite runs in five parallel parts of about 3.5 minutes each; keep each part under about 5.
- A unit test that takes more than about 2 s is a `heavyTest` (`tests/heavy.ts`, ADR 0045). `npm run check` skips it, and `check:full` and CI run it, so it still gates every merge. It gets the `heavy` tag's 120 s timeout, so it passes none of its own.
- Deterministic scenarios (ADR 0042). Every release failure so far came from a scenario that assumed a fast runner. A scenario:
  - waits on `state()` conditions, never on wall time or a fixed number of frames;
  - drives game time through the sim (ticks, `debug.timeScale`, the hub's scale hooks) rather than real seconds, and allows for a runner that plays far fewer ticks per second than a laptop;
  - never asserts a pace, speed or count measured in wall time, only in sim ticks;
  - re-reads values from the frame that shows them, not from an earlier read;
  - keeps every wait bounded with a message that names what it waited for.
- Where scenarios run: CI repeats every new or changed spec 3 times on one worker before it can merge (ADR 0044). `E2E main` runs the whole suite on main after merges and every 6 hours, on parallel runners (`e2e-full.yml`: fast in 3 shards, `@slow` in 3 shards at one worker each, and social, pond and post each on its own runner); Release calls the same workflow. Reproduce one part locally with the same arguments, for example `npx playwright test --project=chromium --grep=@slow --shard=1/3 --workers=1`.
- Visual checks assert properties of decoded screenshots (non-blank, contrast, an element present, budgets from `renderer.info`), never pixel-exact baselines: software rendering changes between browser versions.
- Every E2E context starts on the low preset (`storageState` in `playwright.config.ts`): the post chain makes software rendering several times slower. Specs that judge the picture or the presets clear it with `test.use({ storageState: { cookies: [], origins: [] } })` and pass `?quality=`.
- Use the `window.__bs` hook (`?debug=1` for mutations) instead of sleeping or scraping the DOM for game state. The hooks' API (`window.__bs`, `__lab`, `__gallery`), the budget scenes and the hub ports are in `docs/TESTING.md`: read the parts your test uses, and update it in the same PR when you change a hook or add a hub.
- A spec file that uses a hub runs serially (`test.describe.configure({ mode: 'serial' })`) and gets its own `wrangler dev` port in `playwright.config.ts`, because files run in parallel and would share a pond. `docs/TESTING.md` names the next free port.
- Golden files (replays, math, genome vectors) change only with a change to the rules they pin, never just to get green. The first such change after a release bumps `RULES_VERSION` (ADR 0018).
- Never skip, loosen or delete a test to get green; fix the cause.
