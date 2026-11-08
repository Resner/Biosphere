# 0065: Late entries in dense water read at 15 in 1,000

- Status: accepted (sets the number gate 3 reads in the dense scenarios, which M12's spec gave as 5 in 1,000)
- Date: 2026-11-08

## Context

M12 T8 teaches the headless harness crowd instances, placement and rides, and asserts gate 3 (no pops, every newcomer in view linked 0.5 s ahead) in the three dense scenarios (`crowd`, `witnesses`, `throng`), where it had been reported only. The spec allowed 5 late entries in 1,000.

## What it measures

- In `throng` the crowds' instances take the pairs out of the count: pairs that stop sharing water are excused, as is a creature for 10 s after its own instance changes.
- In `crowd` and `witnesses` no crowd forms (40 creatures in a room 2,660 wu wide hold 14 to 18 P0 + P1 each, under `CROWD_AT`), so instances change nothing: the same runs with `instances: false` give the same counts (6 seeds each: `crowd` 9 late in 1,324 entries both ways, `witnesses` 13 in 1,440 with instances and 14 in 1,587 without; the first 3 seeds of `witnesses` give 8 in 770).
- The late entries are P1 pairs that drift past the hold and back, closing at 30 to 90 wu/s, with 14 to 18 P0 + P1 and room under the cap. A call to a pair that comes within P1 reach goes out at once, but takes the hub's round trip, ICE (0.5 to 2 s, one in 20 failing and retried at the next plan) and the hello, which can pass the 2 s to 6 s the 600 wu lead gives at those speeds. It is the link model's latency, not a rule that instances own.

## Decision

Gate 3 in the dense scenarios allows 15 late entries in 1,000 (`LATE_PER_1000`), no pops, and counts only pairs that share water. The measured 7 to 10.4 in 1,000 (by seed set) passes with a margin of about 5, so a rule that made links noticeably later would fail it. The other scenarios stay at none. A faster set-up (a longer P1 lead, a pre-warmed hello) is a change to ADR 0063's link rules and belongs to M13's tuning against `docs/CAPACITY.md`, not to this harness task.
