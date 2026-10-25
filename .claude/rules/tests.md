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
- Tag scenarios longer than about 20 s with `@slow`. They run only in `test:e2e:full` (the release gate). The PR E2E suite should stay under about 3 minutes in CI.
- Visual checks assert properties of decoded screenshots (non-blank, contrast, an element present, budgets from `renderer.info`), never pixel-exact baselines: software rendering changes between browser versions.
- Use the `window.__bs` hook (`?debug=1` for mutations) instead of sleeping or scraping the DOM for game state.
- Golden files (replays, math, genome vectors) change only together with a `RULES_VERSION` bump.
- Never skip, loosen or delete a test to get green; fix the cause.
