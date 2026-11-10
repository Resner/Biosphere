# 0079: The capacity model prices matings and promotions, and the soak judges the mix it plays

- Status: accepted (amends ADR 0071's per-player rows written and ADR 0075's numbers; the rules stay)
- Date: 2026-11-10

## Context

The one-hour soak (M14 T14) wrote 188 rows per player-hour against `MEASURED`'s 65.5. The meter counted rows but not what they were for, so T14d counted them by table (`Authority.rowCount.tables`, `GET /v1/e2e/rows`, the report's "Rows written, by table") and priced each transaction on the hub (`worker/lifecycle-rows.test.ts`): a genesis hatch writes 12 rows, a mating 20 (its commitment, both mate-commits, the round's write and both children) and a promotion 5.

The model of ADR 0071 counted sessions (2 an hour, 3 rows each), checkpoints (4 an hour) and fights (3 an hour, 37 rows each, half a fight per player), and nothing else. Matings are the game's core loop (DESIGN §6: a 9-minute cooldown, 6.2 children per hour of active time), so the model left out its second-largest write. The soak also played a mix far from the model's: sessions every 10 minutes (5 an hour, not 2), about 6 fights an hour at least, and matings at a 5% cooldown (12 an hour).

## Decision

**The model prices matings and promotions.** `ASSUMPTIONS.matingsPerHour` is 1.5 (DESIGN's 3.1 an hour at the cooldown, half lost to finding no partner: a guess, like the relay share, that the playtest's `/v1/metrics` replaces), each followed by a promotion; a mating's 20 rows are shared by its two players. That adds 22.5 rows to a player-hour (88.0 in all). A player's one hatch stays in no hour. `MEASURED.lifecycle` holds the rows (`LIFECYCLE_ROWS` in `tools/capacity-measure.ts`, held to the hub by a test, as the fight's fixed rows are by theirs).

**What it moves** (`docs/CAPACITY.md`): the free plan serves 1,136 player-hours a day (was 1,526), about 47 players around the clock (was 63). The headroom on a fresh free day is 568 seats, below the cap of 621, so it binds there; a crowd of 200 plays 3.7 hours before the headroom stops newcomers (was 5.6) and 5.1 before the budget guard (was 6.9): an hour's playtest of 200 is unaffected, a second one the same day waits for midnight UTC or the paid plan. The paid plan's cap, its allowances and its 590 seats don't change (its bill is all requests). 10,000 players cost $1,553 a month (was $1,391).

**The soak judges the mix it plays.** The full soak (and `--model-mix`) plays the model's sessions (a client signs in 30 minutes apart) and a fight rate a tenth of the quick mode's (`FULL_MIX`: fewer hunts, and a client joins a hunt at 1.5% a roll, not 25%: with a crowd of clients someone always hunts, so the joining chance sets the rate). Matings are not tuned: they are what the 5% cooldown allows, 8 times the model's. So `checksOf` prices the run with what its clients did (`playedMix`, `modelOf`): rows written and messages per player-hour must be within 1.5 times the model's for the sessions, fights, matings, promotions and hatches per player-hour the clients counted (seated player-hours from the meter). A run with no player-hours falls back to `MEASURED`'s mix.

## Consequences

- The model is checked at three layers: a hub test per transaction (rows), the soak's counted mix (the hub writes nothing the model does not price, within 1.5), and the playtest's `/v1/metrics`.
- A new multi-row transaction joins `lifecycle` and the test, or the soak's check will say the hub writes more than the model.
- The 200-player playtest should be one hour on a fresh free day, or on the paid plan (`docs/OPERATIONS.md`).
