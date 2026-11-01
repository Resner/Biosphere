---
paths:
  - ".github/**"
---

# CI and release workflows

- `verify` stays the single required check (ADR 0042). Since the repository went public, Actions minutes are free (ADR 0015), so PR CI runs its parts in parallel: `scope` (the one-PR-per-lane guard, ADR 0044, and the docs-only skip), `unit` (`npm run check`), `e2e` (`test:e2e` in five parts), and `slow` (every new or changed E2E spec, repeated three times). `verify` always runs and passes only when every part it needed passed: a skipped required job would count as passing (#40). A new part joins `verify`'s `needs` and its result check.
- PR CI never touches live services or secrets. Deploys (Pages, and the Worker from M2) happen only in the release workflow, triggered by a `VERSION` change on `main`.
- Secrets are read only in the release workflow's deploy steps (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CF_TURN_KEY_ID`, `CF_TURN_KEY_API_TOKEN`). The client build reads the repository variable `AUTHORITY_URL`.
- Keep slow E2E out of the PR gate (`test:e2e` versus `test:e2e:full`); the full suite runs in `e2e-full.yml`, which Release and `E2E main` call. Browser installs run through `npm run e2e:setup`.
- Pin actions to major versions from `actions/*` only, matching the repository's Actions policy (`docs/SETUP.md` step 4).
- Playwright runs with 2 workers in CI (`playwright.config.ts`, ADR 0044); the main process logs the CPU count Node reports.
