# 0009: Identity and UTXO-like lineage records

- Status: accepted (amended by 0019: `t` and `age` live in the authority's acceptance, not in the owner-signed record)
- Date: 2026-10-25

## Context

The brief asks for a browser keypair identity with an exportable recovery key (no email or passwords), and a UTXO-like state model: each significant update consumes the accepted previous state, each creature has exactly one accepted current state, and full ancestry, with both biological parents, can be verified independently from genesis records, hashes, signatures, rules versions, inheritance seeds and transition records. Restoring an ancestor creates a new transition and never revives an old spendable state. A hash proves integrity, not legitimacy.

## Decision

**Identity:**

- A 32-byte Ed25519 seed per browser profile (`@noble/ed25519` with `@noble/hashes`, synchronous and identical in browsers, Node and workerd), stored in IndexedDB behind a `KeyStore` interface.
- `playerId` = base64url of the public key.
- **Recovery code**: Crockford base32 of the seed plus a 2-byte checksum, in groups of 5. It is shown only on explicit export; importing it replaces the local identity.
- Identity is bound to the site's origin (`resner.github.io`). Moving domains means importing the code. Other pages on the same origin could read IndexedDB; we accept that while the owner controls the origin.

**Records:**

- `{ v: 1, rules, kind, creature, seq, prev, owner, t, body }`, encoded as canonical JSON (RFC 8785) with **integers and strings only** (fixed-point where needed, never floats).
- `hash = SHA-256("bs/rec/v1\n" ‖ JCS(record))`, as hex.
- The owner signs the hash (Ed25519, domain-separated). The authority countersigns with its own key: generated inside the Durable Object, stored there, published at `/v1/pubkeys` with key ids, and named by key id in every countersignature.
- `t` is the authority's clock in ms, set by the authority.
- A creature's id is the hash of its genesis or birth record.

**Kinds**: `genesis`, `checkpoint`, `death` (M4); `mate-commit`, `birth`, `promote`, `restore` (M5); `encounter` (M7–M8). Witness attestations are separate signed documents that point at records (M10).

**UTXO rule:**

- A transition must name `prev` = the creature's current head and `seq` = head.seq + 1. The authority accepts the first valid one atomically. Later ones with a stale `prev` are rejected as conflicts and logged for detection.
- Resubmitting an accepted transaction returns the same acknowledgement (idempotent by hash).
- Creature status: `pending` (offspring not yet promoted), `active` (at most one per player), `checkpoint` (inactive, paused), `dead`.

**Ancestry**: birth records name both parents' creature ids and the mating commitment, so ancestry is a graph. A player's checkpoint history is the chain of creatures they promoted or restored, recorded by their `promote` and `restore` records.

**Retention**: the authority keeps every accepted record that verification needs, so histories stay checkable when the original peers are offline. Proof bundles and compaction of high-volume checkpoints come in M9.

**Legitimacy** is checked by rules, not hashes alone. Verification recomputes genesis and inheritance from beacons and checks time gates, costs and encounter settlements (M9).

## Consequences

- Any third party can verify a lineage with the public records, the authority's public keys and drand beacons. Trust is still placed in the authority's countersignature for facts it witnessed itself, such as time and session state. That is stated in `docs/VERIFY.md` (M9).
- Losing a browser without the recovery code loses the identity. The UI reminds players to export it after their first mating (M4 and M5).
- Rejected:
  - passwords or email (out of scope for v1);
  - WebAuthn passkeys (not exportable as a recovery key);
  - any blockchain (the brief rules it out; a single authority with public records is enough);
  - floats in records (cross-language canonicalization pitfalls).
