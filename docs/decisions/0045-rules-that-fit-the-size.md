# 0045: Rules that fit the project's size: a quick check, lean rule files, a care backlog

- Status: accepted (refines 0044: the care lane also works a maintenance backlog; replaces CLAUDE.md's 30-second budget for `npm run check`)
- Date: 2026-11-01

## Context

The early rules were written for an empty repository. On 2026-11-01, measured:

- **`npm run check` took 3 minutes** (1,932 unit tests in 146 files), against a budget of about 30 s. The Stop hook runs it after every change and gives up after 180 s, and a hook that times out does not block. So on a slow container the stop gate quietly did nothing, and on a normal one every stop waited 3 minutes. 51 tests over 2 s took 309 of the 419 test-seconds. The 10,000-genome sweeps and the mesh budgets over every archetype were the largest; two of them took 43 s each.
- **Rule files had become manuals.** `.claude/rules/tests.md` was 18.8 KB, 16 KB of it a reference for the test hooks with one line of almost 4,000 characters. It loads into nearly every task. `.claude/rules/genome.md` retold ADRs 0028 to 0039 in one bullet.
- **`docs/DESIGN.md` was 93 KB**, much of it history ("before M6 T14b", "under rules 6"), and the spec writer reads all of it for every milestone.
- **Two source files passed 2,000 lines** (`src/genome/develop.ts`, `src/game/app.ts`). Agents read a file 2,000 lines at a time, so the end of each is easy to miss, and most build tasks edit them.
- **The care lane is idle most hours** (ADR 0044), while maintenance like this has no lane: the build lane follows the roadmap, and widening a feature PR with refactors makes the lanes conflict.

## Decision

- **Heavy unit tests.** A unit test that takes more than about 2 s is a `heavyTest` (`tests/heavy.ts`), tagged `heavy` (a Vitest test tag, with a 120 s timeout). `npm run check` skips them and takes about 90 s. `npm run check:full` runs everything, about 3 minutes. CI's `unit` job, the release and the milestone close run `check:full`, and runs run it before their last push. Every heavy test still gates every merge.
- **Rule files hold rules.** The test hooks' API, the budget scenes and the hub ports move to `docs/TESTING.md`. `tests.md` keeps the rules and points there. Rule files state what must hold; ADRs keep why.
- **DESIGN.md describes the current game.** A change replaces the old text instead of adding to it: no task ids, no former values. History lives in specs, ADRs and git.
- **Source files stay under about 1,000 lines.** A larger file is split as a care-backlog task, never inside a feature task.
- **A care backlog.** `docs/specs/care.md` lists maintenance tasks in the spec format. They change no behaviour and no outcome. When `main` is healthy, the care lane takes the first one before going idle. It skips a task while the open build-lane PR changes a file the task touches. Runs that find maintenance outside their own step add it there instead of widening their PR. The owner can add tasks too.

## Consequences

- Stops are quick again, and the stop gate runs on every container. A heavy test that breaks shows up in CI's `unit` job rather than at the stop, so runs run `check:full` before they push.
- The care lane spends spare hours on the backlog, which costs Claude usage only while there is a task.
- A task splitting a big file waits until the build lane isn't editing that file, so a backlog task can wait for some time.
- Rejected:
  - weakening the heavy tests (fewer genomes) to fit 30 s (the rules forbid loosening tests);
  - keeping 30 s as the budget (unit work grows with every milestone; 90 s on four cores is what the suite needs without its heavy tests);
  - backlog tasks as GitHub issues (the factory posts with its footer, and footered issues don't count as owner input);
  - backlog tasks in the milestone specs (the build lane would spend roadmap time on maintenance);
  - splitting big files inside feature tasks (larger diffs, and conflicts between the lanes).
