# Hub load report

Reproduce with `npm run load:hub` (10 minutes of play and a minute or two to start and stop; `--clients 50 --minutes 3` is the quick mode
and prints without writing), which writes this file and `hub-load.json`.

500 headless clients (`tests/load-client.ts`, the page's own `HubClient` and `WhereReporter`) join over 2 minutes, hold for 6 and leave over 2, against the real Worker under `wrangler dev` with the recorded drand rounds. Each hatches a recorded genesis, `spawn`s, wanders (`where`), sends a `progress` every 30 s, offers to its `near` peers 2 times a minute (each answered by the target client through the hub) and leaves with `gone`. They open no WebRTC link. **This is the local runtime's work, not Cloudflare's**: CPU time is workerd on this machine, and the deployed object's clocks stand still while code runs (ADR 0067), so the figures tell the shape; the capacity model (`docs/CAPACITY.md`) prices it.

**The run passes**: every client seated, none closed for its rate, no `where` dropped, no audit flag, and the meter's messages equal the clients' sent counts within 1%.

## Messages per player-minute (the hold)

Over the hold's 3000.2 seated player-minutes. The clients' column counts what they sent; the meter's what the object counted.

| Message | Clients | Meter |
|---|---|---|
| attest | 0.00 | 0.00 |
| avail | 0.00 | 0.00 |
| duty-ok | 0.00 | 0.00 |
| genesis-request | 0.00 | 0.00 |
| hello | 0.00 | 0.00 |
| ping | 1.00 | 1.00 |
| progress | 2.00 | 2.00 |
| signal | 4.00 | 4.00 |
| spawn | 0.00 | 0.00 |
| where | 2.21 | 2.21 |
| **all** | 9.21 | 9.21 |

Request-equivalents per player-minute (the meter's, 20 messages each): 0.461.

## Storage and cost

| Figure | Value |
|---|---|
| Rows written per player-hour | 124.1 |
| Rows read per player-hour | 240.1 |
| Stored bytes per player-hour | 523,711 |
| Database at the start / end | 406,408 / 36,203,880 B |
| CPU ms per incoming message | 0.986 |
| Resident memory, peak above the start | 570.4 MB |

Every client hatches once in the run (a genesis, its commitments and the audit attestations), and the run lasts 10 minutes of play, so the rows and stored bytes per player-hour carry that one-time cost spread over a short stay: a player who stays for hours writes far fewer per hour. The capacity model (`docs/CAPACITY.md`) separates the hatch from the steady play; the figure to read for steady play is the messages above.

## Round trips

A `where` to the `near` that answers it, and an offer to the answer that comes back through the hub (the target client replies as soon as it hears).

|  | Samples | p50 | p95 | p99 |
|---|---|---|---|---|
| `where` → `near` | 9183 | 3 ms | 14 ms | 31 ms |
| offer → answer | 7873 | 5 ms | 15 ms | 30 ms |

8052 offers went out and 7873 answers came back.

## Closes, drops and flags

| What | Count |
|---|---|
| Sessions seated at the hold's end | 500 of 500 |
| Messages those sessions had received | 39,278 |
| Closes the clients did not ask for | {} |
| Refusals | {} |
| Messages the object dropped, by type | {} |
| Audit flags (after the 24 founders) | {} |
| Audit flags of the 24 founders | {"authority-only":24} |
| Clients that failed | 0 |

