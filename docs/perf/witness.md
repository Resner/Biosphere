# Witness cost report

Reproduce with `npm run report:witness`. The authority is charged for incoming WebSocket messages
(ADR 0008), so this counts those, and nothing it sends. `worker/witness-cost.test.ts` plays a hunt
of about 30 s (300 frames) in a hub test on the hand clock, once refereed by the authority alone and
once by a scripted witness that takes the duty 3 s after the lock-in; the table prices other lengths with the
same model, which `tools/witness-report.test.ts` checks against what the hub counted.

## Measured: a 30 s duel, the witness taking over at 3 s

| | Authority alone | With a witness |
|---|---|---|
| Inputs before the handover (frame 33) | 66 | 66 |
| Signals relayed for the duty links | 0 | 4 |
| The witness's `duty-ok` | 0 | 1 |
| Inputs from the handover on, or the witness's batches | 20 a second | 1 a second |
| The auditor's `duty-ok` and `attest` | 0 | 2 |

The cut over the whole duel is 6.0×
(guard: at least 4×). From the handover on the authority hears the batches and nothing else; per participant-second
the cut is at least 10× (guard), 10 inputs against 0.5 batches.

## The model, by length and handover delay

A fight of `N` frames with `F` fighters costs the authority alone `F × N` inputs. With a witness it costs
`F × h` inputs before the handover frame `h` (the delay plus 3 frames), `2F` signals, one `duty-ok`, one batch
per 10 frames after `h`, and the auditor's 2 messages. A fight over before `h` is the authority's alone.

| Fight | Alone | Witnessed (2 s) | Cut (2 s) | Alone | Witnessed (3 s) | Cut (3 s) | Alone | Witnessed (4 s) | Cut (4 s) |
|---|---|---|---|---|---|---|---|---|---|
| duel, 6 s | 120 | 57 | 2.1× | 120 | 76 | 1.6× | 120 | 95 | 1.3× |
| duel, 10.4 s (median genesis duel) | 208 | 62 | 3.4× | 208 | 81 | 2.6× | 208 | 100 | 2.1× |
| duel, 17.2 s | 344 | 68 | 5.1× | 344 | 87 | 4.0× | 344 | 106 | 3.2× |
| duel, 30 s | 600 | 81 | 7.4× | 600 | 100 | 6.0× | 600 | 119 | 5.0× |
| duel, 90 s (the timeout) | 1800 | 141 | 12.8× | 1800 | 160 | 11.3× | 1800 | 179 | 10.1× |
| melee of 4, 30 s | 1200 | 131 | 9.2× | 1200 | 170 | 7.1× | 1200 | 209 | 5.7× |

Short fights save little: the opening, before the round resolves and a link is up, is the authority's
(ADR 0058). At the measured 3 s delay a duel's cut reaches 4× from about 17.6 s, and a melee saves more, since each fighter's inputs stop reaching the authority.

## CPU

A batch of 10 frames of two fighters carries 20 input signatures; the authority checks each against its fighter's key
(`worker/witness-cost.test.ts`, workerd): at most 10 ms per batch (guard: under 10 ms), one batch a second per witnessed fight.
The authority alone checks none: inputs on its own sockets are authenticated by the session.

## Storage

A witness commitment (kept 14 days) and an attestation (kept for good) are in `docs/perf/storage.md`.
