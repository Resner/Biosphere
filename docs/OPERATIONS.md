# Operations: the owner's runbook

How to run Biosphere once players use it: what runs where, how to release, what to watch, and what to do when something looks wrong. Plain steps; nothing here needs the factory. The numbers behind the limits are in `docs/CAPACITY.md`; the one-time account setup is in `docs/SETUP.md`.

A reference test (`tools/ops-doc.test.ts`) checks that every command, workflow, variable, secret and endpoint this page names exists.

## What runs where

| Part | What it does | Where it lives |
|---|---|---|
| Pages | The game's static files (the page, the lab, the creature cards) | GitHub Pages, deployed by the Release workflow |
| The Worker and its object | The one authority: sign-in, the line, signaling, the ledger, the clock, commitments, the referee, admission | One Cloudflare Worker with one SQLite Durable Object (`biosphere-authority`) |
| drand | The public randomness every genesis, mating and witness draw waits for | The quicknet network, read over HTTPS from four public hosts (`src/ledger/drand.ts`); the Worker never makes its own randomness |
| TURN | Relays a peer link that cannot connect directly | Cloudflare Realtime TURN, credentials minted by the Worker and cached for a day |

Players connect to each other directly; the authority only holds what must be agreed (who owns which creature, the records, the fights' referee, the clock). A player whose connection to the authority fails keeps swimming in a practice cell, and nothing already recorded is lost.

The limits and costs are in `docs/CAPACITY.md`: on the free plan the day's allowances are 100,000 request-equivalents, 100,000 rows written and 5,000,000 rows read, shared by everyone, and the object holds at most 621 sessions. Everything resets at 00:00 UTC.

## Releases

- **A release is a `VERSION` change on `main`.** The Release workflow (`release.yml`) runs the full tests, builds the site, deploys the Worker, checks that `/v1/health` reports the new version, publishes Pages and only then tags the release. The factory is the only thing that changes `VERSION`.
- **Redeploying**: Actions → **Release** → **Run workflow** on `main` redeploys `main` as it is (it creates a release only when the tag is missing). Use it after changing a secret or a variable (`CLOUDFLARE_PLAN`).
- **A bad release is fixed forward.** The Worker's database migrations only go forward, so never roll the Worker back to an older version: it would not understand the schema. Open an issue or an owner request describing the problem; the next patch release carries the fix. See "A bad release" for what to do meanwhile.
- **Preflight**: Release stops at once if a Cloudflare secret or `AUTHORITY_URL` is missing, naming the one.

## Plans

- **Free** (the default): $0, the allowances above, a session cap of 621, and a headroom rule: a newcomer is seated only while everyone seated could play two more hours within what is left of the day. On a fresh day 200 players can play for about five hours before that rule closes the door, and about seven before the budget guard does (`docs/CAPACITY.md`, "Crowds from a fresh day"). The free plan stops at its daily limits instead of billing: it cannot cost money.
- **Paid** ($5 a month and usage): far larger daily allowances (9 times the requests), a session cap of 590 and a ceiling of $9.50 a month by its own allowances.
- **Switching**: set the GitHub variable `CLOUDFLARE_PLAN` to `paid` (after upgrading the account), then re-run **Release**. To go back, delete the variable or set it to `free` first, redeploy, then downgrade the account. `docs/SETUP.md` has the clicks. `/v1/metrics` shows the plan in force.
- **What each changes in admission**: the plan's limits and caps (the `limits` of `/v1/metrics`), the headroom (paid rarely binds) and what happens at the free plan's hard limit (below). Nothing else.

## Watching

Run, from a checkout, with any Node 22 or 24:

```
npm run ops:watch -- --url https://biosphere-authority.<your-subdomain>.workers.dev
```

It polls `/v1/metrics` every 60 seconds (its edge cache) and `/v1/audit` every 5 minutes, prints one line per poll and a `WARN` line when an action below applies, and saves every answer under `ops/<UTC date>/` (git-ignored). `--once` prints one line and exits; it exits 1 when an answer could not be read, with an `ERROR` line saying why.

```
16:42:10Z | free | seated 187/621 (cap 621, headroom 763) | queued 0 | away 0 | open | use req 12% rows-w 3% rows-r 1% | left >99 h | relay 4% | storage 0% | flags none
```

| Field | Meaning | Look when |
|---|---|---|
| `seated n/m` | sessions holding a seat, against the smaller of the cap and the headroom | n gets within 10% of m: the line is about to form |
| `queued`, `wait p50 / p95` | players waiting, and how long today's waits were | a median over 5 minutes |
| `away` | seats held by players whose fight runs while their tab is closed | rarely matters |
| `open` / `closed (why)` | `full` (seats), `budget` (an allowance at 90%), `storage` (the database at 90%) | closed |
| `use req / rows-w / rows-r` | the day's request-equivalents, rows written and rows read, as a share of the plan's allowance | 75% (warns), 90% (admission closes) |
| `left` | hours until the 90% guard at the current rate (the rate between two polls) | under 3 hours |
| `relay` | the month's TURN traffic as a share of the allowance; `(STUN only)` once the guard holds | 75% |
| `storage` | the database's size as a share of the plan's limit | 75% |
| `flags` | flags raised today by kind (`/v1/audit`) | any kind that is not routine (below) |

The raw answers hold more: `/v1/metrics` has the month, the 31 days before today and the per-player costs (`today.perPlayerMinute`, `perPlayerHour`), and `/v1/audit` the flags since the world began as well as today's. Neither names a player.

| Threshold | Warning section |
|---|---|
| admission closed, or a line while open, or a median wait of 300 s or more, or fewer than 10% of the seats left | A long line |
| an allowance at 75%, or the guard under 3 hours away | The day's budget is spent |
| an allowance past 90% | The free plan's hard limit is reached |
| the database at 75% | Storage is near its guard |
| relay at 75%, or STUN only | The TURN guard |
| a flag of a serious kind, or 10 of a routine kind | A spike in flags |

## Incidents

Each: what players see, then what to do.

### A long line

Players see "the world is full" with their place in line and a wait. The line is the system working: nobody seated is dropped, and each seat that frees admits the next player, with about 30 seconds a place when seats free slowly. `ops:watch` shows `closed (full)`.

- If the cause is the headroom (`seated` equals the `headroom` in the line, below the cap), the day's allowances are being spent faster than they refill. On the free plan, switch to paid (see "Plans"); it takes one variable and a redeploy and the line drains as the new allowances arrive.
- If the cause is the cap (`seated` equals `cap`), the object is full: its CPU is the bound (the model puts one object at 777 players, and the cap keeps 20% spare). Nothing to do; tell players to wait or to swim a practice cell meanwhile.
- A player who closes the page and returns within two minutes gets their seat back past the line.

### The day's budget is spent

Players see "the world is full" with the reason `budget`, and the hour it reopens (00:00 UTC). Seated players keep playing. `ops:watch` shows `closed (budget)`.

- Nothing breaks, and nothing costs money on the free plan. The seated crowd keeps spending the last 10% of the allowance, which lasts hours at a typical crowd.
- To reopen sooner, switch to paid.
- If it happens on a quiet day, look at `/v1/metrics` for the per-player costs against `docs/CAPACITY.md`: a cost far above the model means a bug, not a crowd. Open an issue with the saved answers.

### The free plan's hard limit is reached

Players see the page load and then fail to connect, or lose their connection mid-play: Cloudflare refuses the object's requests until 00:00 UTC (ADR 0075). Creatures keep what was last recorded; a closed socket writes a checkpoint when it can. `ops:watch` prints `ERROR` lines, or shows use past 100%.

- It follows a crowd that stayed far past its two hours late in the day. It does not corrupt anything: the ledger commits each step in one transaction (ADR 0076).
- Wait for 00:00 UTC, or switch to paid and redeploy: the paid allowances are far larger.
- Tell players that play is paused, not lost.

### Storage is near its guard

Players see "the world is full" with the reason `storage` at 90% of the plan's database limit. The store lasts about three months at a full free day (`docs/CAPACITY.md`, "How long the store lasts"), and fight logs older than 14 days are blanked as new ones settle. The records themselves are kept for good.

- Check `storage.bytes` in `/v1/metrics` against its limit over several days. A steady climb that would hit the guard inside a month means the plan's database (1 GB free, 10 GB paid) is the next limit: switch to paid.
- There is no restore path and no delete: do not try to trim the database by hand.

### The TURN guard

Players see nothing new, but players behind strict networks may fail to link. New welcomes carry STUN only once the month's relay traffic (with today's, and yesterday's once more) reaches 90% of the TURN allowance. `ops:watch` shows `relay` rising and `(STUN only)`.

- The allowance is 1,000 GB a month; most links are direct. A rising share on a small crowd is worth a look at the `relay` fields of `/v1/metrics` (`today.relay`, `month.relayKb`).
- It resets with the month. There is nothing to buy here.

### A drand outage

Players see "Awaiting beacon…" on a hatch or a mating that has to wait for its round. Seated players keep swimming. The authority retries until a round arrives and never substitutes its own randomness (`src/ledger/drand.ts` tries four hosts).

- Check https://api.drand.sh/health and the other hosts. An outage of an hour or two only delays hatches and matings; nothing is lost and the commitments hold.
- If it lasts past a day, say so in the Playtest issue; there is nothing to change on your side.

### A spike in flags

Players see nothing: a flag is a note in the audit, never a penalty by itself. `ops:watch` prints the kinds. What each means:

- **Routine** (a few a day are honest play): `authority-only` (an event no witness could see, usual on a small or new world), `replay` and `conflict` (a double click, a reload racing a save).
- `teleport`, `clock-too-fast`, `growth-too-fast`, `biomass-over-max`, `energy-over`, `health-over`, `claim-over`: a page reported something its body or the clock cannot do. One or two is a buggy or modified client; many at once is a bug in the game. Raised once per creature.
- `wrong-owner`, `stray-death`: requests for a creature that is not the sender's or is already gone.
- `settle-failed`, `recover-failed`: a fight's settlement or recovery threw. This is a bug; the fighters were returned to the ledger's last state. Open an issue with the date.
- `witness-silent`, `witness-forged`, `witness-equivocated`, `audit-overruled`, `attest-forged`: a witness or auditor failed its duty or lied. The witness is struck for a day and the authority takes over; a few are network trouble, a stream is an attack or a bug.

Flags also travel in each creature's proof bundle, so a creature card shows its own. Never act on a flag by editing data: there is nothing to edit.

### The authority is unreachable

Players see their status read offline and play practice cells; the title says why. `ops:watch` prints `ERROR` lines for each poll.

1. Open the `/v1/health` address: it answers `{ ok, version, protocol }`.
2. If it does not, check https://www.cloudflarestatus.com. A Cloudflare outage waits itself out.
3. If Cloudflare is fine, re-run **Release** (a redeploy of `main`).
4. If the version it reports is not the released one, read the Release run's log: its jobs run in order (tests, build, Worker deploy, smoke check, Pages), so the step that failed says how far it got.

### Offensive names or chat

Names and chat go through a filter in English and German (`src/net/text.ts`, the lists in `src/net/text-words.ts`). A name that fails the filter is refused at the title; chat text is masked.

- To add a term, open an owner issue naming it (or a PR changing the list, with a test that the term is caught and no innocent word is); the next release ships it.
- There is no moderation console and no way to rename a player: a name is chosen by its owner.

### A bad release

Players see something broken that the tests did not catch. Do not roll the Worker back (see "Releases").

1. Open an owner issue saying what players see and since which version.
2. There is no switch that closes the door or pauses the world. If the damage is to the Worker (a flood of flags, an error on every hatch), ask players in the Playtest issue to stop playing until the patch ships; nothing already recorded is undone.
3. The factory ships a patch release as soon as it reads the issue; it replaces the Worker and Pages together.

## Secrets

Four secrets and two variables, all under GitHub → Settings → Secrets and variables → Actions (never in the repository, a log or a message). `docs/SETUP.md` step 8 says where each comes from.

- **Rotating the Cloudflare token** (`CLOUDFLARE_API_TOKEN`): create a new token from the same template, replace the secret, re-run **Release**. Then delete the old token in Cloudflare.
- **Rotating the TURN key** (`CF_TURN_KEY_ID` and `CF_TURN_KEY_API_TOKEN`): create a new key under Realtime → TURN, replace both secrets, re-run **Release** (it sets the Worker's secrets again), then delete the old key. Links already open keep working until their credentials expire (a day).
- `CLOUDFLARE_ACCOUNT_ID` and `AUTHORITY_URL` change only if you move accounts or subdomains; the page is built for the authority's address, so re-run **Release** after changing it.
- The authority's own signing key lives in its database and is never rotated by hand.

## Data

- **What the authority keeps**: identities (a public key), the signed records of every creature, commitments and beacons, fight settlements, flags and attestations, and a usage meter per day. Records, commitments, beacons, settlements and flags are kept for good (lineages are permanent). A fight's log is kept 14 days; after that only its signed settlement remains.
- What players are told about this data, table by table, is the privacy notice: `docs/PRIVACY.md`. A change to what the authority or the page stores changes it in the same PR (`tools/privacy.test.ts` checks it).
- **What a lost object would cost**: everything. There is no restore path in v1.0: no backup, no export. Cloudflare keeps the object's storage durable; do not delete the Worker or its object in the dashboard, and do not deploy a Worker with another object class name or migration tag.
- A creature's lineage can still be shown from a saved proof bundle (`npm run verify:lineage`), which is checked without the authority.

## The 200-player playtest

### The week before

- [ ] Decide the plan. The free plan serves 200 players for about five hours of a fresh day; the paid plan removes the worry. Switch before the day (see "Plans").
- [ ] Pick a start hour with as much of the UTC day left as possible (the headroom counts the allowances left today), and tell players the time in UTC.
- [ ] Re-run **Release** on `main` on the day before so that the Worker and Pages are the latest build, and open the page once to see `"version"` in `/v1/health` match.
- [ ] Check the Playtest issue for the version: the link, what to check, and when.
- [ ] Run `npm run ops:watch -- --once --url <authority>`: it prints a line, with `open` and a headroom well above 200.

### The hour

- [ ] Start `npm run ops:watch -- --url <authority>` ten minutes ahead and leave it running; keep its output.
- [ ] Watch `seated` against the cap. A line forms at 621 seats, or earlier if the headroom has dropped (late in the day); at 200 players the cap does not bind.
- [ ] Watch `use` and `left`: 200 players for an hour should use about a tenth of the free day's request allowance. If the `left` figure falls below three hours, the rate is higher than the model: note it, and switch plans only if the line forms.
- [ ] Watch `flags`: a few routine kinds are normal. Note any serious kind with its time.
- [ ] If a line forms, tell players in the Playtest issue what it means: the door is open as seats free, nobody seated is dropped, and swimming a practice cell is allowed while waiting.
- [ ] If the authority is unreachable, follow "The authority is unreachable" and tell players play is paused.

### After

- [ ] Stop `ops:watch`. The answers are in `ops/<UTC date>/`.
- [ ] Take the busiest hour's metrics into the model: `npm run report:capacity -- --metrics ops/<date>/metrics-<time>.json`. It rewrites `docs/CAPACITY.md` from the committed measurements plus that answer's per-player costs; read the summary, then restore the file with `git checkout docs/CAPACITY.md` unless the owner decides to commit the new numbers (the factory regenerates it from the measurements in the repository).
- [ ] Paste into the Playtest issue: the peak `seated`, the longest line and its waits, the share of the day's allowances spent, the flags by kind and anything players reported. That is the evidence for the "about 200 players for an hour" criterion.
- [ ] Switch back to the free plan if it was only for the day (see "Plans").
