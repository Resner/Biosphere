# 0003: Toolchain and repository layout

- Status: accepted (the workerd test package is `@cloudflare/vitest-plugin`, which supports Vitest 5: 0017; `check` takes about 90 s and skips the heavy unit tests, which `check:full` and CI run: 0045; the versions named here date from 2026-10-25, and `package.json` has the current ones)
- Date: 2026-10-25

## Context

Unattended agents build a browser game, a Cloudflare Worker and the code the two share. `npm run check` runs on every stop and must stay under about 30 s as the code grows. Tests run in Node, in Chromium (E2E against `dist/`) and, from M2, in workerd. Cloud sessions have Node 22 and one pre-installed Chromium. CI resolves Node from `engines`.

## Decision

- **One npm package**, no workspaces. Code lives in `src/` (client and shared modules), `worker/` (from M2), `tests/e2e/` and `tools/` (Node scripts: load simulation, reports, fixture recorders).
- **TypeScript 7** (`tsc --noEmit`, native and fast), strict, with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. If a type package ever breaks on 7, fall back to TypeScript 6.0 and note it here.
- **Vite 8** builds and serves the site with `base: './'`, so it works under `/Biosphere/` on Pages. `__BUILD_LABEL__` comes from `BUILD_LABEL`. Extra pages (the Creature Lab in M3) become extra Vite inputs.
- **Vitest 4.1** runs unit tests: Node for `src/**/*.test.ts`, and workerd via `@cloudflare/vitest-pool-workers` for `worker/` from M2. That pool supports Vitest 4 only, so Dependabot ignores Vitest majors until it supports 5.
- **Biome 2** lints, formats and orders imports in code files only (`*.ts`, `*.js`, `*.json`, `*.css`, `*.html`). Markdown isn't formatted, so `docs/BRIEF.md` stays verbatim. `npm run format` applies fixes.
- **Playwright** runs E2E against `vite preview` of `dist/`, Chromium only in PR CI. `@playwright/test` is pinned to 1.63.0, the build pre-installed in cloud sessions. When the pinned build is missing, the config launches `/opt/pw-browsers/chromium`. Firefox and WebKit join the release gate in M14.
- **Node** `^22.12.0 || ^24.0.0`: cloud sessions run 22, CI resolves to 24.
- **npm 11 for dependency changes.** npm 10 (shipped with Node 22) crashes in `npm install` on Vite 8's optional peer graph (`Cannot read properties of null (reading 'edgesOut')`). `npm ci` works on both, so add or upgrade packages with `npx -y npm@11 install …`.
- **Shared modules** (`src/sim`, `src/genome`, `src/ledger`, `src/net/protocol.ts`) must run unchanged in browsers, Node and workerd: no DOM, no Node-only APIs, no three.js.

## Consequences

- `check` takes about 1 s today. Typechecking stays fast as the code grows, so the budget goes to tests.
- TypeScript 7 has no compiler API yet, so typescript-eslint, ts-morph and similar tools can't run. Biome's rules (including its own type inference) cover linting. The sim determinism guard is a unit test that scans sources (M1).
- Rejected:
  - ESLint with typescript-eslint (no TypeScript 7 support, slower);
  - Vitest 5 (no Workers pool);
  - Jest;
  - Webpack;
  - npm workspaces or a monorepo (overhead for one app and one Worker);
  - pnpm or Bun (the hooks and CI use npm).
