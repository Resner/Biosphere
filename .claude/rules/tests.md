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
- `window.__bs` (`src/game/debug.ts`): `ready`, `state()` (screen, tick, player, death, remotes (each with `radius`, `genomeHash` and `species`, null while the tinted cell stands in), pond, social, net (`dropped` counts genome events ignored); `player` includes `genomeHash`, `species`, `rarity`, `tier` and the sim's `stats`), `events()` (counts since hatching), `replay(log)` (hash of an input log), `render.info()` (`remoteCells` fallback cells, `remoteBodies` genome bodies). With `?debug=1` also `debug.{setEnergy, setBiomass, teleport, nearestFood(kind?), steerTo, spawnPlume, setRemotes, joinPond, deliver, hasFood, timeScale}`; `steerTo` returns a promise. A scripted remote (`setRemotes`) may carry a `genome` (any text, delivered through the real parser and builder; `withholdGenome` sends only the ref). The game hatches a random genesis body unless `?genome=<base64url>` or `?genome=starter` pins it; `openGame` in `tests/e2e/helpers.ts` adds `genome=starter` unless the query pins one. Tests click Hatch first: the page opens on the title screen, and `state().player` is `null` there.
- `window.__lab` (`src/lab/hook.ts`, always present on `lab.html`): `ready`, `state()` (seed, mode, creatures, hovered, selected, parents, offspring), `select(i, { second })` (0-23 the grid, 24-31 the offspring strip), `setMode(mode)`, `renderInfo()`; with `?debug=1` also `debug.{showGenomes(base64url[]), pause(), advance(seconds)}` (replace the grid with those genomes, freeze and step the gait clock for screenshots). Lab specs measure decoded screenshots of `[data-testid="lab-canvas"]` cell by cell (`cellRect` and `stageCoreRadius` from `src/lab/grid.ts`; helpers in `tests/e2e/lab-helpers.ts`); the page must make no request outside its own origin.
- `state().social` holds `chat` (the last 50 lines), `muted` (player ids), `emotes`, `pings` and `dropped`; E2E chats through the real UI (Enter, type, Enter; click a roster name to mute), so there are no chat helpers under `?debug=1`.
- Hub E2E: Playwright starts `wrangler dev` on port 8787; open the game with `?hub=http://localhost:8787`. Tests in a file that uses the hub run serially (`test.describe.configure({ mode: 'serial' })`), because the hub fills the fullest pond first. Files run in parallel, so each hub file has its own `wrangler dev` (`playwright.config.ts`: `m2-online` 8787, `m2-social` 8788, `m2-pond` 8789); a new hub file adds a port.
- Golden files (replays, math, genome vectors) change only together with a `RULES_VERSION` bump.
- Never skip, loosen or delete a test to get green; fix the cause.
