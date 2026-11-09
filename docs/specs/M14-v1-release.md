# M14: v1.0 release

Release: v1.0.0 · Gate: yes (about 200 players)

## Goal

Everything in the brief works together, hardened, in the four desktop browsers, and the owner can run a playtest of about 200 players from the Pages link with nothing to set up.

- **Nothing is lost to a closed tab.** Killing the tab at any step of a hatch, a mating, a promotion, a return to an ancestor, a death or a fight leaves the world consistent, and the reopened tab shows exactly where its player stands: a hatch still waiting shows its egg (never a second Hatch), a mating still waiting shows the egg beside the parent, and what finished meanwhile shows as done (ADR 0076).
- **Chrome, Edge, Firefox and Safari.** Every golden (sim, development, inheritance, encounters, records) gives the same answer in Chromium, Firefox and WebKit. The release gate plays the game in Firefox and WebKit, a Chromium and a Firefox player meet and fight with identical results, and a browser that lacks what the game needs gets a plain screen that says what to do.
- **A newcomer learns by playing.** A first life is guided by short hints at the moment each matters (swim, eat, dash, hazards, bigger creatures, attacking, maturity, courting, the egg, the menu, the wheel), a "How to play" panel answers the rest with every control, and no cue relies on colour alone.
- **Balanced.** A balance simulation lives whole lives of the 11 archetypes and their variants: at least 3 archetypes reach the top 10%, and none holds half of it.
- **Room for 200.** The free plan seats a crowd: up to 621 at once, as long as everyone seated could play two more hours within the day's allowances (ADR 0075). A one-hour soak with 200 headless players, two real pages and random dropped connections keeps every limit, every ledger invariant and every resource level.
- **Run by the owner.** `docs/OPERATIONS.md` says how to deploy, watch, switch plans, handle incidents and run the 200-player playtest; `npm run ops:watch` follows `/v1/metrics` live. `docs/SECURITY.md` and `docs/PRIVACY.md` record the security and privacy review.
- **The permanent world.** v1.0.0 renews the world once more (rules 13, epoch 5), and from then lineages are permanent: no more renewals, and a released rules version's goldens never change (ADR 0074).
- **Brief coverage, with evidence.** `docs/COVERAGE.md` maps every requirement of the brief to the test, report or owner check that shows it, and a test keeps the map honest.

The decisions behind this milestone:
- ADR 0074: one last renewal at v1.0.0 (rules 13, epoch 5, protocol 14), then permanent lineages and frozen versions.
- ADR 0075: the free plan caps at 80% of one object (621), and a headroom cap on both plans keeps everyone seated two hours of the day's allowances.
- ADR 0076: the ledger is the journal of interrupted transactions; a sign-in names everything in flight, and the page resumes from that word alone.
- T6 writes the engines ADR (what CI checks in each engine, and what only the owner can), T10 the balance ADR (how the gate reads), each with the next free number when written.

`docs/DESIGN.md` §5, §8 and §10 describe the targets, marked M14.

This milestone **is a gate**: the factory waits for the owner's reply on `Playtest: v1.0.0`. **World renewal**: rules 13, epoch 5 (T1). **Protocol**: 14 (T1).

## Carried over

No owner input since Playtest v0.8.0 (#311: "Keep going. Godspeed!"). Playtests v0.10.0 (#379) and v0.11.0 (#418) have no replies; their owner checks go into the v1.0.0 Playtest issue (T18).

| From | Task |
|---|---|
| M13 T11 (found, not fixed): an honest page that feeds is sometimes flagged `health-over`, `energy-over` or `biomass-over-max`; `m13-load` leaves those kinds out of its flag check | T2 |
| ADR 0040 and ADR 0055: the M14 spec writes the ADR that makes lineages permanent | ADR 0074; T1 (the renewal and the manifest), T18 (the pin) |
| ADR 0071: the free plan's cap of 63 falls far short of a 200-player playtest | ADR 0075; T12 |
| ADR 0071: the capacity model's assumptions (3 fights an hour, half witnessed, a 15% relay share, 30-minute sessions) need a playtest's `/v1/metrics` | T15 (`ops:watch` saves the answers), the `(owner)` rubric line |
| ADR 0071: a larger fight-log batch is the cheapest lever if rows written bind the free plan | not pulled; the headroom cap (T12) serves the playtest without it |

## Out of scope

- **Mobile and touch** (the brief puts them after 1.0), and localisation: English only.
- **Shards** (ADR 0071) and any change to the plans' prices or the $9.50 ceiling.
- **New genes, body parts, looks or look passes.** The balance pass moves values only (T11).
- **Key rebinding.** Keys are read by physical position (`KeyboardEvent.code`), so WASD sits where it should on any layout; the help panel lists every control.
- **A restore path for the authority's database** (Cloudflare's point-in-time recovery). `docs/OPERATIONS.md` states what a lost or corrupted object would cost, and it is a post-1.0 lever.
- **Moderation**: no reports, accounts or server-side mute. The profanity filter and the local mute stay as they are.
- **Real NATs, a real TURN relay, real Safari and real Edge in CI.** They are owner checks on the Playtest issue.

## Touches

- **New:**
  - worker: `worker/interrupt-kit.ts` (the transaction catalogue and `consistent`, T3), `worker/interrupt.test.ts` (T3);
  - ledger: `src/ledger/__golden__/frozen.json` and `src/ledger/frozen.test.ts` (T1);
  - game:
    - `src/game/guide.ts` (T7);
    - `src/game/help-panel.ts` and `src/game/controls.ts` (T8);
    - `src/game/cue-channels.ts` (T9);
    - `src/game/capability.ts` (T6);
  - tests and tools:
    - `tests/goldens-catalogue.ts` and its test (T5);
    - `tests/balance.ts`, `tools/balance.mjs`, `tools/balance-report.ts`, `npm run sim:balance`, `docs/perf/balance.md` and `balance.json` (T10);
    - `tests/life-client.ts` (T13);
    - `tools/soak.mjs`, `tools/soak-run.ts`, `tools/soak-report.ts`, `npm run soak`, `docs/perf/soak.md` and `soak.json`, `.github/workflows/soak.yml` (T13, T14);
    - `tools/ops-watch.ts`, `tools/ops-watch.mjs`, `npm run ops:watch`, `tools/ops-doc.test.ts` (T15);
    - `tools/coverage.test.ts` (T17);
  - E2E: `m14-goldens` (no hub, T5), `m14-smoke` 8842, `m14-mixed` 8841 and `m14-capability` 8845 (T6), `m14-guide` 8843 (T7), `m14-help` (no hub, T8), `m14-colour` (no hub, T9), `m14-interrupt` 8840 (T4), `m14-lifecycle` 8844 (T18);
  - docs: `docs/OPERATIONS.md` (T15), `docs/SECURITY.md` and `docs/PRIVACY.md` (T16), `docs/COVERAGE.md` (T17).
- **Changed:**
  - sim and genome: `src/sim/rules.ts` (`RULES_VERSION` 13, T1; values, T11), the stats and encounter tables (T11), the goldens they pin;
  - ledger: `src/ledger/registry.ts` (rules 13, epoch 5, `RELEASED`; T1, T18), `src/ledger/gates.ts` if the plausibility fix lands there (T2), `src/ledger/idb-keystore.ts` (T4);
  - net: `src/net/protocol-defs.ts` and `protocol-parse.ts` (protocol 14, T1; `life.mating`, T3);
  - worker:
    - `schema.ts` (migration 14, the renewal, T1);
    - `life.ts` or `lives.ts` (T2, T3), `offspring.ts` and `sessions.ts` (T3);
    - `admission.ts`, `capacity.ts`, `plan.ts`, `metrics.ts` (T12);
    - `e2e-entry.ts`: `POST /v1/e2e/hatches` (T4), `GET /v1/e2e/consistency` (T13);
  - game: `life.ts`, `app-life.ts`, `screens.ts`, `mate.ts`, `offspring.ts` (T4); `hints.ts` (replaced by `guide.ts`, T7); `hud-menu.ts`, `app-keys.ts`, `settings.ts`, `settings-panel.ts`, `hud.ts` (T7, T8, T9); `debug.ts` and `app-hook.ts` (hooks); `renewal.ts` and `index.html`'s notice (T1);
  - card: the verdict's wording on permanence (T1);
  - pages: `index.html`, `lab.html`, `card.html` (the capability screen T6, the CSP meta T16), `src/style.css`;
  - CI: `playwright.config.ts` (projects and hubs), `.github/workflows/e2e-full.yml` (a WebKit part, the Firefox part's specs; T6), `.claude/skills/milestone/SKILL.md` (a green `Soak` before the v1.0 close; T14);
  - docs: `docs/DESIGN.md` (§5, §6, §7, §8, §10), `docs/VERIFY.md` (T1), `docs/CAPACITY.md` (regenerated, T12), `docs/TESTING.md`, `docs/SETUP.md` (T15), `docs/ROADMAP.md` (T17), `README.md` (T18), `.claude/rules/*.md`.

**Shared shapes.** Tasks that run in parallel build to these. A later task maps between them rather than redefining them.

```ts
// src/sim/rules.ts (T1)
export const RULES_VERSION = 13;
// src/ledger/registry.ts (T1; T18 fills RELEASED)
export const FIRST_LIVE_RULES = 13;          // REGISTRY: [{ rules: 13, epoch: 5, since: every part 13 }]
export const RELEASED: Readonly<Record<number, string>>;  // rules version → SHA-256 of its frozen.json entry; {} until T18
// src/ledger/__golden__/frozen.json (T1): { "13": { "<repo path of a golden file>": "<sha256 hex>", … } }
//   `npm run goldens:manifest` rewrites the live version's entry; never a released one.

// src/net/protocol-defs.ts (T1): PROTOCOL_VERSION 14
// HubMsg 'life' gains (T3):
mating?: { commit: string; round: number; partner: string };  // committed, round not yet published; partner's name

// worker/admission.ts (T12)
export const HEADROOM_H = 2;
export function headroomSeats(hub: Hub, now: number): number;
// Metrics.admission gains `headroom: number` (seats the headroom allows now, before the cap)

// worker/interrupt-kit.ts (T3), used by T13's consistency hook
export interface Inconsistency { kind: string; player?: string; creature?: string; detail: string }
export function consistent(hub: Hub): Inconsistency[];   // [] when every invariant holds

// src/game/guide.ts (T7)
export type GuideStep = 'swim' | 'eat' | 'dash' | 'energy' | 'hazard' | 'bigger' | 'attack' | 'fight'
  | 'mature' | 'invite' | 'egg' | 'menu' | 'wheel' | 'death';
export const GUIDE_KEY = 'bs.guide';   // localStorage: the steps this browser has seen, as a JSON array

// src/game/controls.ts (T8): the one table of controls, read by the help panel and a key-map test
export interface Control { action: string; mouse: string | null; keys: readonly string[]; when: 'always' | 'play' | 'combat' | 'title' }
export const CONTROLS: readonly Control[];

// src/game/capability.ts (T6)
export interface Capabilities { webgl2: boolean; rtc: boolean; idb: boolean; ws: boolean; moduleWorker: boolean }
export function capabilities(win: Window): Capabilities;
```

**Page hooks** (`window.__bs`, `docs/TESTING.md`):
- `goldens` (T5, always present): `sets()` names each golden set the page can run, `run(set, input)` returns its output;
- `state().life.inFlight` (T4): `{ genesis: string | null, mating: { commit: string, partner: string } | null }`, the commitments the hub named;
- `state().guide` (T7): `{ on, seen, current, text }`; `debug.guideReset()` forgets what this browser has seen;
- `state().help` (T8): `{ open, section }`;
- `state().capabilities` (T6) and `state().unsupported` (T6: null, or the screen's reason);
- `state().csp` (T16): the Content-Security-Policy violations seen on this page.

**E2E entry hooks:** `POST /v1/e2e/hatches { player, left }` (T4) sets a player's hatch bucket; `POST /v1/e2e/beacons { hold }` (T4) holds the recorded rounds where they stand, since a round comes 0.5–3.5 s after its commitment and a reopened page takes longer than that to sign in; `GET /v1/e2e/consistency` (T13) answers `consistent(hub)`. `tools/worker-bundle.test.ts` guards them.

**Hubs**: `m14-interrupt` 8840, `m14-mixed` 8841, `m14-smoke` 8842, `m14-guide` 8843, `m14-lifecycle` 8844; `m14-capability` 8845 (T6); the next hub file takes 8846. `npm run soak` uses 8851, outside the E2E range (`load:hub` has 8850).

**Engines in CI** (T6): `E2E_FIREFOX` adds the `firefox` project and `E2E_WEBKIT` a `webkit` project, each only in `e2e-full.yml`'s part of its own. PR CI stays Chromium. In a cloud session, install Firefox or WebKit into a scratch `PLAYWRIGHT_BROWSERS_PATH`, never `/opt/pw-browsers`, or dispatch `e2e-full.yml` on the branch (`gh api -X POST repos/Resner/Biosphere/actions/workflows/e2e-full.yml/dispatches -f ref=<branch>`).

## Tasks

T1, T5, T7, T8, T10 and T12 need nothing and can start at once. T2 and T3 follow T1, and T4 follows T3. T6 follows T5, and T9 follows T7 and T8. T11 follows T1 and T10. T13 follows T3, and T14 follows T12 and T13. T15 follows T12. T16 follows T4, T6, T8 and T12, and T17 follows T11, T14 and T16. T18 closes.

### The permanent world

- [x] T1 Rules 13 and the last renewal: epoch 5, permanent from v1.0 [opus] (after none)
  - Steps:
    1. **Rules 13.** `RULES_VERSION` 13, and the registry holds one entry, `{ rules: 13, epoch: 5 }`, every part since 13; `FIRST_LIVE_RULES` 13. Regenerate every golden that names the rules version, and nothing else changes in them.
    2. **Migration 14, the fifth renewal**, as migration 11 did (ADR 0061): every creature, record, commitment, mating, genesis-log entry, fight row, away report and the world row's clock go; the world's epoch is 5, its reset time the migration's, its seed and clock new; every hatch bucket refilled; identities, keys, names, flags, beacons, attestations and the usage meter kept. One transaction, with the version row.
    3. **Protocol 14.** A protocol-13 hello gets `error: version`.
    4. **The notice** says "The world was renewed in v1.0.0. Your identity is kept; your creatures start again. From now on, lineages are permanent." (`index.html`, `renewal.ts`). `POST /v1/e2e/pre-reset` and `m6c-reset` follow.
    5. **Permanence in words.** The card's details, the CLI and `docs/VERIFY.md` drop "until v1.0 the world may be renewed" and say that lineages are permanent from v1.0.0 (epoch 5), and that a bundle of rules 12 or older answers `rules-retired`.
    6. **The frozen manifest.** `src/ledger/__golden__/frozen.json` lists, for rules 13, the SHA-256 of every golden file under `src/*/__golden__/` (the manifest itself aside). `npm run goldens:manifest` rewrites the live version's entry. `src/ledger/frozen.test.ts`:
       - fails when a golden file is missing from the live entry, or its hash differs;
       - fails when a version in `RELEASED` has an entry whose canonical JSON hashes to anything else;
       - `RELEASED` is `{}` until T18 pins 13.
    7. `.claude/rules/tests.md`: a released version's manifest entry and goldens never change; a rules change after v1.0 is a new version that keeps the older part's code (ADR 0074). DESIGN §5's renewal paragraph and §6's one-live-version line, `.claude/rules/worker.md`'s migration list.
  - Acceptance (tests first):
    - **Migration**: a database at 13 holding creatures, records, commitments, matings, a fight row, away reports, flags, beacons and attestations migrates to 14: the first six are empty, the rest unchanged, the epoch 5, every bucket full, every player's `epoch_seen` below 5.
    - **The notice**: an identity first seen before the migration hears `renewed` once on its first `life`, and not on its second; a new identity never does.
    - **Versions**: `checkGenesis`, `checkBirth`, `checkStored` and `verifyEncounter` answer `rules-retired` for rules 12 and `rules-unknown` for 14; a fresh hatch's genesis records rules 13 and verifies.
    - **Protocol**: a protocol-13 hello is refused `error: version`.
    - **Manifest**: changing one byte of any golden file fails `frozen.test.ts`; adding a golden file without the manifest fails it; `npm run goldens:manifest` makes it pass again; with `RELEASED = { 13: <wrong hash> }` it fails.
    - Every E2E passes on protocol 14, `m6c-reset` reading the new notice.
  - Notes: the renewal is ADR 0074's; it runs in every environment at deploy, so the E2E hubs start in epoch 5 too. Until v1.0.0 is tagged, later M14 tasks may change rules-13 values and goldens without another bump; each reruns `npm run goldens:manifest`.
  - Done: migration 14 (also clears `left_*`, new seed and clock on the kept world row), `frozen.ts` + `tools/goldens-manifest.ts` (`goldens:manifest` formats goldens before hashing). Record hashes carry the rules, so lineage.json's derived genomes and fights moved too.
  - Gotcha: the farm kit's straight-run kill missed under the new genomes; `slay` now homes on its victim (`killB`'s optional plan). Combat and netcode reports pin rules 13.

- [x] T2 Honest pages raise no plausibility flags (after T1)
  - Steps:
    1. **Find the hair.** M13 T11 saw an honest page that feeds flagged `health-over`, `energy-over` or `biomass-over-max` in a few of 12 runs, at a biomass well under the maximum. Reproduce it in Node: the pacing bot (`simulateLife`) through the real `step`, reporting as the page does (`LifeFlow.report`: after 5 s, then every 30 s, the wire's rounding to hundredths, `ticks` counted as the page counts them, including the rebase after a reconnect), fed to the hub's checks as the hub calls them (`applyReport`, `clampCondition` and `creditTicks` in `worker/life.ts`; `vitalsCap` and `reachAt` in `src/ledger/gates.ts`). Find where the page's numbers and the hub's caps differ (rounding, the order of growth and the health it brings, energy's cap at 2·b of a biomass the hub clamped, a report between a growth step and its health).
    2. **Fix it at the cause**, on whichever side is wrong. The bound stays as tight as the verifier needs: a client that claims more than the rules allow is still flagged. If the rulebook (`src/ledger/gates.ts`) changes, it changes under rules 13 (T1) and the goldens and manifest follow.
    3. `m13-load` drops `PLAUSIBILITY` and checks every flag kind but `authority-only`.
  - Acceptance (tests first):
    - **A property test** (`heavyTest`): 2,000 seeded honest lives (genesis bodies and the 11 archetypes, foraging in every zone, eating to the energy cap, growing to their maximum, a reconnect at a random moment in 10% of them), each report checked as the hub checks it, raise no `health-over`, `energy-over`, `biomass-over-max` or growth flag.
    - **Still caught**: a report 1 unit of biomass above the growth reach, energy 1 above 2·b, or health 1 above 10·r is flagged as before (the existing hub tests pass unchanged).
    - `m13-load` passes 3 times in a row (`--repeat-each=3 --workers=1`) with no flag but `authority-only`.
  - Notes: a page whose report is clamped also plays on with less than it had; a fix that removes the flag but keeps the clamp is not done.
  - Done: two hairs, both on the page (`wireCondition`, `src/game/life.ts`): energy and health rounded to the nearest hundredth sat one above the hub's floored cap (full health 173.205 → 17321 against 17320), and after a reconnect the growth of the unreported stretch before the drop has no credited time, so reports follow the hub's reach from the bind until the body is within it (the hub's number lags by a few percent, the page's body is untouched). The hub's bounds are unchanged. `worker/honest-pages.test.ts` runs 240 lives of 100 s (the 120 s heavy budget; `LIVES=2000 LIFE_MS=150000` is the full sweep, 9 minutes) through the real `LifeFlow`; `simulateLife` takes `genome`, `at` and `onTick`.

### Interrupted transactions

- [x] T3 The hub's kill matrix: every step survives a closed socket and a restart [opus] (after T1)
  - Steps:
    1. **The catalogue** (`worker/interrupt-kit.ts`): each transaction and its steps, as the hub sees them, in one table the matrix walks:
       - **genesis**: the ask arrives; the commitment is written and `commit` sent; the round is published and the record written; `genesis` sent;
       - **mating**: `mate-check`; `court` (the invitation in the courting attachment); `accept` (the commitment and both `mate-commit` records in one transaction, `mating` sent to both); the round published (both births written); `born` sent to each;
       - **promote**: the request arrives; the records written; `promoted` sent;
       - **restore**: the same, with `restored`;
       - **death**: the client's `death` (or the hub's old age); the `death` record; `died` with the fallback;
       - **fight**: `engage`; `lock-ask`; the answer; the row inserted and `enc-start` sent; a batch of frames written; the settlement; `enc-end` sent;
       - **close**: the checkpoint on close, and the seat back within 2 minutes.
    2. **The interruptions**, after each step: the player's socket closes (answers the hub sends after that point are lost), and the player signs in again on a new socket (a) 1 s later and (b) 10 minutes later on the hand clock, with every round published and every deadline passed; (c) the object is rebuilt over its storage, as `POST /v1/e2e/restart` does (memory lost: courts, the directory, duties, admission's memory), and the sockets sign in again. For a mating, also the partner's socket.
    3. **The invariants** (`consistent(hub)`), checked after every case:
       - each player has at most one active creature, each creature one head, and at most one pending child per player;
       - every commitment whose round is published is resolved: a genesis's creature exists, a mating's two births exist;
       - each genesis took one hatch from its bucket, and each mating's cost was paid once (each parent's `mate-commit` condition is its condition before × the cost, and no second `mate-commit` names that commitment);
       - no lock or fight without its row and its players, and every settled fight's records match its settlement;
       - no anchor or directory entry for a creature that isn't active;
       - every creature touched verifies (`verifyLineage` over its proof bundle, `src/ledger/verify.ts`).
    4. **Told on sign-in** (ADR 0076): after `life`, the new socket hears everything in flight for its player: a genesis waiting for its round (`commit`), a mating waiting for its round (**new: `life.mating`**, its commitment's id, round and the partner's name at the commitment), the pending child (`life.pending`), the running fight (`life.fight` and the resend), the fallback and the away report.
    5. **Fix every gap** the matrix finds, at its cause, in one SQLite transaction per step.
    6. `.claude/rules/worker.md`: the catalogue, `consistent`, and that a new multi-step transaction joins the catalogue.
  - Acceptance (tests first). `worker/interrupt.test.ts`, a `heavyTest` on the fight kit's hand clock with fake beacons:
    - **The matrix**: every transaction × every step × the three interruptions (and the partner's close for a mating) leaves `consistent(hub)` empty, and the sign-in after it is told what the step left in flight.
    - **Named cases**, each its own test:
      - a genesis whose player closed after `commit` and signs in after its round: one creature, one hatch spent, and its `life` names it active;
      - the same, signing in before its round: `commit` follows `life`, and `genesis` arrives when the round does;
      - a mating whose courting player closed right after `accept` reached the hub: both `mate-commit`s written once, `life.mating` names it on sign-in before the round, and `life.pending` after it;
      - the object rebuilt between a mating's commitment and its round: both births written when the round is published, each player told `born` (connected) or `pending` (at sign-in);
      - a promote whose answer was lost: signing in again shows the child active and the parent frozen once; sending the same signed request again returns the same answer and writes nothing;
      - a death whose `died` was lost: the sign-in's `life` carries the fallback;
      - a court whose courting socket closed: the partner's `accept` is refused (the invitation went with the socket), and nothing is written.
    - **Parsers**: `life.mating` round-trips, and a `life` with `mating` missing `partner`, with a round of −1, or with an extra field parses to null; 10,000 fuzzed values never throw.
    - Every existing hub test and E2E passes.
  - Notes: M8's fight recovery and M12's `transitions.test.ts` already cover parts of this; the matrix reuses their kits rather than repeating them. A step the matrix can't interrupt (inside one SQLite transaction) is listed as such in the catalogue.
  - Done: gaps fixed at the cause: a genesis's hatch and a mating's records now share their commitment's transaction, a death's checkpoint its record, a genesis or mating is marked resolved only with its writes (so a wake keeps it due), and a dead creature leaves the water. Migration 15 keeps the mates' names for `life.mating`.
  - Gotcha: `consistent(hub, players)` scopes to a test's players, since the kits wipe `matings` between tests; the matrix runs on the hand clock (84 cases, about 20 s).

- [x] T4 The page resumes what was in flight [opus] (after T3)
  - Steps:
    1. **The page takes the hub's word** (ADR 0076). `LifeFlow` takes a `commit` or `genesis` for the player's own waiting genesis whatever its state, and `life.mating` and `life.pending` on any `life`. `state().life.inFlight` names them.
    2. **The screens resume**:
       - a waiting genesis: the title shows its egg waiting (no Hatch, no practice offer, whatever the bucket says), and the reveal plays when `genesis` comes, then the creature plays as after any hatch;
       - a genesis whose creature came while the page was gone: the title's main button resumes it, with a toast "Your new creature hatched";
       - a waiting mating: the egg hangs beside the parent with "Awaiting beacon", and `born` reveals it as a mating's egg does;
       - a promote or restore that finished while the page was gone: the creature shown is the hub's (the child, or the ancestor), with no egg reveal;
       - a death the page never saw: the death screen with the cause and the fallback, as `life.fallback` says.
    3. **Durable writes**: the identity store resolves `save` only on the IndexedDB transaction's `complete` (with `durability: 'strict'` where supported), and a recovery import writes its seed in one transaction before the page says it is done.
    4. `docs/TESTING.md` (`inFlight`, the hub), DESIGN §5, `.claude/rules/game.md`.
  - Acceptance (tests first):
    - **Unit tests** (`LifeFlow`, `Screens` with fakes):
      - an idle page that hears `life` (no creature, `genesisIn` > 0) then `commit` for its own commitment goes to `awaiting`, the title shows the egg, and `hatch()` asks nothing new;
      - `genesis` for that commitment verifies and plays;
      - `life.mating` shows the parent's waiting egg; `born` after it reveals it;
      - a `commit` naming another player's commitment is ignored.
    - **`m14-interrupt.spec.ts`** (`@slow`, hub 8840, `MATING_SCALE` 0.01, `LIFESPAN_SCALE` 0.05). Each kill is a renderer crash (`Page.crash` over the DevTools protocol, so nothing unloads), and each reopen is a new page in the same browser context:
      - **Genesis**: A uses its last hatch (`POST /v1/e2e/hatches { player, left: 1 }`, an E2E-entry hook this task adds and `tools/worker-bundle.test.ts` guards, leaves it one) and crashes while `awaiting`; reopened, the title shows the egg (not Hatch, not the practice offer), the reveal plays and the creature's DNA matches `life.recompute()`.
      - **Mating**: A courts B, B accepts, and A crashes on `mating` before `born`; reopened, A's creature has paid the cost (biomass 85% of before, ± 3%) and its egg waits beside it, then `born` reveals the child; B never sees anything wrong.
      - **Promote**: A presses H and crashes at once (before or after `promoted` reaches it: either way); reopened, A plays the child, and Lineage shows the parent as a checkpoint once.
      - **Death**: A starves (`debug.setEnergy(0)`, as `m13-queue` does) and crashes on the death screen; reopened, the death screen offers the pending child or the ancestor; A picks the ancestor and crashes at once; reopened, A plays the ancestor.
      - **Import**: B imports A's recovery code and crashes as the import resolves; reopened, B's identity is A's.
      - **The hub**: `GET /v1/e2e/consistency` (T13) is empty after each part when present, and `GET /v1/e2e/audit` holds no flag but `authority-only`.
      - Screenshots of each reopened screen are attached (`m14-interrupt-<step>`).
  - Notes: fights are M8's (`m8-resume`, `m8-lifecycle`), so this spec doesn't repeat them. `Page.crash` is Chromium's; the spec skips itself in other engines.
  - Done: `LifeFlow` adopts its own `commit`/`genesis` (`genesisInFlight`, `inFlight`), `MateFlow` a `life.mating`, `LifeStarts.awaitGenesis` plays it, `missedDeath` opens on the death screen; the key store resolves on the transaction's `complete` (`durability: 'strict'`). `commitmentId` moved to `src/ledger/commitment.ts` so the shell names a commitment without BLS.
  - Gotcha: the spec holds the rounds (`POST /v1/e2e/beacons`) while a page is dead, and grows up at normal speed: `ripe`'s fast play raises `clock-too-fast`, which the audit check would catch.

### Engines

- [x] T5 Every golden in every engine (after none)
  - Steps:
    1. **The catalogue** (`tests/goldens-catalogue.ts`): each golden file under `src/*/__golden__/` maps to the page-side set that recomputes it, or sits in a Node-only list with its reason (a report's summary, say). The sets cover at least:
       - `math.json` (every function of `src/sim/math.ts` on its vectors);
       - the sim replays (`body-forage`, `forage-route`, `hazard-dash`, `idle-starve`, `mate`, `old-age`);
       - every `encounter-*.json`;
       - `develop`, `express`, `stats`, `genesis`, `genome-hash`, `inherit`, `offspring`, `rarity`, `describe`;
       - `records`, `kinds`, `settlement`, `lineage` and `growth-reach` (canonical JSON, record hashes, signatures checked, the growth table).
    2. **`window.__bs.goldens`** (always present: it only computes): `sets()` and `run(set, input)`, running the same functions the Node tests run, in the page's own bundle.
    3. **`m14-goldens.spec.ts`** (no hub): for each set, the page's outputs equal the golden's, compared in Node. It replaces `m3-determinism` and `m7-determinism`, which it covers.
    4. `docs/TESTING.md`, `.claude/rules/tests.md` (a new golden joins the catalogue).
  - Acceptance (tests first):
    - `tests/goldens-catalogue.test.ts`: every golden file is in the catalogue or the Node-only list, and every Node-only entry has a reason; a new file in a `__golden__` directory fails it.
    - `m14-goldens` passes in Chromium in the PR suite, within one test's 60 s ceiling in CI (split by set if it needs more).
    - A golden changed by one byte fails `m14-goldens` in Chromium (a temporary local change, not committed).
  - Notes: done: 18 sets (the frozen manifest included) in `src/game/goldens.ts`, the catalogue in `tests/goldens-catalogue.ts`; `tests/e2e/m3-determinism` and `m7-determinism` and the `?debug=1` `genome.hashes` hook are gone (the `stats` and `encounter` sets cover them). `tournament.json` is Node-only. The page's lazy chunk loads on first `run`.
  - Notes: T6 runs the same spec in Firefox and WebKit. A set that differs in an engine is a determinism bug in `src/sim/math.ts` or wherever the difference starts, fixed at its cause in T6; it is never left out.

- [x] T6 Firefox and WebKit play the game; mixed engines; the capability screen [opus] (after T5)
  - Steps:
    1. **Projects** (`playwright.config.ts`): `firefox` (`E2E_FIREFOX`) runs `m6c-firefox`, `m6c-flash`, `m14-goldens`, `m14-smoke` and `m14-mixed`; a new `webkit` project (`E2E_WEBKIT`) runs `m14-goldens` and `m14-smoke` (and `m14-mixed` if WebKit can link, below). `m14-smoke` runs in the chromium project too; `m14-mixed` runs only in the engine projects, which install Chromium beside their own engine. Both are `@slow`. `e2e-full.yml` gains a `webkit` part that installs WebKit and Chromium; headed under Xvfb if headless WebKit draws no WebGL2, as Firefox does. Release and `E2E main` run both, through `e2e-full.yml`.
    2. **`m14-smoke.spec.ts`** (`@slow`, hub 8842), the game in the engine under test:
       - a recorded hatch with its egg reveal (charge, crack, result card);
       - swimming to food (`debug.steerTo`), eating and dashing, with the HUD's bars moving;
       - a second page of the same engine joins; they link, each sees the other move;
       - the menu, Settings (the quality preset changes and is kept) and the help panel open (T8);
       - the creature's card opens and says "Verified back to genesis";
       - every frame drawn (non-blank screenshots), no page error, no uncaught rejection; screenshots attached per engine.
    3. **`m14-mixed.spec.ts`** (`@slow`, hub 8841): a Chromium page and a Firefox page (the test launches the second browser type itself) hatch near each other, link over WebRTC (host candidates), see each other move, and duel: both pages end on the referee's hash. If Playwright's WebKit can hold a WebRTC link on Linux, a WebKit page joins the same scenario; if it can't, the ADR below says so and the owner checks Safari's links.
    4. **The capability screen** (`src/game/capability.ts`, `index.html`, `card.html`, `lab.html`): on load the page checks WebGL2, WebSocket, IndexedDB, RTCPeerConnection and module workers.
       - No WebGL2: a plain page (no canvas) says "Biosphere needs WebGL2" and names the browsers that have it (the latest Chrome, Edge, Firefox or Safari), and says to turn hardware acceleration on in the browser's settings if it is off.
       - No WebSocket: the game plays offline as practice cells, with a line saying why.
       - No IndexedDB (a private window in some browsers): the game plays practice cells, saying creatures can't be recorded in this window.
       - No RTCPeerConnection: the game plays recorded creatures alone, saying others can't be seen in this browser.
       - `state().capabilities` and `state().unsupported`.
    5. **The engines ADR** (the next free number): what CI checks in each engine (the goldens, the smoke, mixed links), what Playwright's Linux WebKit can't (WebRTC, WebGL2, audio, whatever this task finds), and the owner checks that cover real Safari and Edge. Edge is Chromium for every check CI can make.
    6. Fix what the engines show, at its cause: a determinism difference in `src/sim/math.ts`, a missing API, a shader that fails to compile. Never skip a check for one engine without the ADR saying why.
    7. `docs/TESTING.md`, `.claude/rules/tests.md` and `ci.md` (the parts), DESIGN §12 if a preset or budget differs by engine.
  - Acceptance (tests first):
    - **Unit tests** of `capabilities` and the screen chosen for each missing capability, over fake windows.
    - **E2E** (Chromium, PR suite): with `RTCPeerConnection` deleted before load (`addInitScript`), the note shows and a recorded creature plays; with `indexedDB` deleted, the practice cell plays with its note; with WebGL2 refused (`HTMLCanvasElement.prototype.getContext` returning null for `webgl2`), the plain page shows and nothing throws.
    - `m14-goldens` and `m14-smoke` pass in Firefox and in WebKit in `e2e-full.yml` (a dispatched run on the branch is the evidence, linked in the PR).
    - `m14-mixed` passes Chromium with Firefox, 3 times in a row in its part.
  - Notes: the WebKit part may need system libraries (`--with-deps`). Keep the Firefox and WebKit parts to these specs: the engine suites gate releases, and every scenario added there is one more that can flake.
  - Done: `capability.ts` (plain page for game and Lab without WebGL2, every page without module workers; the card keeps its flat preview), `m14-capability` (8845, PR suite), `m14-smoke` and `m14-mixed`, a webkit part, ADR 0077. Every golden matched in all three engines with no fix.
  - Gotcha: Linux WebKit offers only mDNS candidates, so it never links (smoke skips its link step; no WebKit in `m14-mixed`); Firefox links only with `obfuscate_host_addresses` off and the page served on 127.0.0.1 (over ::1 it gathers no candidates on a runner).

### Onboarding and accessibility

- [x] T7 The first-life guide [opus] (after none)
  - Steps:
    1. **`src/game/guide.ts`** replaces `hints.ts`. A guide step shows the first time its moment comes in this browser, one line at the bottom centre (where the hints show now), in the HUD's glass style:

       | Step | When | Words | Gone when |
       |---|---|---|---|
       | `swim` | a life's first second | "Move the mouse to swim · WASD works too" | it has swum 3 body lengths |
       | `eat` | `swim` done | "Swim into the glowing specks to eat" | it eats |
       | `dash` | its first eat done, food within 3 body lengths | "Space to dash" | it dashes |
       | `energy` | energy under 30% | "Hungry: eat, or you'll starve" | energy over 50% |
       | `hazard` | a plume within 3 body radii, or a UV or pressure hit | "Toxic cloud: steer clear", "Too bright here: swim deeper" or "Too deep here: swim up" | 2 s out of it |
       | `bigger` | a creature a tier bigger on screen | "Amber rings mean bigger: keep away" | 6 s |
       | `attack` | the "F" glyph first marks a creature | "F to attack a creature your size" | it engages, or 6 s |
       | `fight` | its first fight starts | "1 2 3 change stance · Shift braces · swim away to escape" | the fight ends |
       | `mature` | it is first mature | "Grown up: find another player and press E to court" | it courts, or 8 s |
       | `invite` | its first invitation | "E to accept: you each get a child" | it answers |
       | `egg` | its first pending child | "H becomes your child when you're ready" | it promotes, or 8 s |
       | `menu` | 2 minutes into its first life | "Esc opens the menu: stats, lineage and help" | the menu opens, or 6 s |
       | `wheel` | 30 s after its first link to another player | "G for pings and emotes" | the wheel opens, or 6 s |
       | `death` | its first death | on the death screen: "You come back as your egg or your nearest ancestor", or "Nothing survived: hatch a new cell; your lineage stays in History" | the screen closes |

    2. **Pacing**: one step at a time; a step waits while another shows, and at most one new step starts every 20 s, except `fight`, `invite` and `hazard`, which show at once and push a showing step back into the queue. A step shows for 8 s at most. Each step shows once per browser (`bs.guide`); a browser that has `bs.hints` (the old hints) has seen `swim`, `dash`, `menu` and `wheel`.
    3. **Settings**: "Show hints" (on by default) and "Show the hints again", which forgets `bs.guide`.
    4. **The title**, on a browser that has seen no step: one line under Hatch, "New here? How to play", which opens the help panel (T8; a no-op until it lands).
    5. Reduced motion: the line fades with no slide. Nothing covers the egg, the minimap or the bars; the HUD stays within 6%.
    6. Hooks `state().guide` and `debug.guideReset()`; DESIGN §10's hints paragraph; `docs/TESTING.md`; `.claude/rules/game.md`.
  - Acceptance (tests first):
    - **Unit tests** (pure, the time and events given): each step's trigger and end; one at a time; the 20 s spacing; `fight`, `invite` and `hazard` first; a step seen never shows again; `bs.hints` maps to the four steps; "Show hints" off shows none; a blocked store shows each step once per visit.
    - **`m14-guide.spec.ts`** (hub 8843, `MATING_SCALE` 0.01), a fresh browser:
      - the title shows "New here? How to play";
      - `swim`, then `eat` once it swam, then `dash` after its first eat, each gone when done (`debug.steerTo` drives it);
      - `hazard` near a plume (`debug.spawnPlume`), `energy` at low energy (`debug.setEnergy`);
      - with B hatched beside it: `bigger` when B is grown a tier (`debug.setBiomass` on B), `wheel` after the link;
      - `mature`, then `invite` on B when A courts, then `egg` on both after the round;
      - a reload shows none of the seen steps again; "Show the hints again" brings `swim` back on the next life;
      - screenshots of three steps at 960 × 540 and 390 × 844 attached (`m14-guide-*`).
    - `m6b-hud` and the 6% HUD budget pass unchanged.
  - Notes: words may be tightened, never lengthened past one line at 390 px. The guide never blocks input or pauses the sim.
  - Done: `guide.ts` (a `RULES` row per step, the loop's clock), `PlayUi.guideFacts`, Settings' two controls, `title-help` (hides the title's keys line, so the queue card's title stays whole); fight, mature and death words tightened to fit 390 px. `debug.sated` keeps a test's belly full so no meal ends a step early.
  - Gotcha: `m6b-hud`'s first-life hints test described the replaced hints; it now checks the guide's `swim` once per browser. Under 56rem the line sits above the bars (under the minimap while the offspring card shows).

- [x] T8 How to play: the help panel and every control [opus] (after none)
  - Steps:
    1. **`src/game/controls.ts`**: the one table of controls (`CONTROLS`, DESIGN §3), each action with its mouse and its keys and when it works.
    2. **The help panel** (`src/game/help-panel.ts`, `index.html`): a glass panel with sections in this order:
       - **How to play**: four lines on the loop (swim and eat, grow, find a mate, your lineage carries on);
       - **Survive**: food by zone, energy and starvation, plumes, UV and pressure, the four bars;
       - **Grow and mate**: maturity, courting and accepting, the cost and the cooldown, the egg, becoming your child, death and the fallback;
       - **Fight**: comparable sizes, F, stances, brace, targets, escaping, what a kill gives, an egg in a fight;
       - **Your lineage**: the Lineage panel, cards and what "Verified" means (one line, linking `docs/VERIFY.md` on GitHub);
       - **Controls**: the full table from `CONTROLS`;
       - **Privacy**: what this browser keeps and what the authority keeps, from what is true now (T16 reviews it).
    3. **Opening it**: "How to play" on the title (beside Hatch's row), "Help" in the menu (replacing the Controls section, whose table moves into the panel), and `?` (the key's value, so any layout) anywhere but in chat. Esc or the close button closes it. In play it is a side panel and steering carries on under it, as the menu's does; on the title and death screens it is a centred panel. Keyboard: focus moves into it and back, sections are headings, it reads in a screen reader in order.
    4. 960 × 540 and 390 × 844 both work: the panel scrolls inside itself, and the title stays whole.
    5. Hooks `state().help`; `docs/TESTING.md`; DESIGN §3 (`?`) and §10 (the menu's sections); `.claude/rules/game.md`.
  - Acceptance (tests first):
    - **The key map** (unit): every key `CONTROLS` names is handled by the game's key handling (`app-keys.ts`, `input.ts`, the wheel and combat keys), and every key the game handles is in `CONTROLS` (a test walks the handlers' key list).
    - **Unit tests** of the panel: opening, sections, Esc, focus in and back, `?` ignored while chat is open.
    - **`m14-help.spec.ts`** (no hub, a practice cell):
      - `?` opens it on the title and in play; in play the creature keeps swimming under it (`debug.steerTo` toward food reaches it);
      - the menu's Help opens it at Controls;
      - every section is present and the controls table holds every row of `CONTROLS`;
      - screenshots at 960 × 540 and 390 × 844, on the title and in play, attached (`m14-help-*`); no horizontal scroll at 390.
    - `m6b-hud` passes with the menu's Help in place of Controls.
  - Notes: plain words, short lines, no genetics jargon in How to play; the panel never names a number DESIGN.md doesn't hold.
  - Done: `controls.ts` (`CONTROLS`, with `after` for T then 1–6), `help-text.ts`, `help-panel.ts` (`Help` pure over a `HelpView`); each key handler exports its key list (`APP_KEYS`, `MOVE_KEYS`, `FIGHT_KEYS`, `WHEEL_KEYS`, `EMOTE_KEYS`) for the key-map test. "How to play" sits beside Hatch, hidden while T7's `title-help` shows.
  - Gotcha: the code reads `KeyboardEvent.key`, not `.code` as Out of scope says, so WASD follows the layout's letters; in play focus returns nowhere on close, so Space stays the dash.

- [ ] T9 Colour never alone [opus] (after T7, T8)
  - Steps:
    1. **The inventory** (`src/game/cue-channels.ts`): every cue that carries meaning on screen (the four bars, low energy, damage hits, the size outlines, the "F" glyph, the target ring, windups, blocks, the mate heart and "ready", pings, emotes, the egg's tier colours and the result card's stars, rarity on cards, depth zones on the gauge and the minimap, minimap players, the hazard icons, the witness mark, away fighters, the queue card, the status chip, the guide), each with its colours (the code constants it draws with) and its other channels: shape, pattern, icon, text, motion, position or sound.
    2. **Second channels where only colour carries it.** At least: a small glyph at the left of each bar (a heart for health, a bolt for energy, outward arrows for size, an hourglass for life), drawn in SVG like the HUD's icons, within the HUD's 6%; and any cue the inventory finds with colour alone.
    3. **Pairs that must stay apart** (`CONFUSABLE` in the same file): the bars' fills, low against normal energy, health against damage, each pair of ping kinds, each pair of rarity tiers, each pair of depth zones on the gauge. Each pair's colours keep a CIEDE2000 distance of at least 12 under protanopia, deuteranopia and tritanopia (Machado, Oliveira and Fernandes 2009, severity 1), or the pair differs in a non-colour channel and the test says so.
    4. DESIGN §10 (the bars' glyphs, the rule), `.claude/rules/game.md`.
  - Acceptance (tests first):
    - **Unit tests**: every cue in the inventory has a visual channel that isn't colour; every `CONFUSABLE` pair passes under the three simulations or names its other channel; the simulation leaves greys unchanged under all three deficiencies (within 0.5 of 255) and applies the paper's severity-1 matrices in linear light (sRGB decoded, then encoded), checked against three colours worked by hand in the test.
    - **`m14-colour.spec.ts`** (no hub, `?genome=` cells and `debug.setRemotes`): the HUD with low energy and a damage hit, a bigger and a smaller remote with their outlines, the minimap with each ping kind, a rare result card. Each screenshot is simulated under the three deficiencies in Node and attached beside the original (`m14-colour-*`); the bar glyphs are present; the HUD stays within 6% of the screen.
  - Notes: no colour-blind palette setting: every cue carries a second channel, which serves everyone. A colour may move only within DESIGN's look (the organ and glass colours are not cues and stay).

### Balance

- [x] T10 The balance simulation and its gate (after none)
  - Steps:
    1. **The population** (`tests/balance.ts`): the 11 archetypes of `tests/archetypes.ts`, each with 15 seeded variants (one to three mutation trials of the archetype's genome through the real mutation, keeping only variants that still hold the archetype's defining feature: a predicate per archetype, `ARCHETYPE_KEEPS` in `tests/archetypes.ts`), so 176 bodies; and 32 genesis bodies as a reference, reported but outside the gate.
    2. **A life** (`balanceLife(body, seed)`), on the real rules:
       - it hatches as a hatchling, chooses the zone its body forages best in (a 2-minute probe per zone with the pacing bot), and forages there with the pacing bot's policy (`simulateLife`'s), through the real `step`;
       - fights come as a Poisson process at 3 an hour (the capacity model's assumption), each against a population member of a tier it can fight, at a biomass ratio drawn from 0.67 to 1.5, through the real encounter (`duel` in `tests/combat-tournament.ts`, both on autopilot, behaviour as the combat tournament gives the hand-built bodies). A kill applies the reward; a death ends the life; an escape or a draw goes on from the fight's end condition;
       - it matures by the rulebook (time and size), and mates at every eligibility while it has the energy (the cost and the cooldown applied, a partner always found);
       - old age ends it at its lifespan.

       Its score is the matings of the life. A body's score is the mean over 16 lives.
    3. **The report** (`npm run sim:balance`, `tools/balance.mjs`, `tools/balance-report.ts` → `docs/perf/balance.md` and `balance.json`): each body's score, zone and cause of death; each archetype's median and best; the top 10% (18 bodies) by archetype; the genesis reference; and the gates:
       1. the top 10% holds bodies of at least 3 archetypes;
       2. no archetype holds more than half of the top 10%.

       Reported but not gated: each archetype's best against the top score, deaths by cause, and the chosen zones.
    4. **The balance ADR** (the next free number): the score, the population, and how the gates read.
  - Acceptance (tests first):
    - **Life mechanics** (unit, Node): the same seed gives the same life; a body that can't eat its zone's food starves before maturity and scores 0; a kill grows the killer by `RULES.encounter`'s reward; a life with N minutes past maturity and its energy kept mates at most ⌊N ÷ 9⌋ + 1 times, paying the cost each time; old age ends a life at its lifespan.
    - **A scaled run** (`heavyTest`: each archetype itself, 1 life each, lives capped at 9 minutes) finishes within 120 s and gives the same report for the same seed. (A full-length life takes about 4 s and the full population 3,000 lives, so 3 variants × 4 lives could not fit; the scaled run keeps the real probe, fights and report. 9 minutes is past maturity at 7, so a life still mates once, and keeps the run near 45 s here, under half the budget on a slower runner.)
    - `npm run sim:balance` runs the full population and prints its wall time (target: under an hour on a cloud session; if it can't, fewer lives a body, and the balance ADR says so), and the report and its JSON are committed, whether or not the gates pass today. `tools/balance-report.test.ts` builds the report from a recorded JSON.
  - Notes: this task measures; T11 tunes. The gates are asserted on the committed report from T11 on.
  - Done: `tests/balance.ts`, `tools/balance-report.ts`, `npm run sim:balance` (ADR 0078); the committed run (53.5 min on 4 cores) meets both gates, with 42 bodies tied at the 5-mating ceiling. Gotcha: `pgrep -f` in a wait loop matches its own shell; wait on the PID.

- [ ] T11 Balance tuning in rules 13 (after T1, T10)
  - Steps:
    1. **Read the report.** If both gates pass, nothing moves: record the measurement and tick the task.
    2. **Otherwise tune values**, in this order of preference, each step remeasured:
       - combat (`RULES.encounter`: strike power, the armour factor, spines' return, rams, stances);
       - the costs of parts (the basal multiplier's coefficients, DESIGN §6);
       - feeding (efficiencies by mouth and food, digestion);
       - growth and metabolism.

       Never the karyotype, development or genesis (no body changes shape).
    3. **Every other gate holds**: the combat report (no archetype above 70% overall, a body 1.5 × as heavy wins at least 70% of mirror duels and 2 × 85%, genesis duels a median of 8–25 s, a winner growing at least 1.5 × a forager), the pacing targets (DESIGN §5), the tier pace (`--tiers`), the speed band, the farm gates (`report:farm`), and the archetype stats tests (no build best at everything).
    4. Regenerate every golden the values move (under rules 13: no bump before v1.0.0), `npm run goldens:manifest`, and the reports: `report:combat`, `sim:pacing`, `report:speed`, `report:farm`, `sim:balance`.
    5. The scaled balance `heavyTest` now asserts both gates too; a test checks the committed `balance.json` passes them.
    6. DESIGN §6 and §7: every value that moved.
  - Acceptance:
    - The committed `docs/perf/balance.md` passes both gates, and so does the scaled `heavyTest`.
    - Every report above is regenerated and passes its own gates; `npm run check:full` passes.
  - Notes: if the gates can't hold together with the combat and pacing gates, the brief's order decides (a fun, readable core loop first, then diverse adaptations): the balance ADR records the trade-off, and the task ends with the best compromise and the reason.

### Room for 200

- [ ] T12 Room for a crowd: the headroom cap [opus] (after none)
  - Steps:
    1. **The caps** (ADR 0075): `worker/capacity.ts`'s `derive()` gives the free plan 80% of one object's capacity (621 at the measured 777); the paid plan keeps its money cap (590).
    2. **`headroomSeats(hub, now)`** (`worker/admission.ts`): the smallest, over request-equivalents, rows written and rows read, of ⌊(the plan's daily allowance − today's use) ÷ (that item's per-player-hour cost from `ratesOf(MEASURED, ASSUMPTIONS)` × `HEADROOM_H`)⌋. `admission` answers `full` when the seats held (seated and away fighters) reach the smaller of the session cap and the headroom. The budget, storage and TURN guards, the seat back and `MAX_SESSIONS` are unchanged.
    3. **The wait** while the headroom binds counts the seats that must free first: (holders + 1 − headroom), then one interval per place ahead.
    4. **`/v1/metrics`**: `admission.headroom`.
    5. **`docs/CAPACITY.md`** (regenerated): the summary's free-plan line gives the 621 cap and the headroom; a new section, "Crowds from a fresh day", gives for 50, 200 and 621 concurrent players on each plan the hours before the headroom stops newcomers and before the budget guard does.
    6. DESIGN §8, `.claude/rules/worker.md`, ADR 0071's numbers stay as history.
  - Acceptance (tests first). Hub tests with a mocked `Date.now`, on the free plan unless said:
    - **The arithmetic** (unit, on the committed `MEASURED`): a fresh day's headroom is above 621, so the cap binds; with rows written at 60% of the allowance, the headroom is ⌊40,000 ÷ (rows written per player-hour × 2)⌋.
    - **Seating**: with today's rows written pushed (`rowCount`) so the headroom is 20 as the sessions sign in, 20 seated sessions hold and the 21st waits with `why: 'full'`; one seated session leaving doesn't seat it while the headroom still binds; once enough have left, it is seated.
    - **Seats kept**: no seated session is dropped when the headroom falls below the seats held; a reload within 2 minutes is seated past it.
    - **The wait**: with the headroom 3 below the seats held and departures every 20 s, the first in line hears the next seat's wait plus 3 more intervals: 4 × 20 s less the time since the last seat freed (± 1).
    - **Plans**: the paid plan seats 590 on a fresh day; `MAX_SESSIONS` still overrides the cap (the headroom still applies).
    - **Metrics**: `admission.headroom` matches `headroomSeats`.
    - `docs/CAPACITY.md` regenerates byte for byte (the existing test), and its new section's numbers come from the model.
    - Every existing admission test and `m13-*` E2E passes (their `MAX_SESSIONS` caps sit far under the headroom).
  - Notes: the headroom counts to 100% of an allowance, not to the 90% guard: the guard's 10% is what the crowd already seated plays on.

- [ ] T13 Life clients: headless players that hatch, mate, fight, die and drop (after T3)
  - Steps:
    1. **`tests/life-client.ts`**, on M13's `LoadClient` (the page's own `HubClient`, a seeded identity, fixture rounds). A life client plays whole lives over the real protocol:
       - hatches a recorded genesis, asks `spawn`, wanders with the page's `WhereReporter`;
       - reports honest progress from its own creature in the real sim (`step` on a local world, the pacing bot's policy), as `LifeFlow` reports;
       - courts a mature client near it and accepts courts, signing its asks; waits for the births; promotes its child half the time;
       - fights: each client signs its own snapshots every 200 ms onto an in-process bus that stands in for the peer links, so an `engage` carries both snapshots and a `lock-ask` is answered with the attacker's frames seen; fighters send no inputs (the autopilot flies them) or a scripted input every frame for one in four;
       - dies (in a fight, starving or of old age under the scales), restores its nearest ancestor or hatches again;
       - **drops**: closes its socket abruptly at a random moment (about once per 10 minutes of play: during a court, a beacon wait, a fight or plain swimming) and signs in again after 1 to 90 s, resuming from what the hub names (T3's in-flight list).
    2. **`GET /v1/e2e/consistency`** (E2E entry only): `consistent(hub)` from T3, run inside the object.
    3. **`npm run soak`** (`tools/soak.mjs`, `tools/soak-run.ts`) in its quick mode first: `--clients 20 --minutes 5` starts `node tools/worker.mjs dev --e2e --port 8851 --persist-to <temporary>` with the witness fixture vars and `MATING_SCALE` 0.05, runs the clients, and checks at the end: every client seated, no socket closed for its rate, no `where` dropped, no audit flag but `authority-only`, `consistent` empty, and every creature's proof bundle verified by the verifier (the CLI's library) for a sample of 20 and all of the last generation.
  - Acceptance:
    - Unit tests of the client's script against a fake transport: a court is accepted and births awaited; a drop during a beacon wait resumes the egg on sign-in; a fight is engaged with both signed snapshots.
    - The quick mode passes 3 times in a row on a cloud session, and its counts show matings, fights, kills, restores and drops in every run (each above zero).
    - `tools/worker-bundle.test.ts` guards `/v1/e2e/consistency`.
  - Notes: the clients never point at a production authority (`.claude/rules/tests.md`): the tool refuses any hub URL but localhost.

- [ ] T14 The one-hour soak: 200 players, two pages, a workflow and a report (after T12, T13)
  - Steps:
    1. **The full soak** (`npm run soak`): 200 life clients join over the first 5 minutes and play for 60, on the free plan's own limits (`PLAN` free, no `MAX_SESSIONS`, no budget override: the headroom seats them), with the witness fixture vars and `MATING_SCALE` 0.05. Two Chromium pages (the Playwright library, low preset) play throughout among them: hatch, `debug.steerTo` to food, court each other when mature, and each reloads once at minute 30.
    2. **Samples every minute**: the workerd process's CPU time and resident memory (`/proc`), `/v1/e2e/metrics`, `/v1/e2e/audit` and `/v1/e2e/consistency`; each page's JS heap after a forced GC (as `m6-budget` does), `renderer.info`'s geometries, textures and programs, and its frame time p95 over the minute.
    3. **The checks**:
       - every client seated at once (no line);
       - no socket closed for its rate, no `where` dropped, no audit flag but `authority-only`, `consistent` empty at every sample;
       - the authority's memory: the slope of resident memory over minutes 10–60 under 20 MB an hour; CPU per incoming message in minutes 50–60 within 1.5 times that of minutes 10–20;
       - per player, from the meter: messages per player-minute and rows written per player-hour within 1.5 times `MEASURED`'s;
       - each page: heap at minute 55 within 20% of minute 10, `renderer.info` level, frame time p95 at minute 55 within 20% of minute 5;
       - at the end, every creature's bundle verifies for a sample of 50 and all of the pages' creatures.
    4. **The report**: `docs/perf/soak.md` and `soak.json` (the minute series, the checks, the counts of matings, fights, kills, restores and drops).
    5. **`.github/workflows/soak.yml`**: on dispatch and weekly (Sunday 03:00 UTC), a 90-minute job that runs `npm run soak`, uploads the report as an artifact and fails when a check fails. Release does not run it. Add to `.claude/skills/milestone/SKILL.md`'s step 1 that from v1.0 the latest `Soak` run on `main`'s head must be green too (dispatched and waited for if none).
    6. `docs/TESTING.md`, `.claude/rules/tests.md` and `ci.md`.
  - Acceptance:
    - A full run passes on a cloud session or in a dispatched `soak.yml` run (linked in the PR), and its report and JSON are committed.
    - A unit test builds the report and its checks from a recorded run's JSON, and fails a recorded run with a rising memory slope.
    - The run fails when a client's drop is broken on purpose (a temporary local change that never signs in again after a drop during a beacon wait, not committed): `consistent` or a missing creature says so.
  - Notes: an hour of two software-GL pages is slow but fine; the frame-time check compares the page with itself, never with a target frame rate.

### Operations, security and the brief

- [ ] T15 `docs/OPERATIONS.md` and `npm run ops:watch` (after T12)
  - Steps:
    1. **`npm run ops:watch -- --url <authority>`** (`tools/ops-watch.mjs`, pure parts in `tools/ops-watch.ts`): polls `/v1/metrics` every 60 s (its edge cache) and `/v1/audit` every 5 minutes, prints one status line per poll (seated, waiting and why, the headroom, today's use against each allowance in %, the hours left at the current rate, relay share, flags today by kind) and a warning line when an action from the runbook applies; saves every answer under `ops/<UTC date>/` (git-ignored) so `npm run report:capacity -- --metrics <file>` can take one. `--once` prints one line and exits.
    2. **`docs/OPERATIONS.md`**, the owner's runbook, in plain steps:
       - **What runs where**: Pages, the Worker and its one object, drand, Cloudflare TURN; the limits and costs, pointing to `docs/CAPACITY.md`;
       - **Releases**: how a `VERSION` change ships; re-running Release to redeploy; never rolling the Worker back across a migration (migrations only go forward), so a bad release is fixed forward with a patch release;
       - **Plans**: staying free, switching to paid and back (`CLOUDFLARE_PLAN`, from `docs/SETUP.md`), and what each changes in admission;
       - **Watching**: `ops:watch`, the fields of `/v1/metrics` and `/v1/audit` that matter, and the thresholds that call for action;
       - **Incidents**, each with what players see and what to do: a long line, the day's budget spent, the free plan's hard limit reached (ADR 0075), storage near its guard, the TURN guard, a drand outage, a spike in flags (what each kind means), the authority unreachable, offensive names or chat (the filter lists and a PR), a bad release;
       - **Secrets**: rotating the Cloudflare token and the TURN key (GitHub secrets, then re-run Release);
       - **Data**: what the authority keeps and for how long (pointing to `docs/PRIVACY.md`, T16), what a lost object would cost, and that there is no restore path in v1.0;
       - **The 200-player playtest**: a checklist for the week before (plan, a fresh UTC day, `ops:watch` running, the Playtest issue's link), the hour itself (what to watch, when the line would form, what to tell players), and after (save the metrics, `report:capacity --metrics`, paste the summary into the Playtest issue).
    3. `docs/SETUP.md` links the runbook; CLAUDE.md's "Where things live" lists it.
  - Acceptance (tests first):
    - **Unit tests** of `ops-watch.ts` over recorded `/v1/metrics` and `/v1/audit` answers (from an E2E hub): the status line, the hours left at a given rate, each warning's threshold, and a malformed answer printed as an error line, never a crash.
    - `npm run ops:watch -- --once --url http://localhost:<hub>` against a local `wrangler dev` prints a status line (a test in the node project starts the hub, as the load tools do, or the PR shows the run).
    - **The runbook's references** (`tools/ops-doc.test.ts`): every npm script, workflow, variable, secret and endpoint `docs/OPERATIONS.md` names exists in `package.json`, `.github/workflows/`, `worker/` or `docs/SETUP.md`.

- [ ] T16 The security and privacy review [opus] (after T4, T6, T8, T12)
  - Steps:
    1. **`docs/SECURITY.md`**: the threat model (what is protected: identities' keys, lineage integrity, the authority's signing key, the budget; who attacks: modified clients, bot farms, griefing peers, a hostile page script, the supply chain) and every surface with the checks that cover it, by test name:
       - the hub's messages (parsers, rate limits per type, origins, sizes), the peer events and snapshots, the witness messages;
       - the public endpoints (`/v1/proof`, `/v1/fight`, `/v1/metrics`, `/v1/audit`, `/v1/pubkeys`, `/v1/health`), their caches and the 503 past 80%;
       - the pages' inputs: `?hub=` (localhost only), `?genome=`, the card's `?c=`, the Lab's paste box, the recovery import, names and chat (rendered as text, never HTML);
       - the E2E entry never deployed, secrets only in the deploy steps, nothing secret in the repository or the built site;
       - what deterministic replay doesn't prove (`docs/VERIFY.md`, ADRs 0059 and 0012), stated as residual risk.
    2. **The checks it adds**, each a test:
       - no `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write` with anything but a static template (a source test with an allowlist);
       - a Content-Security-Policy `<meta>` on `index.html`, `lab.html` and `card.html` (scripts and workers from `'self'` and `blob:` as the build needs, connections to `'self'`, the authority's origin and localhost hubs, no `unsafe-eval`), with `state().csp` counting violations, and the shared page helpers in `tests/e2e/helpers.ts` failing a test whose page saw one;
       - every parser of untrusted input has a 10,000-value fuzz test that never throws (list them; add what is missing);
       - every public endpoint answers a foreign origin as `docs/SECURITY.md` says (refused, or public by design) and refuses an over-long path.
    3. **`npm audit --omit=dev`** once: its result in `docs/SECURITY.md`; a high or critical advisory in a shipped dependency is fixed in this task.
    4. **`docs/PRIVACY.md`**: what the browser keeps (the identity's seed in IndexedDB, settings and the guide in local storage, no cookies, no analytics), what the authority keeps and for how long (the public key, the display name, creatures and records for good, fight logs 14 days, the usage meter; the IP only salted and hashed in memory for witness independence), what Cloudflare and drand see, what a card shows (no name, the key's start), and what a player can do (export the recovery code, play under a new name, forget the browser's identity). The help panel's Privacy section (T8) follows it in short.
    5. **Findings**: fix what a task can fix in this one; a larger finding becomes a new task in this spec, before T17, with its acceptance tests.
  - Acceptance:
    - The source test, the CSP violation check and the endpoint tests pass; every E2E spec passes under the CSP in Chromium, and `m14-smoke` in Firefox and WebKit.
    - Every parser in the list has its fuzz test.
    - `docs/SECURITY.md` names a test or a document for every surface, and `docs/PRIVACY.md` matches what the code stores (a reviewer's table of each `localStorage` and IndexedDB key and each SQLite table, checked by a test against the source's keys and `worker/schema.ts`'s tables).

- [ ] T17 The brief, line by line, with evidence (after T11, T14, T16)
  - Steps:
    1. **`docs/COVERAGE.md`**: one row per requirement of `docs/BRIEF.md` (the rows of the roadmap's Brief coverage table, split where a row holds more than one checkable claim), each with:
       - its status: met, met but an owner check remains, or after 1.0 (only what the brief itself puts there: mobile);
       - its evidence: a test (`path::title`), a report (`docs/perf/…`), an ADR, or the owner check on the Playtest issue.
    2. **The roadmap's Brief coverage** links to it, and gains M14 where M14 delivered.
    3. **Gaps**: a requirement with no evidence gets its test in this task when it is small; otherwise a new task in this spec, before T18.
  - Acceptance (tests first): `tools/coverage.test.ts` fails when:
    - a row of the roadmap's Brief coverage table has no row in `docs/COVERAGE.md`;
    - an evidence path doesn't exist, or a `path::title` names a test title not found in that file;
    - a row is "met" with no evidence, or "after 1.0" for anything but what the brief puts after 1.0.

### Closing

- [ ] T18 The v1.0 scenario, the playtest kit and the documentation sync
  - Steps:
    1. **`m14-lifecycle.spec.ts`** (`@slow`, hub 8844, `MATING_SCALE` 0.01, Chromium), the v1.0 story in one scenario:
       - a fresh browser A: the title offers "How to play"; the help opens on `?` and closes;
       - A hatches; its renderer crashes during the beacon wait; reopened, the egg waits and its reveal plays, and the creature is the committed one;
       - the guide's `swim`, `eat` and `dash` show and go as A swims to food and dashes;
       - B hatches beside A; both mature; A courts, B sees `invite` and accepts;
       - A's renderer crashes on `mating`; reopened, the egg waits beside A, `born` reveals it, and A becomes its child (H);
       - B engages A's child; the fight ends on the referee's hash on both pages;
       - A's child's card says "Verified back to genesis" and nothing about renewals;
       - `/v1/e2e/consistency` is empty, `/v1/e2e/audit` holds no flag but `authority-only`, and `/v1/e2e/metrics` counts the day's waits, reads and messages.
    2. **The pin**: `RELEASED[13]` in `src/ledger/registry.ts` holds the hash of the rules-13 manifest entry, once nothing else in M14 changes a golden.
    3. **Sync**:
       - DESIGN.md: drop the M14 marks for what shipped, and the "initial values for rules version" line says 13;
       - `docs/TESTING.md`: the hooks and hubs 8840–8844 (the next file takes 8845);
       - `.claude/rules/*.md`, `docs/SETUP.md`, CLAUDE.md (the new docs);
       - `README.md`: v1.0, how to play in three lines, the four browsers, and links to the runbook and coverage;
       - `docs/ROADMAP.md`'s Brief coverage as T17 left it.
    4. **The Playtest issue and the release notes** (the milestone close posts them; this task drafts them at the end of this spec, under a heading "Release notes and the Playtest issue (draft)"):
       - the release notes: the permanent world (the last renewal), the guide and help, the four browsers, room for a crowd, nothing lost to a closed tab, the balance;
       - `Playtest: v1.0.0`: the Pages link, the renewal, the 200-player plan from `docs/OPERATIONS.md` (when, how to invite, `ops:watch`, what to paste back), what to try in each browser, the `(owner)` rubric lines below, and the still-open owner checks of Playtests v0.10.0 (#379) and v0.11.0 (#418) and of M12 and M13's rubrics.
  - Acceptance:
    - `m14-lifecycle` passes 3 times in a row on one hub (`--repeat-each=3 --workers=1`).
    - Every exit criterion maps to a named test or report (the table below), and `tools/coverage.test.ts` passes.
    - Each PR E2E part stays under 5 minutes; the long scenarios are `@slow`.

## Exit criteria → evidence

| Exit criterion (ROADMAP) | Tasks | Evidence |
|---|---|---|
| About 200 concurrent real players | T12, T13, T14, T15, T18 | the headroom cap's hub tests and `docs/CAPACITY.md`'s crowds (T12); the one-hour soak with 200 players, two pages and drops (`docs/perf/soak.md`, `soak.yml`); the runbook's playtest checklist and `ops:watch`; the `(owner)` playtest on `Playtest: v1.0.0` |
| Interrupted-transaction recovery | T3, T4, T13, T14, T18 | the hub's kill matrix (`worker/interrupt.test.ts`); `m14-interrupt`; the soak's drops with `consistent` empty; `m14-lifecycle`'s crashes |
| Chrome, Edge, Firefox and Safari | T5, T6, T16 | `m14-goldens` in Chromium, Firefox and WebKit; `m14-smoke` in Firefox and WebKit; `m14-mixed` (Chromium with Firefox); the capability screen's tests; the engines ADR; the `(owner)` checks in real Safari and Edge |
| Balance | T10, T11 | `npm run sim:balance` (`docs/perf/balance.md`: at least 3 archetypes in the top 10%, none above half) and its scaled `heavyTest`; the combat, pacing, speed and farm reports still passing; the balance ADR |
| Onboarding | T7, T8, T9 | `m14-guide`, `m14-help`, `m14-colour` and their screenshots; the key-map test; the cue inventory's tests |
| Brief coverage complete | T17, T18 | `docs/COVERAGE.md` and `tools/coverage.test.ts` |
| Outline: interrupted-transaction journal (T3, T4, ADR 0076); Firefox and WebKit in the release E2E with cross-engine goldens (T5, T6); onboarding hints, help, controls, colour-blind-safe cues (T7, T8, T9); balance pass (T10, T11); `docs/OPERATIONS.md` (T15); security and privacy review (T16); a one-hour soak (T13, T14); preparation for the 200-player playtest (T12, T15, T18); a brief coverage audit with evidence (T17); release notes (T18); permanent lineages (ADR 0074, T1, T18) | T1–T18 | as listed in each task |

## End-to-end check

`m14-lifecycle.spec.ts` (T18, `@slow`, hub 8844) plays v1.0 from a fresh browser: the help and the guide, a hatch whose tab crashes and comes back to its egg, a mating whose tab crashes and comes back to the egg beside its parent, a promotion, a fight on the referee's hash, a card verified back to genesis, and an authority that is consistent with no flag but `authority-only`.

Each part is also checked alone:
- `m14-interrupt` (T4): every step of hatch, mating, promotion, death and import, crashed and reopened;
- `m14-goldens` and `m14-smoke` in Firefox and WebKit, `m14-mixed` across engines (T5, T6);
- `m14-guide`, `m14-help` and `m14-colour` (T7, T8, T9);
- the hub's kill matrix (T3) and the soak (T13, T14);
- the balance simulation (T10, T11) and the capacity model's crowds (T12).

## Rubric

- [ ] A first-time player who never opens the menu learns to swim, eat, dash, avoid hazards and bigger creatures, attack, court and become its child from the guide alone, one line at a time (evidence: `m14-guide`'s screenshots and `state().guide` at each step).
- [ ] The help panel answers "how do I…" for every core action and lists every control, readable at 960 and 390 px wide, without stopping the creature (evidence: `m14-help`'s screenshots, the key-map test).
- [ ] No cue relies on colour alone, and the HUD, outlines, pings and rarity stay distinguishable under protanopia, deuteranopia and tritanopia (evidence: `m14-colour`'s simulated screenshots, the inventory's tests).
- [ ] A reopened tab shows where its player stands on its first screen: the waiting egg, the egg beside the parent, the child, the ancestor or the death screen, never a second Hatch (evidence: `m14-interrupt`'s screenshots).
- [ ] Firefox and WebKit draw the game as Chromium does (evidence: `m14-smoke`'s screenshots per engine, non-blank, within the low preset's budgets).
- [ ] An hour of play leaves the authority and the pages level: memory, CPU per message, heap, GPU resources and frame times (evidence: `docs/perf/soak.md`).
- [ ] Different builds succeed: at least 3 archetypes in the top 10% of lives, none above half (evidence: `docs/perf/balance.md`).
- [ ] (owner) About 200 players play for an hour from the Pages link: nobody waits in line, nobody loses a creature to a reload or a closed tab, and `ops:watch` shows per-player costs and a relay share within a factor of two of `docs/CAPACITY.md`'s assumptions (paste its summary, or run `npm run report:capacity -- --metrics <file>`).
- [ ] (owner) The game plays in real Safari (the latest two versions, on a Mac) and in Edge (on Windows): hatch, swim, meet a friend on Chrome, mate and fight.
- [ ] (owner) A newcomer who has never seen the game knows what to do within five minutes, from the guide and the help.
- [ ] (owner) Different builds win in play: no one body dominates the water.
- [ ] (owner) 60 fps on a mid-range laptop at the default preset in each of the four browsers.

## Risks

- **Playwright's WebKit on Linux may lack WebRTC or WebGL2.** T6 checks what it has, runs what it can, and the engines ADR records the rest as owner checks on real Safari. Firefox already runs headed under Xvfb; WebKit may need the same.
- **A golden may differ between engines.** That is a determinism bug, fixed at its cause (`src/sim/math.ts` is the usual place), never a set left out. If it lands after T1's manifest, the manifest and the goldens move together under rules 13, before v1.0.0.
- **The balance gate may fight the combat and pacing gates.** T11 tunes the levers in order and keeps every other gate; if they can't all hold, the brief's priorities decide and the balance ADR records the trade-off.
- **The renewal costs players their creatures once more.** It is announced in the notice, the release notes and the Playtest issue, and it is the last (ADR 0074).
- **The headroom cap lets a crowd spend the free day sooner.** The line names the reopening hour as before; the runbook says when to switch plans.
- **The soak takes an hour and may flake.** It is outside the PR gate and Release, and every check compares the run with itself or with `MEASURED`, never with wall-clock pace; a red `Soak` holds back the v1.0 close (T14's line in the milestone skill) until a health run fixes it.
- **More engines, more flakes.** The Firefox and WebKit parts run only the M14 engine specs and M6c's two; every scenario waits on state, never on wall time (`.claude/rules/tests.md`).
- **Merge conflicts between parallel tasks.**
  - `index.html` and `src/style.css`: T7, T8, T6 and T9 each add a block; keep each block apart.
  - `playwright.config.ts`: T4, T5, T6, T7, T8, T9 and T18 add projects or hubs with the ports fixed above.
  - `worker/admission.ts` is T12's; T16 reviews it after.
  - Goldens: T1 regenerates them for rules 13, T11 for its values, T2 if the rulebook moves; each reruns `npm run goldens:manifest`.
  - `protocol-defs.ts`: T1 bumps to 14, T3 adds `life.mating` under 14.
- **Large tasks** (T3, T6, T10, T13, T14) may overrun one session. Every run pushes its work in progress (ADR 0042), and a task that fails across three runs is split (the `next` skill).
