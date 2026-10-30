# 0024: Look passes are judged on a committed gallery

- Status: accepted, amended by 0032 and 0034
- Date: 2026-10-27

## Context

M6's centrepiece is the creature look overhaul the owner asked for in #90, judged against `docs/art/reference-02.jpg` to `reference-05.jpg`. The factory has no GPU, nobody reviews PRs, and the Playwright suite uses no pixel baselines (ADR 0004), so "the look is good" cannot be a green test. Without a fixed yardstick each pass would be judged on whatever creatures it happened to render, and a pass could be called done because the tests passed. The GitHub tool cannot attach images to a PR, so the evidence has to live in the repository.

## Decision

- **A fixed gallery.** `lab.html?gallery=1` shows a fixed set of specimens: genomes stored as hex under `tests/fixtures/gallery/`, never re-drawn from seeds, so later rule changes cannot alter them. The camera, viewport (1600×1000), pixel ratio (1), preset (high), animation time and backdrop are fixed. `npm run gallery -- --pass <n>` renders it with the shared Chromium (software GL) to a contact sheet. Two captures from one build are byte-identical.
- **Committed evidence.** Every look pass commits `docs/art/gallery/pass-<n>.png` (one sheet, at most about 1.5 MB, never shipped in `dist/`) and `docs/art/gallery/pass-<n>.md`. The note holds a gap table with one row per aspect (silhouette variety, translucency, inner detail, fine appendages, palette, rare glints, lighting) and one column per reference (02 to 05), each cell an integer 0 (holds up next to the reference) to 3 (far off), a short honest sentence, and a "Largest gaps" list that the pass then fixes. A unit test checks the table's shape, so a pass cannot skip a cell.
- **A pass is done when its gaps are fixed**, not when tests are green. The final pass has no cell above 1. The milestone step keeps only the first and the last two sheets.
- **New body classes extend the gallery**; they never replace specimens. A new specimen file is added for each class that body-plan work introduces.
- The owner has the last word: M6 is a `gate`, and the `Playtest:` issue carries an `(owner)` check on the look. #90 closes when the owner accepts it.

## Consequences

- Look work is judged by an honest, repeatable comparison that a later session can read and challenge.
- Binary files enter git (one sheet per pass); pruning at the milestone keeps the repository small.
- Rejected:
  - pixel-exact baselines (software rendering changes between browser versions; ADR 0004);
  - screenshots only in PR text (the tool cannot attach them and they are lost when the branch is deleted);
  - judging from the Lab grid alone (it has no fixed camera, so successive passes are not comparable).
