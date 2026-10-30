# 0033: M6 ships with the remaining look gaps, and the owner's gate judges them

- Status: accepted (amends 0024); its plan for the remaining gaps is superseded by 0034
- Date: 2026-10-29

## Context

ADR 0024 set the M6 look bar at no gap-table cell above 1 against references 02 to 05. After the passes the spec allows (T28, T28b, T28c), 15 cells are still above 1 (`docs/art/gallery/pass-5.md`). The remaining gaps need development changes (head-heavy chains, coils longer than the reach, bare broad legs) or a ceiling that `docs/art/README.md` assigns to the rarest creatures (references 04 and 05). The owner has the options in issue #177 and has not replied. The M6 spec says the factory continues and that M6 is a `gate`: the owner judges the look at the Playtest issue.

## Decision

- M6 closes and releases as v0.7.0 with the look bar open. The rubric item stays unticked, with the evidence and #177 beside it.
- The Playtest issue for v0.7.0 carries the owner's look check. The factory waits there, as it does for every gate.
- The owner's answers to #177 and the Playtest decide whether the gaps become tasks of M7 or a later look milestone.

## Consequences

- No new development rule or genome change rides on this decision: the gaps are not worked around by lowering the bar in the tests or in the gallery table.
- Rejected: holding the release for more look passes (the spec caps the passes, and the gate is where the owner decides).
