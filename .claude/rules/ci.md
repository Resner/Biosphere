---
paths:
  - ".github/**"
---

# CI and release workflows

- CI stays one job, `verify`: GitHub rounds every job up to a whole minute, and Actions minutes are budgeted. Add steps, not jobs.
- PR CI never touches live services or secrets. Deploys (Pages, and the Worker from M2) happen only in the release workflow, triggered by a `VERSION` change on `main`.
- Secrets are read only in the release workflow's deploy steps (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CF_TURN_KEY_ID`, `CF_TURN_KEY_API_TOKEN`). The client build reads the repository variable `AUTHORITY_URL`.
- Keep slow E2E out of the PR gate (`test:e2e` versus `test:e2e:full`). Browser installs run through `npm run e2e:setup`.
- Pin actions to major versions from `actions/*` only, matching the repository's Actions policy (`docs/SETUP.md` step 4).
