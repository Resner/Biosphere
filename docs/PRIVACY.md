# Privacy

What Biosphere keeps about a player, where, and for how long: in the player's own browser, on the authority (the one Cloudflare Worker and its database), and what the services it runs on see. There are no accounts, no email, no cookies, no analytics and no third-party scripts. The help panel's Privacy section (`src/game/help-text.ts`) says the same in short; the security review is `docs/SECURITY.md`.

`tools/privacy.test.ts` checks both tables below against the code: every key the pages read or write and every table of `worker/schema.ts` has its row, and no row names one that is gone.

## What this browser keeps

Everything here stays on the player's device, under the game's web address, until the player clears the site's data.

| Key | Where | What | How long |
|---|---|---|---|
| `biosphere-identity/keys/seed` | IndexedDB | The identity: a 32-byte Ed25519 seed. Whoever holds it is this player. It leaves the browser only as the recovery code the player chooses to show. | Until the site's data is cleared or a recovery code replaces it |
| `bs.name` | Local storage | The display name the player picked (or the `Cell` name made for them) | Until changed |
| `bs.settings` | Local storage | Settings: quality, volume and mute, reduced motion, whether to help referee, whether to show hints | Until changed |
| `bs.bench` | Local storage | The graphics benchmark's result for each graphics card name seen | Until the site's data is cleared |
| `bs.guide` | Local storage | The first-life guide's steps already shown | Until "Show the hints again" |
| `bs.hints` | Local storage | The hints seen before v1.0, read once by the guide | Removed with "Show the hints again" |
| `bs.muted` | Local storage | The players this browser muted, by their public key | Until unmuted |
| `bs-recovery-seen` | Local storage | Whether the recovery code reminder was shown | Until the site's data is cleared |

The game sets no cookies and uses no session storage. The Lab keeps nothing; the creature card reads the settings only.

## What the authority keeps

The authority's database, one table per row below. A player is known only by their public key (`playerId`): there is no account behind it.

| Table | What it holds about players | How long |
|---|---|---|
| `players` | Each identity's public key, when it was first and last seen, its hatches left and a genesis waiting, the last world renewal it was told of, a witness strike, an away fight's report (it names the other fighter by display name), and where its creature last left the water | For good; the away report until told, the place until the next one |
| `creatures` | Each creature's owner (a public key), genome, state and the head of its chain | For good |
| `records` | Every creature's signed records: its genesis, checkpoints, matings, births, fights, death | For good (lineages are permanent) |
| `genesis_log` | Which request made which creature, and when | For good |
| `matings` | Each mating's parents, round and children; both players' display names while it waits for its round | For good; the names are cleared when the children are written |
| `commitments` | The authority's signed commitments to a drand round (genesis, mating, witness draws) | For good; a witness draw's 14 days |
| `beacons` | The drand rounds used | For good |
| `attestations` | Witness auditors' signed verdicts, by the witness's public key | For good |
| `encounters` | Each fight's log, its fighters (with their display names at its start) and its signed settlement | The log and the names 14 days; the settlement for good |
| `flags` | The audit's flags: a kind, the owner's key, the creature, the request | For good |
| `usage` | Each UTC day's totals: messages, reads, rows, seat time, relay use. No player is named | For good |
| `keys` | The authority's own signing keys | For good |
| `world` | The world's epoch, seed and clock, and the salt for address hashes | For good |
| `ponds` | The world's one row | For good |
| `migrations` | The database's schema version | For good |

What the authority holds **only in memory**, for as long as a player is connected: the display name (signed into the seat ticket that linked players see), where the creature swims (the directory), invitations, and a hash of the player's IP address with the secret salt, used only so that nobody witnesses a fight or a birth of a player on the same address (witness independence). The address itself is never stored, and the hash never reaches the database. Chat goes from player to player and never reaches the authority.

Public by design: every record, commitment, beacon, attestation and settlement can be read by anyone through `GET /v1/proof` and `GET /v1/fight`, so that anyone can check a lineage (`docs/VERIFY.md`). A fight's log is served for its 14 days. `GET /v1/audit` and `GET /v1/metrics` give counts only.

## What the services see

- **GitHub Pages** serves the game's files and sees each visitor's address and browser, as any website host does.
- **Cloudflare** runs the authority and the TURN relays, and sees each player's address on every connection. A relayed link's traffic passes through TURN encrypted end to end.
- **STUN servers** (Cloudflare's and Google's) see a player's address when a link starts, so that players can find a direct route to each other.
- **drand** is asked for public randomness by the authority alone; no browser contacts it, and no player data goes to it.
- **Other players** linked to this one see its network address (as in any peer-to-peer game), its display name, its creature, and its chat lines.

## What a card shows

A creature card (`card.html?c=<creature>`) shows the creature, its story, its family and its checked history. It shows no player's display name: the owner appears only as the first 8 characters of their public key, in the card's details.

## What a player can do

- **Export the recovery code** (the title screen's Recovery code): it moves the identity to another browser. Anyone who holds it is this player, so keep it private.
- **Play under a new name**: the name field on the title screen. Records never carry a name.
- **Forget the identity**: clear this site's data in the browser. Without a recovery code saved first, the identity and its lineage can't be played again; what the authority keeps stays, under a public key nobody holds.
- **Mute a player**: their chat and emotes stop reaching this browser.
