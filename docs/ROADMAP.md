# Roadmap

The ordered milestones from M0 to v1.0.0 ("finished"). `/scaffold` wrote them, and `/next` works through them one at a time, top to bottom. There are no time estimates: a milestone is done when its exit criteria hold. Only the current milestone gets a detailed spec. The spec step builds it from the milestone's outline below, `docs/DESIGN.md` and the ADRs.

| ID | Milestone | Exit criteria (observable) | Gate | Status | Spec | Release |
|----|-----------|----------------------------|------|--------|------|---------|
| M0 | Toolchain and pipeline | npm script contract implemented; CI green on a PR; v0.1.0 live on Pages with the build label and a WebGL-rendered cell | — | done | — | v0.1.0 |
| M1 | Swim and feed | solo on Pages: hatch, steer, dash, eat, grow (zoom out), starve or hit a toxin and die with the cause shown, hatch again; fixed-tick sim with golden replays equal in Node and Chromium; base macro look | — | done | [M1](specs/M1-swim-and-feed.md) | v0.2.0 |
| M2 | Shared pond | friends on the Pages link share a pond (≤24), spawn near each other, see each other move smoothly, compete for the same food; Worker signaling plus TURN; keypair identity; filtered chat, emotes, pings | gate | done | [M2](specs/M2-shared-pond.md) | v0.3.0 |
| M3 | Procedural morphology | DNA → bounded development → body, stats and mesh; zero invalid bodies over 10k random and mutated genomes; anatomy changes movement, collision and feeding; Creature Lab page; unique genesis DNA | — | done | [M3](specs/M3-procedural-morphology.md) | v0.4.0 |
| M4 | Authority and lineage core | identities and genesis creatures registered (drand-seeded); one accepted head per creature; single session; lifespan on the authority clock (paused offline); durable resume; recovery code; extinct lineages kept as history | — | done | [M4](specs/M4-authority-and-lineage-core.md) | v0.5.0 |
| M5 | Mating and offspring | consent, eligibility, cost and cooldown; future-round commitment, no rerolls; two distinct offspring by Mendelian rules; one pending offspring; promotion → checkpoint; death → nearest surviving ancestor; old age walks the chain | gate | done | [M5](specs/M5-mating-and-offspring.md) | v0.6.0 |
| M6 | Look, sound and performance | creature look overhaul to the owner's references (#90); art pass to the reference (DOF, caustics, membranes, bioluminescence by depth); depth zones with gameplay; low, medium and high presets with budgets; procedural sound; deliberate pings and emotes (#89); (owner) creatures hold up next to the references; (owner) 60 fps at the default preset | gate | done | [M6](specs/M6-look-sound-performance.md) | v0.7.0 |
| M6b | Look and HUD polish | creatures return to the pass-1 glassy realism without the milky haze, white clipping or artificial glow, with long bodies that read as worms, shrimps and copepods; a minimal gameplay HUD (one profile/settings icon, progress-bar stats, a modern minimap, no red hazard borders); a reactive gacha-style egg reveal; the wheel no longer stops movement; creature speed reviewed; calmer shallows; one pass, no pass series; (owner) the look and the HUD hold up | gate | done | [M6b](specs/M6b-look-and-hud-polish.md) | v0.7.1 |
| M6c | Living creatures and play polish | creatures read as organic plankton (at most 14 visible parts, antennae, legs and tail by region, an Evolved Lab mode); pass-1 glass with limbs of the same glass, a real mouth, organs in at most two related colours and eyes in the organ colour; Firefox draws bodies without aliasing or flashes; damage lands as interval hits; sunlight strongest in the shallows; a still, interactive egg reveal; a smooth minimap with a clear depth gauge; a pre-1.0 world reset retires every frozen version (ADR 0040); (owner) the creatures look like real micro-organisms | gate | specced | [M6c](specs/M6c-living-creatures-and-play-polish.md) | v0.7.2 |
| M7 | Encounters | refereed deterministic combat for comparable sizes: instant lock-in, steering, stance, target, brace, deadlines and autopilot, anatomy-driven outcomes; identical results on all clients; killing is a faster way to grow than plankton and size is a real advantage; a pending egg can be eaten by a predator (owner, Playtest v0.6.0) | gate | planned | — | v0.8.0 |
| M8 | Disconnect-safe settlement | closing a tab never cancels or escapes a fight; reconnect resumes; the authority settles when everyone leaves; backdated inputs rejected; settlement records verifiable | — | planned | — | v0.9.0 |
| M9 | Verifiable lineage and showcase | independent verifier for the ancestry graph that rejects tampering; proof bundles served while peers are offline; lineage viewer; shareable verified creature cards | — | planned | — | v0.10.0 |
| M10 | Witnesses, audits and anti-farming | drand-selected witnesses with no rerolls; witness referees with authority fallback; authority-only settlements flagged; signed inputs; bot-farm simulation shows no shortcut | — | planned | — | v0.11.0 |
| M11 | Area of interest and size tiers | one continuous world; quadtree directory plus tiers decide connections; the cap holds, including boundary neighbours, witnesses and handoffs; no hidden threats (property test); seamless handoffs | — | planned | — | v0.12.0 |
| M12 | Habitats, regrouping and spawning | sparse consolidation; spawn ring outside attack range with anti-camping; crowded instances; transitions keep one state and can't escape combat | — | planned | — | v0.13.0 |
| M13 | Scale proof and admission | load simulation to 10k concurrent players; measured authority, storage and relay costs; `docs/CAPACITY.md`; admission queue within the free tier or the €10 ceiling | — | planned | — | v0.14.0 |
| M14 | v1.0 release | about 200 concurrent real players; interrupted-transaction recovery; Chrome, Edge, Firefox and Safari; balance; onboarding; brief coverage complete | gate | planned | — | v1.0.0 |

Status: `planned` → `specced` → `done`. Gate: `gate` means the factory waits for the owner's reply on the release's `Playtest:` issue before it starts the next milestone.

Owner action ahead: M2 deploys the Cloudflare Worker, which needs the account and secrets in `docs/SETUP.md` step 8.

## Milestone outlines

Starting points for each spec; the spec step decides the final tasks. Mechanics and numbers are in `docs/DESIGN.md`, and lasting decisions are in `docs/decisions/`.

### M1 Swim and feed

Fully specced in [specs/M1-swim-and-feed.md](specs/M1-swim-and-feed.md). It proves the deterministic sim (own math, PRNG, golden replays), the feel of steering and feeding, and the base look.

### M2 Shared pond (gate 1: first playable survival loop)

Friends share a pond and play together from the Pages link with no setup. It proves real-world WebRTC: dependable signaling, TURN, smooth remote motion.

- M1 carry-overs: the list in the M1 spec, "Carried over from the close review".
- Worker skeleton (`worker/`, wrangler, the Workers Vitest pool, `/v1/health`, origin allowlist).
- Browser identity (`src/ledger/identity.ts`: Ed25519 seed in IndexedDB; `playerId`).
- Wire protocol and codecs (`src/net/protocol.ts`, binary snapshots, validated JSON events, fuzz-safe).
- Hub Durable Object:
  - challenge-signed hello, single session (old socket closed 4001);
  - ponds of 24 (fullest non-full first), each with a spawn centre and ring spawn hints;
  - roster and member events, signal relay, time pings, a per-session rate limit.
- TURN credentials minted by the Worker (Cloudflare API, cached, STUN-only fallback).
- Hub client with reconnect backoff and clock offset from the minimum-RTT sample.
- `PeerMesh`: perfect negotiation, non-trickle ICE, `state` and `event` channels, cap and priority eviction.
- Pond sync: 10 Hz snapshots, a 120 ms interpolation buffer, fading silent peers.
- Shared food claims: the lower tick wins, then the lower id; consumed-set sync for joiners.
- Social: chat with a profanity filter (English and German, leetspeak), names, 6 emotes, 4 pings, mute.
- Resilience: status indicator, play continues when the hub is down, "alone in the pond" hint.
- Production deploy in the release workflow (`wrangler deploy`, Worker secrets, `AUTHORITY_URL`, health smoke check). A `Blocked:` issue if the secrets are missing.
- E2E with three browser contexts and a local `wrangler dev` (no public STUN, TURN or relays).

### M3 Procedural morphology

Genuinely different, always-viable bodies from DNA (ADR 0006). It proves the morphology risk: diversity, viability and render cost.

- Karyotype v1 and a total genome codec (any bytes decode; SHA-256 genome hash).
- Genesis distribution: single cells, distinct looks, rare alleles at their design frequencies.
- Expression with dominance tables, polygenic sums, homozygous-only load.
- Development with caps and repair, under property tests over at least 10k random and 10k mutated genomes.
- Stats with tradeoffs: archetypes each best and worst at something; whip versus paddle efficiency crossing with size.
- Mutation, meiosis and inheritance as pure functions: Mendelian ratio tests (1:2:1, 3:1, 9:3:3:1), linkage, distinct slots, goldens.
- Creature mesh builder (merged geometry, LODs, vertex-shader gait) and materials from genes.
- Creature Lab (`lab.html`): a grid, an inspect panel in plain words, mutate, breed two → 8 offspring.
- Game integration: physics, collision circles and mouth-arc or filter feeding from stats; genome shared with peers so remotes render the same body. Growth stops at the max-size gene (not the M1 placeholder 400), and the growth pace is retuned: players found 0.005·b/s too slow (owner, Playtest v0.2.0).
- The body reads as alive: tail and body are one attached mesh with a vertex-shader gait that works for any generated design, not a separate sprite (owner, Playtest v0.2.0).
- Rarity score and tiers, deterministic species names, and a diversity report tool.

### M4 Authority and lineage core

Durable, honest progress (ADRs 0008–0010). It proves that the authority model works within free-tier budgets.

- Canonical JSON (RFC 8785, integers only), records, hashing with domain tags, owner signatures plus authority countersignatures (a DO-generated key, `/v1/pubkeys`).
- drand quicknet client: BLS verification, randomness, host fallback. Real beacons recorded once into `tests/fixtures/drand/`; a fixture mode for the Worker.
- SQLite ledger: players, creatures, records, heads, commitments, beacons, keys, usage, flags.
  - The UTXO transition rule: idempotent, with conflicts and replays rejected and logged.
- Genesis committed to a future round: no reroll, rate-limited, DNA recomputable on the client.
- Active-time clock, lifespan and old-age death; offline time never counts.
- Periodic checkpoints with plausibility limits (clamped and flagged), and resume on reload.
- Recovery code export and import (Crockford base32 with checksum); importing replaces the old session.
- Death with no surviving ancestor → new genesis, with the extinct lineage kept as history.
- Usage meter and basic admission queue.

### M5 Mating and offspring (gate 2: breeding and morphology)

The breeding loop with real players. It proves heredity is fun and readable.

- M4 carry-overs: the accepted close-review findings in the M4 spec's close notes (hatch refund when `accept` refuses, `old-age` cause on a client death that exhausts the lifespan, a stray `refused` aborting a genesis wait).

- Record kinds `mate-commit`, `birth`, `promote` and `restore`, with a transition matrix by status.
- Eligibility and costs on the authority clock: maturity, cooldown, resources, tier ±1, no pending offspring, same-partner doubling.
- Courtship UX: E to court, a 15 s accept window, both sign within 20 s, then "awaiting beacon".
- Commitment and resolution:
  - commit to `latest + 2` with no cancel path;
  - two offspring from the seed slots (`SHA-256('bs/offspring/v1' ‖ randomness ‖ commit id ‖ slot)`);
  - offspring recomputable from the fixtures.
- Offspring reveal (egg and hatch), one pending offspring, promotion (the parent becomes a frozen checkpoint).
- Death fallback: choose the pending offspring or the nearest surviving ancestor. The chain walk skips dead and exhausted ancestors, and restore is always a new transition.
- Mate-choice readability: an inspect card, Punnett hints that match exact enumeration, rarity badges.
- Inbreeding load and kinship; a lineage view (the player's chain plus the family graph).
- Pacing simulation, with values recorded in DESIGN.md.

### M6 Look, sound and performance (gate: the look)

Beautiful and smooth within browser budgets (ADR 0004). The owner judges the creature look before the factory moves on.

- Presets low, medium and high with budgets, auto-detect and adaptive resolution.
- Post chain (DOF with CoC, bloom, grade, vignette, grain, chromatic aberration).
- Depth zones from deterministic bathymetry: light, fog and food by zone; UV and pressure hazards tied to tolerance genes.
- Caustics, god rays, marine snow v2. Membrane, chitin and iridescence materials. Bioluminescence and dark-zone vision.
- Procedural Web Audio: depth ambience and effects for every event; volume, mute and reduced-motion settings.
- Readability pass (rim and contrast, threat outline by tier), including crispness: the cell and UI looked blurry in browsers (owner, Playtest v0.2.0).
- Creature look overhaul (owner, #90, Playtest v0.4.0). This is the milestone's centrepiece and an owner requirement, not a matter of taste. It needs its own group of tasks, not one task or a shader tweak:
  - The bar: `docs/art/reference-02.jpg` to `reference-05.jpg` (from #90; `docs/art/README.md` says what to take from each) and the issue's written brief. Translucent, glass-like micro-organisms in a strict top-down view; visible internal organs, gut and fluid chambers; fine setae, antennae and articulated appendages; a pale silvery-blue palette with subtle amber, violet, cyan and pink pigment; rare iridescent glints (rare, never glitter); macro lighting with luminous edges and restrained bloom.
  - Body-plan diversity: distinct silhouettes (shrimp- and copepod-like, curled worm, tiny crab, tadpole, spherical larva, jellyfish-like, winged plankton) need new development and module options in `src/genome`, not just new meshes. That is a rules-version change with an ADR, and it keeps ADR 0006's bounds, caps and repair.
  - Mesh detail: setae, antennae, limbs and segmented tails as fine geometry or shader detail, with level of detail per preset.
  - Internal anatomy: an inner layer (organs, gut, chambers, veins) seen through the body, derived from the genome.
  - Materials: glass and chitin translucency, refraction, wet gloss, pores and cell texture, small imperfections.
  - Look passes: a fixed gallery (the same genomes, seeds and camera every time) rendered next to the references. Each pass task attaches the gallery and an honest written comparison with each reference to its PR, lists the largest gaps, and fixes them. There are at least two passes, and more until the rubric holds. Never call a pass done because the tests are green.
  - Rubric: the gallery holds up next to each reference (silhouette variety, translucency, inner detail, fine appendages, palette, rare glints, lighting); plus an `(owner)` check on the Playtest issue. Close #90 when the owner accepts it.
- Quick social messages (owner, #89, Playtest v0.4.0): pings and emotes chosen on purpose, not by the G key's random pick. A radial wheel (touch-friendly for the mobile work after 1.0) or number hotkeys, one key press from play, and edge arrows toward a nearby off-screen ping. Redraw the emote and ping icons to production quality. Close #89 when it ships.
- No per-frame allocations, budget report, per-preset screenshots.
- Owner feedback on v0.6.0 (Playtest #134), folded in as T18 to T20 of the spec: an exciting egg reveal while waiting for the beacon; findable players (edge chevrons and a pond map); faster, visible growth; a carried egg that feels meaningful. Kills as the main way to grow and eggs as predator prey need combat, so they are M7 criteria.

### M6b Look and HUD polish (gate: the look and the HUD)

Added from the owner's reply on Playtest #183 (v0.7.0). Look comes first: stats, genesis code and goldens may change as far as needed so creatures look like creatures (ADR 0006 bounds and caps stay). The owner asked for one milestone, with no series of passes, and for Opus on the work; the spec marks every look and HUD task `[opus]`. It supersedes ADR 0033's plan to carry the look gaps into later milestones, and it answers #177 (closed by the owner as a duplicate of this feedback).

- Look: the pass-1 gallery (`docs/art/gallery/pass-1.png`) is the baseline for realism: glassy, clear, with organs sized and coloured as there (colours close together or complementary). Remove what passes 2 to 5 added: the milky haze and the artificial glow. A fixed gallery plus an honest comparison to pass 1 and to the references stays the evidence, but in one pass.
- Clipping: no super-bright white where parts overlap (cells 07, 08, 31, 37, 38 and 39 of pass 5 are the regression cases); a test on the gallery's brightest pixels guards it.
- Long bodies: worms, copepods and shrimps need distinct, readable silhouettes (head-heavy chains, spirals and bare broad legs from #177 are the known gaps). Development, stats, genesis and the rules goldens may change, with an ADR.
- HUD: a minimal gameplay screen. One profile or settings icon in a corner; stats as small visuals or progress bars; the pond map as a modern minimap in a corner; the UV and crush states shake the screen or creature slightly instead of a red border.
- Egg reveal: no steady wiggle from the start; it wiggles only right before hatching; the polish of a gacha reveal; the title screen no longer covers the egg when hatching after death.
- Controls: using the social wheel does not stop the last movement.
- Speed: find out whether creatures that are sometimes way too fast are a bug or the design, fix or document it in `docs/DESIGN.md`.
- Water: keep the depth-zone background, with fewer effects in the shallows.
- Owner checks on the Playtest issue: the creatures keep the pass-1 realism, the HUD feels clean, the egg reveal feels polished.

### M6c Living creatures and play polish (gate: the creatures)

Added from the owner's Playtest v0.7.1 feedback, given in a Claude session on 2026-11-01 with screenshots (the Creature Lab, the minimap, a creature in Firefox). The spec maps each point to a task.

- The world is renewed once: rules 8 resets the ledger (identities stay) and retires every frozen version, as the owner allowed (ADR 0040).
- Creatures read as organisms (ADR 0041):
  - parts by region (one long antenna pair, up to 6 swept-back leg pairs, one tail structure) and at most 14 visible parts;
  - tapering, curving, slightly asymmetric parts; branches only on antennae and tails; rare bulb tips; short, soft setae;
  - coils gated to read as spirals;
  - the Lab's wild mode replaced by evolved lineages.
- Glass: pass 1's soft 3D sheen back on the face, limbs of the same glass as the body (no grey limbs, still no clipping), and a mouth drawn as a mouth instead of a dark half-circle.
- Organs in at most two related colours with a faint inner glow on one or two; eyes in the main organ colour.
- Firefox: no aliasing in the body and no flashing, checked in a Firefox Playwright project in the release gate.
- Play: damage as distinct hits at intervals (Minecraft-like), sunlight strongest in the shallows, a still background and a chargeable, player-cracked egg reveal (honest: clicks never change the result), and a minimap that turns smoothly with a depth gauge that can't be mistaken for a player.
- Owner checks on the Playtest issue: organic creatures, hits, sunlight, the egg reveal, the minimap.

### M7 Encounters (gate 3: combat feel)

Fun, fair combat under real latency (ADR 0011).

- Encounter state and the input-frame codec.
- Combat mechanics from anatomy: weapon tips (reach, arc, windup, cooldown), bites, rams, spines, armour, stance, brace.
- Autopilot from behaviour genes (deterministic).
- Signed snapshots for lock-in.
- Authority referee: instant lock, a 10 Hz frame clock, deadlines, canonical bundles, results as records.
- Client prediction and rollback (≤10 frames).
- Combat HUD and telegraphs; multi-party joins (up to 4) and targeting.
- Rewards and carrion; spawn protection and tier enforcement.
- Growth through combat (owner, Playtest v0.6.0): killing a comparable creature must grow you faster than eating plankton, and size must be a meaningful advantage in a fight. Kill rewards and carrion value scale with the victim's size and the tier gap, tuned with the tournament tool; the plankton economy stays for the first minutes. Reward decay for repeated victims stays (M8).
- Predators eat eggs (owner, Playtest v0.6.0): a pending egg is a high-value target, much richer than plankton, so carrying one is a risk worth protecting. Needs an ADR first: the pending child is a ledger record, so losing it must settle through the authority, stay consistent with the death fallback of ADR 0021 and be recoverable by its owner when it is not eaten. M6 draws the carried egg (T20).
- Combat tournament tool (no archetype above 70% overall).

### M8 Disconnect-safe settlement

Fights finish whatever the network does.

- Encounter persistence and recovery from DO restarts.
- Autopilot on disconnect, with proxy snapshots; reconnect fast-forwards.
- When every participant leaves, the authority fast-forwards and settles.
- Deadline and backdating tests under clock skew.
- Settlement records with a Merkle root of the bundles, and `verifyEncounter`.
- Transition locks during fights; offline players see the consequences at next login; kill-farming decay.
- Jitter and loss harness.

### M9 Verifiable lineage and showcase

Anyone can check a creature's history (ADR 0009).

- A rules-version registry with frozen v1 implementations.
- Proof bundles (minimal, size-bounded) and the endpoint that serves them.
- Verifier for chains, signatures and key history; for births and genesis (inheritance recomputed from beacons); and for time gates, costs and settlements.
- Authority audit of conflicts, replays and implausible progression.
- CLI verifier and `docs/VERIFY.md` (what verification proves, and what it doesn't).
- Lineage viewer, and creature cards with a share page that verifies on the client.
- Retention and storage budget.

### M10 Witnesses, audits and anti-farming

Independent eyes without trusting peer votes (ADR 0012).

- Eligibility pool, commitment and ordered selection from a future round.
- A shared referee module, with handover from authority to witness and back at frame boundaries.
- Witness duty within the connection budget; attestations and disagreement handling.
- Authority-only fallback, flagged.
- Mating and genesis audits; signed inputs.
- Remaining anti-farming measures, plus a bot-farm simulation (`tools/farm-sim.ts`).
- Cost check: authority messages per encounter cut by at least 4×.

### M11 Area of interest and size tiers

Scale beyond one pond (ADR 0013).

- Tiers and interaction rules; large-world fields (chunked, cached).
- Authority quadtree directory: split above 16, merge below 6.
- Client AoI manager with priorities and the cap, with property tests: no hidden interactable creature, cap respected.
- Mesh-relayed signaling; handoffs and boundary neighbours.
- Tiered viewport and ambient swarms for giants; snapshot rate by distance; tier-sized food for large creatures.
- Headless AoI simulation harness; migration from ponds to the world.

### M12 Habitats, regrouping and spawning

A full world at any population.

- Group clustering and a persisted spawn centre.
- Ring placement with scoring and expansion; spawn protection and anti-camping.
- "Ride the current" consolidation.
- Crowded leaf instances: sticky, never separating interacting creatures, merging when quiet.
- Transition integrity across tier, cell, instance and regroup changes.
- Population-wave simulation (5 → 300 → 20).

### M13 Scale proof and admission

Evidence for 10,000 concurrent players within budget.

- Metering (`/v1/metrics`).
- Load simulator: in-process at 10k, plus a real-workerd run of about 500 clients.
- Overlay, bandwidth and storage models.
- `docs/CAPACITY.md` at 5, 50, 200, 1k and 10k players, free versus paid.
- Admission queue with position and ETA.
- Sharding only if the measurements demand it (with a new ADR).
- A small `@slow` load test in the release gate that guards per-player costs.

### M14 v1.0 release (gate: about 200 players)

Everything in the brief, hardened.

- Interrupted-transaction journal and recovery: killing the tab at any step stays consistent.
- Firefox and WebKit in the release E2E, with cross-engine goldens for the sim, development, inheritance and encounters.
- Onboarding hints, help, controls, colour-blind-safe cues.
- Balance pass: at least 3 archetypes in the top 10%.
- `docs/OPERATIONS.md` runbook; security and privacy review; a one-hour soak test.
- Preparation for the 200-player playtest; a brief coverage audit with evidence; release notes.

## Brief coverage

Every requirement in `docs/BRIEF.md`, mapped to the milestone that delivers it.

| Brief requirement | Milestone |
|-------------------|-----------|
| **General** | |
| Browser-based, top-down P2P creature-evolution game with a polished 3D look | M1, M2, M6 |
| No Spore or EA names, assets or trademarks | all (`.claude/rules/render.md`) |
| Practically limitless players globally | M11, M12, M13 |
| Fun, good-looking, free-ish and low-maintenance infrastructure; a minimal serverless authority | M2, M4, M6, M13 |
| Hatch a creature with unique DNA that deterministically defines appearance and traits | M3, M4 |
| Start as a small cell and develop through generations | M1, M3, M5 |
| Survive, find mates, offspring inherit from parents A and B; no blockchain or cryptocurrency | M1, M5 (ADR 0009) |
| **Genetics** | |
| Breed genuinely new shapes and behaviours; procedural morphology without degenerate shapes as a major milestone | M3 |
| Mendelian inheritance, recombination and mutation drive bounded development | M3, M5 |
| Anatomy affects movement, collision, feeding, combat and appearance | M3, M7 |
| Viable, bounded organisms; tradeoffs; diverse successful adaptations | M3, M7, M14 |
| **Fun** | |
| Fast survival, risk of death, visible progress, lineage attachment | M1, M5, M7 |
| Rare genetics and striking creatures worth discovering and showing off | M3, M5, M6, M9 |
| Enjoyable before genetics is understood; approachable controls; readable consequences | M1, M2, M6, M7 |
| No NPC organisms or fake players; nonliving food, terrain, hazards and particles; solo play works; mating needs another player | M1, M2, M5 (ADR 0014) |
| **Scaling law and area of interest** | |
| Creatures and viewport scale up over time and generations; giants interact with large organisms | M1, M11 |
| Quadtree-like hierarchy and AoI; 16–32 connections including boundary neighbours, witnesses and handoffs | M11, M10 |
| Size tiers separate from spatial subdivision; adjacent tiers interact; microscopic activity not networked individually | M11 |
| Subdivide crowded areas; bounded instances; never hide an opponent who can affect the player | M11, M12 |
| Consolidate sparse players; preserve progress and encounters | M12 |
| Ring spawning around groups, compatible sizes, expanding, outside attack range, anti-camping; the first player sets the centre | M2 (basic), M12 |
| Transitions preserve one active state, can't escape combat or duplicate progress; no teleport out of encounters | M8, M11, M12 |
| **Combat** | |
| Automatic deterministic baseline combat with real-time steering and decisions | M7 |
| Lock the encounter and starting states, not the outcome; stance, targeting, timed defence | M7 |
| Same start, seed, rules and inputs → same result across clients | M7, M14 |
| Canonical order with deadlines; autonomous fallback; closing a tab changes nothing | M7, M8 |
| Committed state and inputs suffice to finish and verify when everyone disconnects; resume; no backdating | M8 |
| Fast lock-in without a beacon per action | M7 (ADR 0010) |
| **Mating** | |
| Consent, eligibility, resource cost, cooldown; authoritative maturation and generation time | M4, M5 |
| Two distinct deterministic offspring with separate seed slots; one active creature; one pending offspring | M5 |
| Commit parents, transaction and a future drand round; no round choice, seed change or cancel-to-reroll | M5 |
| No acceptance before the real eligibility time; no reliance on local puzzles | M4, M5 |
| **Offspring rules** | |
| Surviving parent becomes an inactive checkpoint on promotion | M5 |
| On death, return to the nearest surviving ancestor with its condition and remaining lifespan; no rewind or refund | M5 |
| Finite lifespans; checkpoints and offline creatures pause outside committed encounters; no refills | M4, M5, M8 |
| Deeper ancestors stay in the fallback chain | M5 |
| Old age walks the chain; dead stay dead; nothing left → new genesis, history kept | M4, M5 |
| **Verifiable lineage** | |
| UTXO-like state model; exactly one accepted current state | M4 |
| Ancestry verifiable from genesis, hashes, signatures, rules versions, seeds and transitions; both parents; graph versus checkpoint branch | M5, M9 |
| Data or proofs retained when peers are offline; integrity is not legitimacy; restoring is a new transition | M4, M5, M9 |
| **Witnesses and minimal authority** | |
| drand-selected witnesses; committed pool, event id and round; no shopping or retries | M10 |
| Witnesses independent of the players, beyond AoI where useful, within budgets | M10, M11 |
| Sybil caveat: eligibility adds friction, not proof | M10 (ADR 0012) |
| Minimal authoritative finality plus witnesses; movement, rendering and most simulation P2P | M4, M7, M10 |
| Authority keeps heads, sessions, time gates, commitments, recovery; detects conflicts, fabrication and replays | M4, M9 |
| Settlement works with too few, unavailable or no witnesses; never faked | M8, M10 |
| Uncertainty about movement and collusion stated explicitly | M9 (`docs/VERIFY.md`), ADRs 0005, 0011, 0012 |
| **Cheating** | |
| Supply control: survival costs, reproduction limits, tradeoffs, resistance to repeated farming; bots gain no effortless superior creatures | M1, M4, M5, M8, M10 |
| **Technology** | |
| Three.js 3D organisms and environments in a top-down 2D world; movement, lighting, materials, silhouettes | M1, M3, M6 |
| Shared deterministic simulation, separate from rendering, versioned rules, verifiable replay | M1, M7, M9 |
| WebRTC P2P with a discovery layer; dependable signaling; NAT/TURN fallback | M2, M11 |
| GitHub Pages plus a minimal Worker and Durable Object; no always-running simulation or per-frame writes | M0, M2, M4 |
| Verified drand with caching and an outage policy | M4 (ADR 0010) |
| Durable saves, identity recovery, peer handoff, interrupted-transaction recovery | M4, M11, M14 |
| **Scale and delivery** | |
| 5 to 10,000 concurrent players across local habitats with minimal infrastructure | M11–M13 |
| Measure authority work, storage and relay traffic; expose costs and limits | M13 |
| Hard spending ceiling with a capacity and admission policy | M4 (basic), M13 |
| Prove the survival and breeding loop and morphology early with real players | M2, M3, M5 (gates) |
| Then validate combat, lineage verification, sparse grouping and crowded scaling | M7–M12 |
| Definition of done: everything at about 200 real players; 10k by load simulation and cost model | M13, M14 |
| **Targets** | |
| Desktop Chrome, Edge, Firefox, Safari (latest two); mouse and keyboard | M6, M14 |
| 60 fps on a mid-range laptop at the default preset; low, medium and high presets | M6 |
| **Art direction** | |
| Macro photography: shallow DOF, translucent membranes, caustics, bioluminescence deeper down, readable silhouettes; references in `docs/art/` | M1, M6 (reference added in M0) |
| **Budget** | |
| €0 on free tiers as long as possible, never above €10; queue past capacity | M4, M13 (ADR 0008) |
| **Privacy and identity** | |
| Browser keypair with an exportable recovery key; no email or passwords | M2, M4 |
| **Social** | |
| Text chat with a profanity filter, emotes and pings | M2 |
| **Playtesting** | |
| Gates after the first playable loop, after breeding and morphology, after the look overhaul (owner, #90), and before v1.0; works from the Pages build without setup | M2, M5, M6, M7, M14 |
| **Testing** | |
| No NPCs in the live world; headless clients, recordings and simulated populations only in tests and load simulations | all (`.claude/rules/tests.md`), M13 |
| **Owner decisions at scaffold** | |
| Water only for v1.0; combat after breeding with its own gate; light procedural sound | ADR 0014; M7 gate; M6 |
