# Brief

Build Biosphere, a browser-based, peer-to-peer creature-evolution MMO and spiritual successor to Spore's cell and creature stages. Don't use Spore or EA names, assets or trademarks. It supports practically limitless players globally, with a major focus on genetic evolution and (Mendelian) inheritance rules. The game will consist of a top-down view, much like the earlier stage of Spore, but with a polished AAA look within usual browser constraints and an impressive technical architecture.
Its three main focuses should be: fun to play, good looking in a browser, and free-ish and low maintenance infrastructure. A really minimal serverless authority, e.g. through Cloudflare, is fine. Treat the following as requirements and leave implementation choices open wherever a simpler, sound solution exists.
Players start off by hatching (minting) a new creature with its own unique DNA, that deterministically defines its appearance and traits. It starts from a small cell stage and develops through generations into a sophisticated, well adapted organism inside of the biosphere. Players survive, find mates, and develop offspring with features inherited from parent A and B. Minting just means hatching; there is no blockchain or cryptocurrency.
Genetics:
- Players can breed genuinely new shapes and behaviors, not just fixed body parts or genetic stats. A genuine procedural morphology system without degenerate, unplayable shapes should be a major development milestone.
- Use Mendelian inheritance, recombination and mutation to drive a bounded developmental system. Anatomy should meaningfully affect movement, collision, feeding, combat and appearance.
- Keep inherited organisms viable and computationally bounded. More size, armor or complexity comes with tradeoffs; evolution should produce different successful adaptations rather than one permanently superior build.
Fun:
- Fast paced survival, the rush of potentially dying at any time, visible progress, and long term attachment to a lineage. Rare genetics, striking appearances and exceptional creatures should be worth discovering and showing off.
- Movement, feeding, positioning, taking risks, fighting and choosing mates must be enjoyable before the player understands genetics. Keep controls approachable and make consequences readable.
- Absolutely no NPC organisms, predators, mates or fake players. This world lives with its players. Nonliving food resources, terrain, hazards and visual particles are fine. With only one player online, exploration and survival remain possible, but mating requires another player.
Scaling Law / Area of Interest:
Starter creatures start off small and can scale up with time and generations; so does the viewport, similar to Agar.io. Giants mainly interact with other large organisms, while much smaller creatures fall outside their active interaction scale.
Use a spatial quadtree-like hierarchy and AoI, capping active peer connections at 16–32 per browser, including boundary neighbors, witnesses and handoffs.
- Separate biological size tiers from spatial subdivision. Comparable creatures across adjacent tiers can still interact; unrelated microscopic activity does not need individual networking.
- Subdivide crowded areas and use bounded local habitat instances where necessary. Never hide an opponent who can still affect the player.
- When population is sparse, consolidate compatible players into shared habitats instead of spreading them across an empty world. Preserve progress and existing encounters during regrouping.
- New players spawn in a ring around an existing player group, favoring compatible sizes and expanding the populated area outwards as it fills. Choose positions outside immediate attack range and avoid easy spawn camping. The first player establishes the initial spawn center.
- Cell, tier and habitat transitions must preserve one active creature state and cannot be used to escape combat or duplicate progress. Regrouping must not teleport somebody out of an ongoing encounter.
Combat:
- Automatic, deterministic baseline combat, with real-time steering and meaningful player decisions.
- On engagement, lock the encounter and its starting states, not its final outcome. Keep a small set of active mechanics during combat, such as stance changes, targeting or a timed defensive action.
- Determinism means the same starting state, seed, rules version and accepted sequence of inputs always produce the same result across clients.
- Accept player actions in a canonical order with deadlines. Missing or late input uses a predefined autonomous fallback. Closing a tab never cancels the encounter, erases accepted actions or avoids its consequences.
- Preserve enough committed state and inputs for the fight to finish and be verified even if every participant and witness disconnects. Reconnecting resumes the accepted fight state; players cannot submit backdated actions.
- Lock-in should remain fast and responsive, without waiting for a new randomness beacon on every action.
Mating:
- Both players consent, both organisms must be eligible, and reproduction consumes resources and a short cooldown. Enforce maturation and minimum generation time through authoritative time/state commitments.
- Each mating creates two distinct deterministic offspring, one for each player. Both inherit from the same parents but use separate offspring slots in the seed. One active creature per player; initially allow one pending offspring.
- Commit both parent states, the breeding transaction and a specific future drand round before its randomness becomes available. No selecting favorable rounds, changing seeds or cancelling to get a free reroll.
- The next generation cannot be accepted before its real eligibility time, even if someone computes possibilities offline. A local computational puzzle alone is not sufficient.
Offspring Rules:
- The surviving parent becomes an inactive checkpoint when the player promotes to its child.
- When the active creature dies, return to the nearest surviving ancestor with its saved condition and remaining lifespan, without rewinding the world or restoring spent resources.
- Parents have finite remaining lifespans. Inactive checkpoints and offline creatures pause outside committed encounters; returning never refills lifespan or resets reproduction cooldowns.
- Once the child reproduces and the player promotes again, it becomes the immediate parent checkpoint. Earlier viable ancestors remain deeper in the fallback chain.
- Death from old age can send the player back through this chain, potentially to the genesis creature. Dead or exhausted ancestors remain dead. If none survive, hatch a new genesis creature and retain the old lineage as history.
Verifiable lineage:
- Use a UTXO-like state model: a significant update consumes the accepted previous state and produces its successor. Each creature has exactly one accepted current state.
- The full ancestry must be independently verifiable from registered genesis states, hashes, signatures, rules versions, inheritance seeds and the necessary state-transition records. Reference both biological parents; the ancestry is a graph, while the player's checkpoint history follows its chosen branch.
- Retain the data or verifiable proofs needed to check that history even when the original peers are offline. A hash proves integrity, not that an invented history was legitimate. Restoring an ancestor creates a new accepted transition; it never restores an old spendable state.
Witnesses / minimal authority:
- drand can select random witnesses for verification and audits. Commit the eligible witness pool, event identifier and future beacon round before selection is revealed, with no committee shopping or free retries.
- Select witnesses independently of the involved players, including eligible peers beyond their immediate AoI where useful, while preserving connection and bandwidth budgets.
- Random selection does not stop one person from creating many identities. Witness eligibility and admission limits can add friction, but must not be treated as proof of unique humans or an honest majority.
- Prefer minimal authoritative validation/finality for critical transitions, assisted by randomly selected witnesses, over trusting peer votes alone. Keep ordinary movement, rendering and most simulation P2P.
- The authority retains the minimum state needed for canonical state heads, single active sessions, time gates, durable commitments and recovery. Detect conflicting successors, fabricated progression and replayed transactions.
- Verification and settlement must still work with too few independent witnesses, unavailable witnesses or everybody disconnecting. Resolve through the minimal authority using committed records and defined fallback behavior. Do not fake independent witnesses or silently lower security.
- Keep uncertainty about client movement and collusion explicit; do not claim that deterministic replay alone proves honest play.
Cheating:
With a f2p browser game, reliable bot prevention is not assumed. Supply control is still important: successful organisms should be difficult to develop, keep alive and use effectively. Use survival costs, reproduction limits, meaningful tradeoffs and resistance to repeated farming. Many bot accounts must not translate directly into effortless superior creatures, though extra attempts remain an advantage.
—
Technology:
- Three.js: polished 3D organisms and environments within a top-down, 2D gameplay world. Prioritize convincing movement, lighting, materials and readable silhouettes.
- A shared deterministic simulation, separate from rendering, with versioned rules and verifiable replay.
- WebRTC P2P, with Trystero or an equivalent discovery layer. Public Nostr/WebTorrent relays can bootstrap discovery; provide dependable signaling and NAT/TURN fallback without assuming public relays or direct P2P always work.
- GitHub Pages or an equivalent static host. A minimal Cloudflare Worker / Durable Object setup is acceptable for the authority and coordination. Avoid an always-running global simulation or per-frame backend writes.
- Use verified drand randomness where it provides value, with caching and a defined outage policy.
- Keep durable saves, identity recovery, peer handoff and interrupted-transaction recovery reliable. Do not depend on one browser keeping the world or its history alive.
Scale and delivery:
Aim for low maintenance and minimal infrastructure from 5 to 10,000 concurrent players across local habitats. Measure authority work, storage and relay traffic, and expose the cost assumptions and operating limits. A hard spending ceiling needs an explicit capacity/admission policy; free tiers are an optimization, not proof of unlimited capacity.
Prove the survival/breeding loop and procedural morphology early, with real players. Then validate disconnect-safe interactive combat, lineage verification, sparse-population grouping and crowded-area scaling. Choose the simplest implementation that meets these requirements.
Priorities (when requirements conflict, the earlier one wins):
1. A fun, readable core loop: move, feed, survive, find a mate.
2. Procedural morphology and inheritance that produce genuinely different, viable creatures.
3. Good looks within browser budgets.
4. Robust multiplayer: P2P, area of interest, regrouping.
5. Disconnect-safe deterministic combat.
6. Verifiable lineage, witnesses and anti-farming.
7. Scale to 10,000 concurrent players.
Definition of done (v1.0): every requirement above works with real players at small scale (around 200 concurrent). The 10,000 target is shown by load simulation and a measured cost/capacity model. Anything else is post-1.0.
Targets: desktop Chrome, Edge, Firefox and Safari (latest two versions); mouse and keyboard; mobile after 1.0. 60 fps on a mid-range laptop with integrated graphics at the default preset; low, medium and high quality presets.
Art direction: macro photography of microscopic life: shallow depth of field, translucent membranes, caustic light, bioluminescence deeper down; silhouettes readable at a glance. Reference images may be added to docs/art/.
Budget: €0 a month on free tiers for as long as possible, never more than €10 a month. Past capacity, queue new players (admission control) rather than spend more.
Privacy and identity: Identity is a browser keypair with an exportable recovery key; no email or passwords in v1.
Social: text chat (with simple profanity filter), plus only emotes and pings.
Playtesting: the factory can't judge fun, real-device performance or real-world networking. Plan playtest gates at least after the first playable survival loop, after breeding and procedural morphology, and before v1.0; at a gate, wait for my feedback. I test with a few friends using the Pages build, so it must work without any setup.
Testing: the no-NPC rule applies to the live world only. Headless test clients, recorded sessions and simulated populations are expected in tests and load simulations; they never join the live game.
Inspiration:
Spore: Procedural organisms, evolution, and morphological diversity.
Agar.io: Accessible survival gameplay, growth, and escalating scale.
Pokémon: Collecting, breeding, attachment, and showing off exceptional creatures.
Trackmania: Deterministic competitive outcomes and verifiable competition.
Bionix Spore Evolution Sim 3D: Realistic 3D graphics within a simple 2D world.

Most importantly its main focus shouldn’t just be on collecting rare creatures or being an overly too complex biology/chemistry simulation. Instead, it should be a really fun, beautiful game with realtime gameplay and enough depth for longterm play.
