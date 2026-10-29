# 0032: The gallery shows rules 6 bodies, and look features get specimens

- Status: accepted (amends 0024)
- Date: 2026-10-29

## Context

ADR 0024 fixes the look-pass gallery: genomes stored as hex, never re-drawn, and new body classes added as new specimens. Its first 20 specimens (the pass 0 baseline) are karyotype v1 genomes, and a v1 genome keeps the v1 body (ADR 0028), so after pass 4 more than half the sheet was still round cells and stubby chains, however the v2 bodies changed (`docs/art/gallery/pass-4.md`, gap 1). Rules 6 never develops a new v1 body: every genesis and birth writes karyotype v2, and a v1 parent's child is padded to v2 before meiosis. The v1 bodies on the sheet show a look no new creature will have. Pass 4 also found looks that references 02 to 05 show and the gallery has no specimen for, though development can make them: long sweeping antennae, big eyes set into the head, and a coiled body with short parts.

## Decision

- The gallery draws every specimen as rules 6 develops it: a karyotype v1 file is shown as its v2 upgrade (`upgrade`, ADR 0028), the body its children start from (`shownGenome` in `src/lab/gallery.ts`). The files, their genomes and their pinned hashes are unchanged, so the baseline is still the same set of genomes, and a v1 genome still develops the v1 body everywhere else (living creatures, the frozen v5 code, the budget scenes).
- Besides new body classes, a look pass may add a specimen for a look feature of the references that no specimen shows (`FEATURES` in `tools/specimen.ts`, `npm run specimens -- --features`), found by the same deterministic search and skipping every genome already in the gallery. Pass 5 adds three: 37 long antennae, 38 big eyes, 39 a spiral. Specimens are still never replaced or removed.

## Consequences

- From pass 5 the baseline's chains (07, 09 to 12, 18 and 19 are long ones) read with the v2 proportions, and the sheet judges the bodies players will see. Sheets before pass 5 drew those specimens as v1 bodies, so their cells compare across that line only with that in mind.
- The sheet grows to 39 cells, laid out 8 by 5; each body is drawn about 3% smaller than on the 36-cell sheet.
- A feature specimen keeps a gap visible: 39 was found by the search but does not read as a spiral, which tells the next pass what development cannot yet make.
- Rejected:
  - adding 20 upgraded copies of the baseline as new specimens (a 56-cell sheet draws every body about a fifth smaller, and the round v1 copies stay on it);
  - judging only the v2 specimens and ignoring cells 01 to 20 (the table would no longer describe the whole sheet).
