# Hub cost report

Reproduce with `npm run report:hub`, which runs `worker/hub-cost.test.ts` (a `speedTest`) and
writes this file and `hub.json`.

What each kind of message costs the real Durable Object (ADR 0067), with real sockets and a
recorded creature seated in one populated area: 50, 200, 500 sessions. A batch of 200 messages goes through the
object's own dispatch (`webSocketMessage`) inside the object and is timed on the local runtime's
clock, which steps by 1 ms, so a batch of 200 resolves 0.005 ms per message; each figure is the median of 5
batches (a `spawn` is each session's first ask, a `batch` is every batch of a 300-frame witnessed duel, the frame step
a 200-frame duel). **Production cannot measure this**: the deployed object's clocks stand still while
code runs (ADR 0067), so these figures come from the local runtime and tell the shape, not the
price of a message on Cloudflare's hardware.

## Milliseconds per message

| Message | 50 seated | 200 seated | 500 seated | 500 against 50 |
|---|---|---|---|---|
| avail | 0.015 | 0.010 | 0.010 | 0.67x |
| batch | 7.333 | 6.533 | 6.933 | 0.95x |
| input | 0.025 | 0.020 | 0.015 | 0.60x |
| lock-state | 0.015 | 0.015 | 0.010 | 0.67x |
| ping | 0.015 | 0.010 | 0.010 | 0.67x |
| progress | 0.020 | 0.015 | 0.015 | 0.75x |
| ride | 0.015 | 0.015 | 0.015 | 1.00x |
| signal | 0.025 | 0.025 | 0.025 | 1.00x |
| spawn | 1.357 | 1.413 | 4.040 | 2.98x |
| where | 0.070 | 0.095 | 0.110 | 1.57x |
| whereCrowd | 0.040 | 0.035 | 0.035 | 0.88x |
| frame step (an authority-refereed duel) | 0.185 | 0.095 | 0.105 | 0.57x |

The budget (the `speedTest`): each type at the largest size at most 1.5 times its cost at the smallest, plus 0.02 ms; a `spawn`, which reads every member, at most 10 times.

## Attachment sizes

Each seated session keeps its state in its socket attachment, as JSON (the limit is 2 KB).

| Median | p95 | Max |
|---|---|---|
| 569 B | 569 B | 596 B |

`spawn` is the one type that grows with the population, by design: `place()` reads every member of the
directory (ADR 0069 budgets it at 20 ms in Node at 10,000 members), and a session asks once per life. Its budget is that it grows no faster than the members do. On a straight line it costs about 6.0 ms more per 1,000 seated, so about 60.681 ms at 10,000 on the local runtime: the capacity model prices it.

Every type stays within the budget: a message costs the same with 500 seated as with 50.
