# 0076: Interrupted transactions: the ledger is the journal, and a sign-in names what is in flight

- Status: accepted
- Date: 2026-11-09

## Context

The brief asks for reliable interrupted-transaction recovery, and the roadmap's M14 for a journal under which killing the tab at any step stays consistent.

The authority already writes each step of a transition in one SQLite transaction, keyed by its request hash, and finishes what waits for a round on its own: a genesis whose round arrives with nobody connected is written and announced again at the next sign-in, births not yet written are finished there, fights are rebuilt from their log after a restart (ADR 0053), and a close writes the checkpoint.

The gaps are on the page and in what a sign-in says:
- the page takes a hub `commit` or `genesis` only while it asked in this page, so a tab reopened during the beacon wait shows Hatch, and with an empty hatch bucket offers the practice cell while its real creature is on its way;
- a mating committed but waiting for its round is named nowhere at sign-in, so a reopened tab shows no egg until the round comes;
- the identity seed's write resolves when its IndexedDB request succeeds, before its transaction commits, so a tab killed right after a recovery import can come back with the old identity.

## Decision

1. **The authority's ledger is the journal of record.** Every step is one SQLite transaction, idempotent by its key, and a step that waits for a round or a deadline completes on the authority whoever is connected. The page keeps no journal of requests and never replays a signed request from local storage.
2. **The transactions and their steps are catalogued in one table** that the hub's kill matrix walks: genesis, mating, promote, restore, death and its fallback, the fight (lock-in to settlement), the checkpoint on close and the seat back; the recovery import is the page's own.
3. **A sign-in names everything in flight** for its player, in `life` and the messages that follow it: the waiting genesis (`commit`), the waiting mating (`life.mating`: its commitment, its round and the partner's name; protocol 14), the pending child, the running fight, the fallback, and the away report.
4. **The page resumes from that word alone.** A waiting genesis shows its egg on the title and plays its reveal when the round comes; a waiting mating shows the egg beside the parent; what completed while the page was gone shows as done (the child active, the ancestor back, the creature's new condition). Hatch is never offered while a genesis is in flight.
5. **The page's durable writes** (the identity seed, a recovery import) resolve only when their IndexedDB transaction completes, with `durability: 'strict'` where the engine supports it.
6. **Evidence**: a hub kill matrix (each step × the player's socket closed, a sign-in again after 1 s and after 10 minutes, and the object rebuilt over its storage) and a page kill matrix in E2E (each step × the renderer crashed and the page reopened in the same browser profile).

## Consequences

- A kill loses at most what the hub never received, which the player can simply do again; nothing is done twice and nothing is left half done.
- The page needs no journal of its own, and no stale intent can act minutes later.
- Courts stay in memory (a 15 s invitation lost to a kill is a decline).
- Rejected:
  - a page-side journal that resends signed requests (the hub's idempotence makes a resend unnecessary, and a stale one could promote or restore against the player's later wish);
  - persisting courts in SQLite (rows for a 15 s exchange, against ADR 0008's write budget).
