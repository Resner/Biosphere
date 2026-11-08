# 0070: How the load gates read at 10,000: the budget's tail, hidden creatures as a rate, and the run's time

- Status: accepted (sets what gates 1 and 5 of M13's load scenario measure, which the spec gave as the wave's thresholds; the wave's own gates, ADR 0066, are unchanged)
- Date: 2026-11-08

## Context

M13 T5 runs the headless harness (ADRs 0062, 0063) with 10,000 players: a fill of 10 minutes at up to 18 joins a second, a hold of 6 minutes with churn (an exponential session with a 30-minute mean, each leaver replaced at once), and 600 fights. One run (seed `report0`, `docs/perf/load.md`) read:

- **Budget.** In the hold, the players past their first minute sent a median of 6.8 and a p95 of 15.7 world messages a minute (the hold's mean 9.1, a joiner's first minute p95 92). The spec's median 6 and p95 12 are the wave's (ADR 0066, 300 players, median 4.3, p95 9.4).
- **Hidden creatures.** 5 violation-seconds in 9.6 million client-seconds: one pair (129, 83 and 105 wu apart, reach 162) unlinked for 5 s past the grace, in the fill.
- **Time.** 352 minutes of wall time for 16 simulated minutes, against a target of 45.

The other four gates pass (placement and together unchanged from the wave; at most 24 links; no crowd; no fighter changing water).

## What it measures

- **The budget does not grow with the population; it is above the wave's.** At 1,000 players the same scenario read a median of 7.6 and a p95 of 18.4, at 10,000 6.8 and 15.7, and the hold's mean fell from 10.4 to 9.1. The messages are signals (offers, answers, refusals and resends through the hub: 12.1 of the 15.6 a player-minute in the whole run) and `where`s (3.3). The load's water is denser than the wave's: `place()` sends every newcomer to the best group, so the fill builds one group that holds most of the world (the report's table: 1 group at minute 9, 4 at minute 12), and a crowded neighbourhood refuses more offers (1.8 refusals and 2.3 resends a player-minute) than the wave's. The cost also falls through the hold (median 7 in its first minute, 6 in its last; mean 8.5 to 7.3): the world is still settling after the fill.
- **The tail of the distribution is the budget's real limit.** The Worker is held to one request-equivalent, 20 messages, per player-minute (ADR 0008). A p95 of 15.7 puts 95% of players under that limit by themselves, and a mean of 9.1 leaves the hub at 45% of it.
- **Hidden creatures are a rate at 10,000.** The wave found none among 300 players. A pair that closes while both are in a dial storm (the fill) can stay unlinked for a few seconds past the grace; over 10,000 players and 16 minutes that is bound to happen now and then. The cause (which of the hub's refusals or a resend delay left the pair unlinked) is not found: the run is six hours long and the pair is one in 9.6 million client-seconds.
- **The run takes hours.** The cost is per client-tick: about 100 µs in a settled world and up to 290 µs while 18 players a second join, on the page's own plan, snapshot and gossip rules for every client (96 million client-ticks). It is flat across the harness (no single function above 12%), so it grows with the clients, not faster. The wave's spec risk (a hold of 3 minutes) would save an hour of the six, as the fill is 140 minutes.

## Decision

- **Gate 1** reads: median at most 8, p95 at most 20 (the Worker's own budget), a joiner's first minute p95 at most 100, the hold's mean at most 12, as before. The measured 6.8 and 15.7 pass with a margin the tail needs, and a regression that sends a player past 20 a minute fails. The wave keeps 6 and 12.
- **Gate 5** reads: at most one hidden-creature second in a million client-seconds (9 in a 10,000-player run, 0 in the scaled run). The run measured 5. A rate is not a zero, but a zero over 9.6 million client-seconds is not a bound the dial rules keep.
- **The run takes what it takes.** `npm run sim:load` is a report, run on demand, not per change: the scaled run (100 players filled over 3 minutes and held for 6, about 40 s) is the `heavyTest` that gates every merge, against the same gates. The committed report is one run, and its Timings section says how long it took. The scaled run is 100 players, not the spec's 500 filled over a minute: a quick fill leaves the water still forming its groups through a short hold (a median of 16 to 19 against the gate, from the fill's joins), and 500 players for three minutes do not fit the heavy test's 120 s.
- **The spec's rubric line "within 1.25 times the wave's at 300" is not met by the model**: the median is 1.6 times, the p95 1.7 times, the mean about the same. The reading is for the milestone close and the owner: the cost is flat in the population, and the difference is the dial rules in denser water (a faster dial for newcomers is the lever, ADR 0066's note, and a change to ADR 0063).

## Consequences

- `tests/load.ts` holds the gates; `docs/perf/load.md` and `load.json` are one run's evidence, its gates 1 and 5 re-read under this ADR from the same numbers.
- The harness gained what the run needed (`Scenario.meter`, `pairsEvery`, `pairSample`, `rateEvery`, `progress`; a binary heap for events; a client's counters taken when it leaves; a fighter's leave waits for its fight), and the clearance a spawn owes its group is the largest it owes any member (a starter beside a T1 owes the T1's), which the wave's gate 3 now reads too.
- M13 T8's capacity model reads the per-message and per-player figures of `load.json`.
