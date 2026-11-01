# Care backlog

Maintenance that keeps the project workable as it grows (ADR 0045). The care lane works it when `main` is healthy (`next` skill, care lane), one task per run, in order. A task here changes no behaviour and no outcome: tests, goldens and E2E stay as they are. A task that would change behaviour belongs in a milestone spec instead.

Before starting a task, check the open build-lane PR (`gh api --paginate repos/Resner/Biosphere/pulls/<n>/files --jq '.[].filename'`). If it changes a file the task names under Touches, skip to the next task: a split under an open feature PR makes both lanes conflict. Check again before your last push; if a build PR has since started on those files, merge `origin/main` once it lands, or leave your PR as `WAITING` for the next care run rather than racing it. Tasks are ticked like spec tasks, with a note of two lines at most. New maintenance that a run finds outside its own step (a file that grew past 1,000 lines, a stale rule, a reference that outgrew its rule file) is added here instead of widening that run's PR.

## Tasks

- [x] C0 Pin the scene of `m6-dof`'s medium scenario
  - Why: it failed on #222's CI ("a far-layer disc on plain water, clear of the others"; run 41338189016) while `main` and its `E2E main` were green. `play()` hatches, then freezes the world, so the tick it freezes at, and with it the food on screen and the creature's drift, depends on how fast the runner is (`.claude/rules/tests.md`: drive time through the sim). Some ticks leave no far disc on plain water.
  - Touches: `tests/e2e/m6-dof.spec.ts`, `src/game/debug.ts`, `docs/TESTING.md`.
  - Steps:
    1. Add a `debug.setTick(n)` (or an equivalent that freezes the world at a fixed tick and place, for example with `teleport`) so both pages of a pair, and every run, draw the same specks and food.
    2. Use it in `play()`, and check the other `m6-dof` scenarios for the same wait.
  - Acceptance: `npx playwright test tests/e2e/m6-dof.spec.ts --project post --no-deps --repeat-each=5 --workers=1` passes, with no assertion loosened.
  - Done: `debug.freezeAt(tick, x, y)` freezes the world at tick 0 at the pond's centre; `play()` uses it (the only wait in `m6-dof`), and 5 repeats pass (15 of 15).

- [ ] C1 Split `src/genome/develop.ts` (2,218 lines) into modules under 1,000 lines
  - Why: agents read a file 2,000 lines at a time, so its end is easy to miss. Every body task edits it, so the build lane conflicts with itself and with this lane.
  - Touches: `src/genome/develop.ts`, the modules it becomes, and their importers.
  - Steps:
    1. Split along the stages that already exist: the chain (shape, profile, fusion, lengths, curl and coil); the parts (lengths, curves, the bounds fit, `keepOff`, `uncover`, rings); fine detail (webbing, setae, bulbs, eyes); the outline, bounds and `bodyViolations`. `develop.ts` keeps `develop`, the types and the caps, and re-exports what its importers use today, so no importer has to change.
    2. Move code verbatim. No renames, no reordering of arithmetic, no new helpers: the goldens prove that nothing changed.
  - Acceptance:
    - `npm run check:full` is green with no golden file changed (`git diff --stat -- src/genome/__golden__` is empty).
    - Every file in `src/genome/` is under 1,000 lines.
    - `git diff -M --stat` shows moves, not rewrites.

- [x] C2 Split `src/game/app.ts` (2,217 lines; `startApp` alone is about 1,940) into modules under 1,000 lines [opus]
  - Why: as C1. Every HUD, screen and online task edits this one closure.
  - Touches: `src/game/app.ts`, the modules it becomes.
  - Steps:
    1. Find the parts of `startApp` that share little state: the debug hook (`window.__bs`), the online session and its message handlers, the screens (title, death, offspring), the HUD and menu wiring, and the per-frame update. Move each into its own module, taking an explicit context object instead of closure variables.
    2. Keep behaviour exact: same event order, same frame order, same `window.__bs` shape.
  - Acceptance:
    - `npm run check:full` and PR CI's E2E are green with no test changed; `E2E main` confirms the slow scenarios after the merge.
    - `src/game/app.ts` and each new module are under 1,000 lines.
  - Done: `app.ts` (621 lines) is the `App` class, the shared state and its wiring in the old order; `app-online`, `app-life`, `app-ui`, `app-tick`, `app-render`, `app-keys`, `app-hook` and `app-session` take it as context (each under 410 lines).
  - Gotcha: the hub's handlers are method shorthand, so `this` there is the handler object: reach the app through the `app` const, never `this`.

- [ ] C3 Condense `docs/DESIGN.md` (93 KB) to the current game
  - Why: the spec writer reads all of it for every milestone, and much of it is history ("M6 had a depth gauge…", "1.2 before M6 T14b", "34% under rules 6"). CLAUDE.md now says DESIGN describes the current game only.
  - Touches: `docs/DESIGN.md`.
  - Steps:
    1. Section by section, remove task ids, former values and "before"/"since" history. Keep every current mechanic and every current value: a value that is still in the code stays in DESIGN.
    2. Check each number left against its code table (`src/sim/rules.ts`, `RULES` in `src/genome/`, `PRESETS`). Where they differ, the code wins: fix DESIGN and note it in the PR.
  - Acceptance:
    - Every value in the new DESIGN.md is in the old one or in the code tables. List the differences found in the PR body.
    - No task id (`M<n> T<n>`) is left, apart from links to the specs.
    - The file is at most two thirds of its size before.

- [ ] C4 Split `src/render/creature-mesh.ts` (1,477 lines) into modules under 1,000 lines [opus] (in progress)
  - Touches: `src/render/creature-mesh.ts`, the modules it becomes.
  - Steps: split the loft (the body shell), the parts and their detail, and the level-of-detail fit (`fit`, `meshDetail`, `estimateVertices`). Move code verbatim; `creature-mesh.ts` re-exports what its importers use.
  - Acceptance: `npm run check:full` and the `post` project's look specs (`npx playwright test --project post --no-deps`) are green with no test changed; each file is under 1,000 lines.

- [ ] C5 Split `worker/authority.ts` (1,447 lines) into modules under 1,000 lines [opus]
  - Touches: `worker/authority.ts`, the modules it becomes.
  - Steps: move the message handlers into modules by area (sessions and signaling, genesis and life, mating and offspring), with `Authority` keeping the Durable Object's state, `rearm` and the dispatch. Move code verbatim; the alarm rule in `.claude/rules/worker.md` still holds.
  - Acceptance: `npm run check:full` and the hub E2E specs are green with no test changed; each file is under 1,000 lines.
