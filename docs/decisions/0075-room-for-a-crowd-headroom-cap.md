# 0075: Room for a crowd: the session cap follows the day's headroom

- Status: accepted, amended by 0079 (the headroom on a fresh free day is 568 seats and a crowd of 200 plays 3.7 hours, once matings are priced) (amends ADR 0071's free-plan cap and ADR 0067's session cap rule)
- Date: 2026-11-09

## Context

ADR 0071 capped the free plan at 63 seats: what its daily allowances serve around the clock (1,526 player-hours a day, rows written binding first). M14's exit criterion is a playtest with about 200 concurrent players from the Pages build. The brief says the owner tests with friends from the Pages link, so it must work without setup; ADR 0071's way to raise the cap (`MAX_SESSIONS`, or the paid plan) needs a variable and a redeploy.

A playtest is a burst. 200 players for two hours use 400 player-hours, a quarter of the free plan's day. Players come in bursts in general; a cap set by the day's average turns most of them away at the one hour they come.

Seated players are never dropped (ADR 0067), and the budget guard stops newcomers at 90% of an allowance, so the last 10% is what seated players spend after the line forms. At 63 seats that margin lasts about 2.4 hours. A cap of 621 with no other rule would spend a fresh free day in about 2.2 hours and the margin in 15 minutes, after which Cloudflare refuses the object's requests.

## Decision

- **The free plan's session cap is 80% of one object's capacity** (621 at the measured 777), the bound the paid plan already has. The paid plan keeps its money cap (590).
- **A headroom cap on both plans.** A newcomer is seated only while everyone who holds a seat (seated sessions and away fighters), plus the newcomer, could play `HEADROOM_H` (2) more hours within what is left of the day's allowances (to 100%) at the measured per-player-hour costs (`ratesOf(MEASURED, ASSUMPTIONS)`: request-equivalents, rows written and rows read):

  `headroom = min over items of floor((allowance − used today) ÷ (per-player-hour cost × 2))`

  The line's reason is `full` (a seat frees as players leave). While the headroom binds, the wait counts the seats that must free first: the holders plus one, less the headroom, then one interval per place ahead.
- **The other guards are unchanged**: `budget` at 90% of an allowance (and its reopening at 00:00 UTC), `storage`, the TURN guard, seats back within 2 minutes, and no seated player ever dropped. `MAX_SESSIONS` and `DAILY_REQUEST_BUDGET` still override for tests and the load tools.
- `/v1/metrics`' `admission` reports the headroom in seats, and `docs/CAPACITY.md` says how long crowds of 50, 200 and 621 can play from a fresh day on each plan before the line forms.

## Consequences

- On a fresh free day the cap is 621; about 200 players can play for over five hours before the headroom stops newcomers, and nearly seven before the budget guard.
- A busy morning can spend the free plan's day sooner than the old cap allowed. The line still names the reopening hour, and the paid plan's allowances are large enough that its headroom rarely binds.
- A crowd that stays far past its two hours late in the day can still reach the free plan's hard limit, where Cloudflare refuses requests until 00:00 UTC. `docs/OPERATIONS.md` says what that looks like and that the paid plan removes it.
- Rejected:
  - asking the owner to set `MAX_SESSIONS` or switch plans for the playtest (setup and a redeploy, against the brief);
  - keeping 63 (the 200-player playtest would queue about 140 players);
  - 621 with no headroom (the free day gone in about two hours, and the hard limit 15 minutes after the guard);
  - pacing the day by the clock (seats per hour left) instead of by headroom (it turns bursts away as the old cap did).
