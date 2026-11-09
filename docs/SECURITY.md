# Security

The security review of v1.0 (M14 T16): what Biosphere protects, from whom, every surface an attacker can reach and the check that covers it, and what stays a residual risk. `tools/security.test.ts` keeps this page honest: every surface below has a row, and every file a row names exists. What players' data is kept, where and for how long, is in `docs/PRIVACY.md`.

## Threat model

**What is protected**

- **Identities' keys.** Each browser's identity is an Ed25519 seed in IndexedDB (`src/ledger/idb-keystore.ts`); whoever holds it is that player. It leaves the browser only as the recovery code the player chooses to show.
- **Lineage integrity.** Every creature's history is a chain of records signed by its owner and countersigned by the authority, checkable by anyone (`docs/VERIFY.md`). Nobody may append to another player's chain, fork a chain, or claim growth, fights or births that did not happen within the rules' bounds.
- **The authority's signing key.** Kept in the object's own SQLite (`keys`), made there on first use, never served (`GET /v1/pubkeys` serves only public keys) and never rotated by hand (`docs/OPERATIONS.md`).
- **The budget.** The free plan's daily allowances (request-equivalents, rows written and read, storage, TURN): a flood that spends them shuts everyone out until 00:00 UTC.

**Who attacks**

- **Modified clients**: a page or a script that speaks the protocol with any values it likes. Everything a client sends is a claim the authority bounds or a referee checks.
- **Bot farms**: many identities from one machine, to farm prey, witness themselves or fill the line.
- **Griefing peers**: a linked player who sends malformed, oversized or forged events and snapshots, or floods signals.
- **A hostile page script**: markup or script injected into one of the pages (through a name, a chat line, a URL parameter or a dependency) that would read the identity's seed.
- **The supply chain**: a compromised npm dependency in the shipped bundle or the Worker.

## Surfaces

Each surface, what guards it, and the tests or documents that show it.

| Surface | What guards it | Checked by |
|---|---|---|
| Hub messages (a page to the authority) | One parser for every message, `parseClientMsg`, with a size cap per type (`HUB_MAX_BYTES` and the larger caps beside it) that refuses unknown fields; a session's messages count in a 10 s window (20, signals 60, a fighter's inputs 130, a referee's batches and disputes 30, dropped past it); a flood closes the socket 4003; a hello must be signed over a fresh nonce | `src/net/protocol.test.ts`, `worker/hub.test.ts` ("closes 4003 above 20 messages in 10 s", "closes 4002 on a bad signature"), `worker/witness-wire.test.ts`, `tests/parsers.test.ts` |
| Hub messages (the authority to a page) | `parseHubMsg`, with the same caps; a page drops what does not parse | `src/net/protocol.test.ts`, `tests/parsers.test.ts` |
| Peer events | `parsePeerEvent`: at most 2 KB (a relay 10 KB), unknown fields refused, dropped and counted; a link's first event must be a hello whose seat ticket the authority signed, else it closes; relays are signed, one hop, at most 4 a second per link | `src/net/protocol-world.test.ts`, `src/net/peer-mesh-hello.test.ts`, `src/net/signal-route.test.ts`, `tests/parsers.test.ts` |
| Snapshots | Fixed sizes (29, 61 or 93 bytes) decoded by `decodeStateFrame`; a signed frame checked against the sender's key and the world; proxy frames dropped unless their rules hold | `src/ledger/snapshot-sig.test.ts`, `src/net/proxy-snaps.test.ts`, `tests/parsers.test.ts` |
| Witness messages | `protocol-witness.ts` refuses unknown fields; batches capped (1–20 frames, 12 KB) and each input's signature checked; an attestation must be signed and name its duty; a forger or an equivocator is struck | `src/net/protocol-witness.test.ts`, `worker/witness-fight.test.ts`, `worker/attest.test.ts`, `worker/witness-wire.test.ts` |
| `/v1/proof` and `/v1/fight` | 64-hex ids only (400), the origin check, edge-cached, metered, 503 `busy` past 80% of the day's requests | `worker/proof.test.ts` ("answers 400 for a malformed id, 404 for an unknown one and 503 past 80% of the budget"), `worker/public.test.ts` |
| `/v1/audit` | Counts only, no ids; the origin check; edge-cached 5 min; 503 `busy` past 80% | `worker/audit.test.ts` ("answers busy past 80% of the day budget, and caches nothing then"), `worker/public.test.ts` |
| `/v1/metrics` | No player named; the origin check; edge-cached 60 s; still answered past 80% | `worker/metrics.test.ts`, `worker/public.test.ts` |
| `/v1/pubkeys` and `/v1/health` | Public keys and the version only; the origin check | `worker/index.test.ts`, `worker/public.test.ts` |
| `?hub=` | A local authority only (`localhost`, `127.0.0.1`); any other host is ignored, so a shared link cannot send players to someone else's hub | `src/game/online-config.test.ts` ("refuses a ?hub= that is not local, so a shared link cannot redirect players"), `src/card/load.test.ts`, `tools/csp.test.ts` |
| `?genome=` | Parsed by `parseGenomeText`; a pinned body is a practice cell that sends nothing, so it can't choose a recorded creature's genome | `src/genome/codec.test.ts`, `tests/parsers.test.ts` |
| The card's `?c=` | 64 lowercase hex, else no request; the proof parsed as untrusted JSON and checked in a worker | `src/card/load.test.ts`, `src/ledger/proof.test.ts`, `tests/parsers.test.ts` |
| The Lab's paste box | `parseGenomeText`, exactly one genome long; anything else changes nothing | `tests/e2e/m3-lab-tools.spec.ts` ("a genome copied out loads back in with the same hash; garbage changes nothing"), `tests/parsers.test.ts` |
| The recovery import | `decodeRecoveryCode`: exactly one code with its check, else refused and the identity kept | `src/ledger/recovery.test.ts`, `tests/e2e/m4-recovery.spec.ts` ("a wrong code is refused and the creature stays"), `tests/parsers.test.ts` |
| Names and chat | A name is 3–16 letters, digits, `_` or `-` that pass the profanity filter (the hub refuses others); chat is filtered and rate-limited; both reach the page only as text: no markup sink takes anything but a static template | `src/net/text.test.ts`, `tools/security.test.ts`, `tests/parsers.test.ts` |
| The pages (index, Lab, card) | A Content-Security-Policy `<meta>` on each: scripts and workers from the site alone, no `eval`, connections to the site, the authority and local hubs only, no plugins, no `<base>`, no form posts; the pages count what it blocks (`state().csp`) and the E2E helpers fail a test that saw any | `tools/csp.test.ts`, `src/game/csp-watch.test.ts`, `tests/e2e/m14-csp.spec.ts`, `tools/security.test.ts` |
| The E2E entry | Fixture drand and the `/v1/e2e/*` hooks live only in `worker/e2e-entry.ts`, never in the production bundle; fixture-only variables are read only there | `tools/worker-bundle.test.ts` |
| Secrets | Read only in the release workflow's deploy steps; the TURN token never reaches a response, a log or an error | `tools/release-workflow.test.ts` ("reads the Cloudflare secrets only in the preflight and the Worker deploy steps"), `worker/hub.test.ts` ("never leaks the token to a response, a log line or an error") |
| The repository and the built site | The build bakes in two values only, both public (`BUILD_LABEL`, `AUTHORITY_URL`); no secret value appears in a workflow | `tools/security.test.ts`, `tools/release-workflow.test.ts` ("has no secret value, only secrets.* references") |
| Deterministic replay | What a lineage check proves and what it can't is in `docs/VERIFY.md`; the residual risks are below | `docs/VERIFY.md`, `docs/decisions/0059-farming-and-movement-checks.md`, `docs/decisions/0012-witnesses.md` |

## Public endpoints

How each endpoint answers a browser on a foreign origin, a request with no origin (curl, an uptime check), and a path longer than 128 characters (414 `path`, before anything else is read). `worker/public.test.ts` reads this table and checks each row; nothing here is private, so a request with no origin is answered.

| Endpoint | A foreign origin | No origin | Cache |
|---|---|---|---|
| `GET /v1/health` | refused (403) | answered | none |
| `GET /v1/pubkeys` | refused (403) | answered | 5 min |
| `GET /v1/proof/<id>` | refused (403) | answered | 60 s to a day, by age |
| `GET /v1/fight/<id>` | refused (403) | answered | 60 s, a day once settled |
| `GET /v1/audit` | refused (403) | answered | 5 min |
| `GET /v1/metrics` | refused (403) | answered | 60 s |
| `WS /v1/hub` | closed 4004 | closed 4004 | none |

The allowed origins are the Pages site (`https://resner.github.io`) and `http://localhost` or `http://127.0.0.1` on any port (`worker/origin.ts`). The proofs, the audit and the metrics carry no CORS header in the edge cache; each answer adds its own origin's.

## Parsers

Every parser of untrusted input, and what hands it the value. Each takes 10,000 fuzzed values in `tests/parsers.test.ts` and none throws; that test fails when an exported `parse…` or `decode…` is in neither its list nor its short list of parsers that read only the game's own data.

| Parser | Untrusted input |
|---|---|
| `parseClientMsg` | hub messages, at the authority |
| `parseHubMsg` | hub messages, at a page |
| `parsePeerEvent` | peer events |
| `decodeSnapshot` | snapshots |
| `decodeStateFrame` | snapshots, signed and proxy frames |
| `decodeInput` | a peer's input code |
| `decodeFrameInput` | fight inputs and witness batches |
| `parseFoodId` | peer claims |
| `bodyFromText` | a fighter's genome text |
| `genomeFromBase64url` | genome text |
| `parseGenomeText` | `?genome=` and the Lab's paste box |
| `decodeGenome` | genome bytes |
| `parseBeacon` | beacons in hub messages and proofs |
| `genesisAsk` | genesis asks |
| `mateAsk` | mate asks |
| `signedCommit` | commitments |
| `storedRecord` | records |
| `parseRefereeSpans` | settlements |
| `parseDutyEvent` | witness duties |
| `parseSignedAttestation` | witness attestations |
| `parseSignedSeat` | seat tickets in peer hellos |
| `parsePubKeys` | `GET /v1/pubkeys` |
| `parseAuthorityKeys` | a proof's keys |
| `parseProofBundle` | `GET /v1/proof` |
| `parseFightProof` | `GET /v1/fight` |
| `creatureParam` | the card's `?c=` |
| `hubSocketUrl` | `?hub=` |
| `qualityFromSearch` | `?quality=` |
| `worldFromSearch` | `?world=` |
| `decodeRecoveryCode` | the recovery import |
| `validName` | names |
| `filterText` | chat |
| `isProfane` | names and chat |
| `loadSettings` | a damaged browser store (`bs.settings`) |
| `loadBench` | a damaged browser store (`bs.bench`) |
| `loadName` | a damaged browser store (`bs.name`) |
| `MuteList` | a damaged browser store (`bs.muted`) |
| `Guide` | a damaged browser store (`bs.guide`) |

The message parsers also keep their own fuzz tests over mutated valid messages (`src/net/protocol.test.ts`, `src/net/protocol-world.test.ts`, `src/net/protocol-witness.test.ts`, `src/net/protocol-encounter.test.ts`, `src/net/protocol-fight.test.ts`).

## Dependencies

`npm audit --omit=dev` on 2026-11-09: **found 0 vulnerabilities** in the shipped dependencies (three.js, `@noble/curves`, `@noble/ed25519`, `@noble/hashes`). Run it again before each release that adds or upgrades one; a high or critical advisory in a shipped dependency blocks the release until it is fixed.

## Findings of this review

Fixed in M14 T16:

- **No Content-Security-Policy.** A script injected into a page could have read the identity's seed and sent it anywhere. Every page now carries one (above), and every E2E scenario runs under it.
- **Mates' names kept for good.** The names a mating's commitment takes (for a sign-in during the wait, ADR 0076) stayed in `matings` after the children were born. They are now cleared in the transaction that writes the children (`worker/ledger-mating.test.ts`).
- **No cap on a request's path.** Every path over 128 characters is now refused with 414 before the Worker reads it.
- **Parsers without a fuzz test.** `decodeInput`, `decodeFrameInput`, `parseFoodId`, `bodyFromText`, the genome text parsers, the URL parameters, the recovery code and the browser store's readers had none; the catalogue covers all of them now.

## Residual risks

- **What deterministic replay does not prove** (`docs/VERIFY.md`, ADRs 0059 and 0012): that the authority served everything it holds; that claims within the bounds came from honest play (movement, eating, hazards and a self-reported death are clamped, not simulated); that fight inputs came from people or that players did not collude; that identities are distinct people; that witnesses are independent of the authority. The authority is trusted for time, sessions and serving everything; its keys are the one thing a check takes on trust.
- **One origin for every Pages site of the account.** GitHub Pages serves every project site of `resner` from `https://resner.github.io`, so another repository's Pages site under the same account shares this origin: its scripts could read the identity's seed, and the Worker accepts its requests. Keep no other Pages site on the account, or move the game to a domain of its own (the owner's call; `AUTHORITY_URL` and `worker/origin.ts` would follow it).
- **Inline styles are allowed** (`style-src 'unsafe-inline'`): they can't run code, and no markup sink takes untrusted text, so an injected style could only restyle the page.
- **No framing protection.** A `<meta>` policy can't set `frame-ancestors`, and Pages sets no headers, so another site can frame the game. A click a hidden frame steals could hatch or court, never move an identity: the recovery code is only shown on the page, which a framing site can't read.
- **The identity's seed is readable by any script on the origin.** The policy and the markup checks make injection hard; a malicious browser extension can still read it, as for any web app.
- **Network addresses.** Peers linked by WebRTC see each other's addresses, and the authority sees each player's address (it keeps only a salted hash, in memory, for witness independence). `docs/PRIVACY.md` tells players so.
