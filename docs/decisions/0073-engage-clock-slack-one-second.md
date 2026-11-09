# 0073: An engage's snapshots may be a second off the hub's clock

- Status: accepted (refines 0050's freshness window)
- Date: 2026-11-09

## Context

An engage carries two signed snapshots, and the authority refuses it `engage:stale` unless each snapshot's pond tick lies within `snapshotMaxAge` (9 ticks) behind and 0 ahead of its own pond tick, plus a clock slack of 3 ticks (100 ms) either way.

A page's pond clock is a minimum-RTT estimate of the hub's clock (ADR 0016). On a loaded runner, and on a slow or lopsided link, it is off by a few hundred milliseconds. `E2E main` run 219 and a local repeat of `m7-carrion` showed it: the hub's own log gave the hub tick against the attacker's snapshot (14 and 16 ticks ahead, in two runs) and the target's held frame (14 behind the window's edge). A page whose clock is more than 3 ticks fast cannot engage at all until its next drift check, 10 seconds later; `m7-carrion`, `m7-lifecycle` and `m10-card` each waited 40 seconds and gave up.

## Decision

The slack is 30 ticks (1 s) either way. The window is then 39 ticks behind and 30 ahead of the hub's pond tick.

## Consequences

A snapshot can be replayed for about two seconds instead of half a second. That window bounds nothing else: the claim's condition is still clamped to what the wall time allows (`clampClaim`), and the movement and sight checks read the snapshots' own ticks. A real player on a poor link can now engage.
