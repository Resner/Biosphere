# 0017: Worker tests use `@cloudflare/vitest-plugin`

- Status: accepted (Vitest 5 is out and the plugin supports it, so Dependabot no longer ignores Vitest majors since 2026-11-01)
- Date: 2026-10-25

## Context

ADR 0003 names `@cloudflare/vitest-pool-workers` for the workerd tests. Its maintainers renamed it to `@cloudflare/vitest-plugin` and print a deprecation banner on every `npm run check`; the old name gets no further updates. The new package keeps the same `cloudflareTest` plugin API and supports Vitest 4 and 5.

## Decision

- Use `@cloudflare/vitest-plugin` (pinned) wherever ADR 0003 and the specs say `@cloudflare/vitest-pool-workers`. Nothing else in ADR 0003 changes.
- One root `vitest.config.ts` defines two projects: `node` (`src/**/*.test.ts`) and `worker` (`worker/**/*.test.ts`, run in workerd through the plugin, with `__VERSION__` defined). `npm run check` runs both.
- The Worker's build version is injected as `__VERSION__` from the `VERSION` file (`tools/version.mjs`, plain JavaScript so Node 22 versions without type stripping can run it): through `define` in Vitest, and through `tools/worker.mjs` (`npm run worker:dev`, `worker:deploy`) for wrangler.

## Consequences

- No deprecation banner, and the plugin follows Vitest releases.
- The Dependabot ignore on Vitest majors (ADR 0003) is about the old pool and can be revisited when Vitest 5 arrives.
