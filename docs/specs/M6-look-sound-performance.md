# M6: Look, sound and performance

Release: v0.7.0 · Gate: yes

## Goal

Biosphere looks, sounds and runs like the game the brief describes. In the pond the water is deep and layered: light, fog and food change with depth, the shallows glitter with caustics and burn with UV, the abyss is dark and crushing, and bioluminescence is what you see by down there. Creatures are the centrepiece: diverse, glass-like, strictly top-down micro-organisms with visible inner organs, fine antennae and setae, wet gloss and rare, never-glittery glints, held to the owner's references (#90, `docs/art/reference-02.jpg` to `reference-05.jpg`) on a committed gallery (ADR 0024). Three quality presets (low, medium, high) with budgets, an automatic default and adaptive resolution keep it smooth. Every event in DESIGN §10 has a procedural sound, with volume, mute and reduced-motion settings. Pings and emotes are chosen on purpose from a wheel, with edge arrows toward off-screen pings (#89), and finding other players is easy. The owner's playtest feedback on v0.6.0 is folded in: waiting for the beacon is an exciting egg reveal, carrying a pending egg feels meaningful, and progression is visibly faster.

This milestone is a **gate**: after v0.7.0 the factory waits for the owner's reply on the `Playtest: v0.7.0` issue (the look, brief gate 2 continued).

## Out of scope

- Combat, carrion, kill rewards, and anything that lets a predator eat a pending egg (M7; the owner's v0.6.0 feedback on kills and eggs goes into the M7 outline, see T18 and T20).
- Mobile and touch controls (after 1.0). The wheel and the map are built so touch can use them later, nothing more.
- WebGPU, a second render path, or any new runtime dependency. Everything is GLSL on `THREE.WebGLRenderer` (ADR 0004).
- Music. Sound is ambience and event effects, all synthesised; no audio files ship.
- The area-of-interest world (M11). Pond maps show the pond only.
- Changing the mating rules, the authority's records or the wire protocol except where a task says so.

## Touches

New: `src/render/presets.ts`, `settings.ts`, `post/` (chain, passes, `dof.ts`, `adaptive.ts`, `benchmark.ts`), `src/render/shaders/{bloom,dof,composite,caustics,godrays,anatomy}.glsl`, `src/sim/bathymetry.ts`, `src/render/zones.ts`, `src/genome/` body-plan v2 files (T10 decides names), `src/render/anatomy.ts`, `src/audio/` (`engine.ts`, `synth.ts`, `ambience.ts`, `events.ts`, `settings.ts`), `src/game/wheel.ts`, `radar.ts`, `hatch.ts`, `progress.ts`, `src/lab/gallery.ts`, `tools/gallery.mjs`, `tools/budget-report.mjs`, `tests/fixtures/gallery/`, `docs/art/gallery/`, `tests/e2e/m6-*.spec.ts`, `docs/decisions/0025-*.md` (body plan v2).

Changed: `src/sim/rules.ts` (rules version 6), `src/sim/{food,spawn,step,life,types}.ts`, `src/genome/{karyotype,genesis,express,develop,stats,codec,offspring}.ts` (karyotype v2), `src/render/{scene,creature-mesh,materials,material-params,water,particles,effects}.ts` and shaders, `src/game/{app,hud,screens,input,social,social-ui,offspring,debug}.ts`, `src/lab/*`, `index.html`, `playwright.config.ts`, `docs/DESIGN.md`, `docs/ROADMAP.md`.

Rules numbers (rules version 6; DESIGN §2, §4 and §12 mirror them as each task lands):

```ts
// src/sim/rules.ts additions
zones: { shallowsBelow: 0.25, twilightBelow: 0.5, deepBelow: 0.75 },   // depth 0 (surface) to 1 (abyss) from the bathymetry field
hazards: { uvHpPerS: 2, pressureHpPerS: 3 },                            // times (1 - tolerance), see DESIGN §4
```

Presets (T1; DESIGN §12 is the table): low = pixel ratio 1, no post chain, 30% particles, 80 draw calls / 150k triangles; medium = up to 1.5, half-resolution depth of field, bloom and grade, 100% particles, 150 / 300k; high = up to 2, full-resolution depth of field, bloom, chromatic aberration and grain, 150% particles, 250 / 600k.

Keys: hold `G` for the wheel (T24), `M` toggles the pond map (T25). Existing keys are unchanged.

## Tasks

M6 is large, so the tasks run in layers: render foundations (T1 to T5), depth zones (T6 to T9), the creature overhaul (T10 to T17), progression and the egg (T18 to T20), sound (T21, T22), social (T23 to T26), performance (T27) and closing (T28, T29). A look pass task does not start before its predecessors are ticked.

### Render foundations

- [ ] T1 Render settings and presets [opus] (in progress)
  - Acceptance (unit tests first):
    - `PRESETS` equals the table above and DESIGN §12 (a test pins every number). `resolvePreset(setting, detected)` returns the setting unless it is `auto`, then the detected preset (`medium` until T5 detects). `pixelRatio(preset, devicePixelRatio)` is `min(dpr, preset max)`, at least 1.
    - `loadSettings()` reads `localStorage['bs.settings']`: invalid JSON, wrong types, unknown preset names and a throwing `localStorage` all give the defaults (`quality: 'auto'`); `saveSettings` swallows a throwing store. `?quality=low|medium|high` in the URL beats the stored value without writing it (E2E and tests use it).
    - E2E (`m6-presets.spec.ts`): `?quality=low` and `?quality=high` start the game with `__bs.render().preset` set; the settings panel in the Esc menu switches preset at runtime and the pixel ratio, particle count and `renderer.info.render.calls` follow without a reload; the choice survives a reload; with `localStorage` blocked the game still runs.
  - Notes: this task owns the settings panel shell (quality now; T21 adds volume and T9 reduced motion reuse it). Particle counts scale with the preset in `ParticleLayer`. Presets only change presentation: nothing in `src/sim` reads them.

- [ ] T2 Post chain: scene target, bloom, grade, vignette, grain, chromatic aberration [opus]
  - Acceptance (unit tests first, then E2E screenshot properties):
    - A render-to-target scene pass feeds a short chain; `__bs.render().passes` lists the pass names: low `[]` (the scene goes straight to the screen), medium `['scene', 'bloom', 'composite']`, high the same plus `'ca'` and `'grain'` inside the composite. Bloom is a dual-filter down/up chain at half resolution on medium and high.
    - Pure functions with unit tests: vignette is 1 at the centre, non-increasing with distance, and at least 0.7 in the corners; grain is deterministic for (seed, time), zero-mean within 1e-3 over 100,000 samples and bounded by ±0.04; chromatic aberration offset is 0 at the centre and grows with radius, at most 1.5 pixels at the corner on high.
    - Resize and preset switches dispose and recreate targets: after 20 switches between presets `renderer.info.memory.textures` and `geometries` return to their baseline (no growth), and `__bs.render().targetBytes` equals the sum of the live targets.
    - Screenshot properties (decoded PNG, 960×540): on medium a bright point against a dark scene has glow pixels at least 8 px beyond its radius, and none on low; corner mean luminance is at least 10% below centre mean luminance on medium; a screenshot on every preset is non-blank and has contrast (existing helper).
  - Notes: no new dependency (ADR 0004). The creature and cell shaders keep working unchanged when the chain is off. Reuse scratch objects: no per-frame allocation in the pass loop.

- [ ] T3 Depth of field [opus]
  - Acceptance:
    - `coc(z, focusZ, aperture)` is pure: 0 at the focus plane, symmetric in distance, monotone, clamped to `maxCoc`; table tests pin five points. Layers sit at fixed z: far bokeh below the plane, creatures, food and the player on it, near particles above.
    - Medium runs the DOF pass at half resolution, high at full resolution; low keeps the existing fake bokeh sprites and no pass (`passes` reports `'dof'` accordingly).
    - The focus plane is never blurred: on medium the mean gradient magnitude of the player's outline in a 960×540 screenshot is at least 85% of the same crop on low (set `?quality`), and far particles are visibly softer than mid particles (a crop of the far layer has gradient below 60% of a mid-layer crop).
    - The DOF samples are bounded (a constant tap count per preset, listed in `presets.ts`), and a pass run costs no allocations.
  - Notes: depth comes from the layer's z written to a target channel, not from a depth buffer readback.

- [ ] T4 Auto-detect and adaptive resolution [opus]
  - Acceptance (unit tests first, fake clocks and fake frame times):
    - `pickPreset(medianFrameMs, rendererName)`: a software renderer (`SwiftShader`, `llvmpipe`, `Software`) → `low` whatever the time; otherwise below 6 ms → `high`, below 11 ms → `medium`, else `low`; boundaries pinned.
    - The benchmark renders 30 frames of a fixed test scene (no sim, no network) off the gameplay loop on the first start, stores `{ preset, at }` in the settings, and is skipped when the setting is not `auto`, when `?quality` is given, or when a result younger than 30 days exists. Choosing Auto again re-runs it.
    - `AdaptiveScale` (pure): input is frame milliseconds; steady 30 ms steps the render scale down through `1, 0.85, 0.7, 0.6` and stops at 0.6 within 10 s of frames; steady 8 ms never steps; alternating 8/25 ms produces at most one change in 30 s; steps up one level after 10 s of frames below 13 ms; never more than one change per 2 s; a tab that was hidden (a frame over 1 s) is ignored, not counted.
    - E2E: with the scale forced by `__bs.render().forceScale` the canvas drawing buffer follows (`width = round(css × ratio × scale)`), HUD text stays DOM (unscaled), and `?quality=low` never changes the scale in a short run.
  - Notes: adaptive resolution scales the scene and chain targets; the HUD is DOM and is never scaled.

- [ ] T5 Gallery tool and the baseline pass [opus]
  - Acceptance:
    - ADR 0024 is the contract. `tests/fixtures/gallery/` holds 24 specimens as hex genomes with names (`g01` to `g24`): 12 distinct genesis cells (rarity common to exotic, with and without iridescence, luminescence, patterns), 6 bred multi-segment bodies, 6 hand-built showcase genomes (long antennae, many appendages, plates). A test decodes and develops every one (valid, within the caps) and checks the file hashes against a committed list, so a specimen cannot change silently.
    - `lab.html?gallery=1` renders them in a 4×6 grid at the fixed camera, time and backdrop of ADR 0024, with name labels; `npm run gallery -- --pass 0` writes `docs/art/gallery/pass-0.png`; two runs from one build produce byte-identical files (an E2E test captures twice and compares).
    - `docs/art/gallery/pass-0.md` is the honest baseline of the look before M6: the gap table (7 aspects × references 02 to 05, ratings 0 to 3, one sentence each) and "Largest gaps". A unit test parses every `pass-*.md`: all 28 cells present, ratings are integers 0 to 3, a sentence follows each rating, the gaps list is non-empty whenever any rating is above 1.
    - `tools/gallery.mjs` uses the shared Chromium (`/opt/pw-browsers`, as the other tools do) and never downloads a browser.
  - Notes: the sheet is a PNG of at most about 1.5 MB (palette-reduce or crop if needed). Read the sheet and each reference with the image reader and write the comparison from what you see, not from what the code intends.

### Depth zones

- [ ] T6 Rules version 6: bathymetry, zone food and spawn
  - Acceptance (unit tests first):
    - `RULES_VERSION` is 6 and every golden regenerates under it with the PR saying so (hashes and version only for tasks that do not change outcomes; this task changes food and spawn, so say which goldens change and why). `bathymetry.ts` exports `depthAt(seed, x, y)` in [0, 1], `zoneOf(depth)` using `RULES.zones`, and pure `gradient`.
    - Deterministic: five golden `depthAt` values on two seeds are committed. Smooth: over 10,000 random point pairs at most 100 wu apart `|Δdepth| ≤ 100/500`. Fair: over 20 seeds × 10,000 points the shares are shallows 15% to 35%, twilight 25% to 40%, deep 20% to 35%, abyss 8% to 20%.
    - `spawnPoint` never returns a point in the abyss or the shallows (twilight or deep only), keeps the M1 clearance from plumes, and still passes the existing spawn tests.
    - Food by zone over 20,000 slots per zone: shallows and twilight give detritus and globules and no vent crystals; deep gives vent crystals only within 300 wu of a plume anchor and otherwise detritus; abyss gives at least 3× the crystal share of the deep. The existing food respawn and claim tests pass untouched.
    - The pond's world seed is the only input, so peers and the authority agree: a test builds two worlds from one seed in separate modules and compares 1,000 samples.
  - Notes: update DESIGN §2 and the header. This is the only rules bump of the milestone: later tasks that change an outcome regenerate goldens under version 6 and say so in the PR. The authority does not simulate the world (ADR 0008), so no Worker change is expected; confirm and say so in the note.

- [ ] T7 UV and pressure hazards, tolerance genes
  - Acceptance (unit tests first):
    - `hazardDamage(zone, uvTolerance, pressureTolerance)`: shallows `2 × (1 − uvTol)` hp/s, abyss `3 × (1 − pressureTol)` hp/s, twilight and deep 0; tolerance 1 → 0, tolerance 0 → the full number. `PhysStats` carries both tolerances (from the existing `uvTolerance` and `pressureTolerance` traits, clamped 0 to 1; the starter cell has 0.5).
    - The sim applies the damage per tick with the existing damage-over-time path, emits `damage` events with causes `uv` and `pressure`, and a death with that cause; `DeathCause` and every place that lists causes (HUD, death screen text, history, the protocol's death report and the ledger's accepted causes) accept them. A replay golden with a UV death replays equally in Node and Chromium.
    - A genesis cell with the starter tolerance dies in the shallows after about 100 s and in the abyss after about 67 s (the test steps a creature held in each zone); a cell with tolerance 1 lives on.
    - Genesis tolerance distribution: over 10,000 genesis genomes the median of each tolerance is between 0.35 and 0.65 and fewer than 5% are above 0.9, so zones are a real choice.
    - The death screen names the cause in plain words ("Burned by sunlight", "Crushed by the deep") and the HUD shows a hazard cue (outline/vignette) while taking zone damage; the existing cue tests extend to the two causes.
  - Notes: DESIGN §4 gets the causes; DESIGN §10's rule stays (no silent death). Check `worker/` and `src/net/protocol.ts` accept the new causes; extend them and their tests if they validate against a list.

- [ ] T8 Zones on screen: light, fog, colour and a depth gauge [opus]
  - Acceptance:
    - `zoneLook(depth)` (pure, in `src/render/zones.ts`) returns light level, fog colour and density, water tint, and particle tint, continuous in depth (a test samples 1,000 depths: no step above 0.02 between neighbours) and ordered: light strictly decreases from shallows to abyss.
    - The water shader and particle layers follow the player's local depth with a 1 s smoothing; crossing a zone boundary never jumps.
    - A depth gauge in the HUD shows the zone name and a depth number (0 to 1,000 m, depth × 1,000), both from the same `zoneOf`; a hazard zone shows a short plain-words line ("Sunlight burns here. Pigment helps.").
    - E2E (`m6-zones.spec.ts`, using the debug hook to place the player at a known depth): mean luminance of the 960×540 screenshot decreases shallows > twilight > deep > abyss by at least 15% per step; the gauge text matches `zoneOf` at each stop.
  - Notes: presentation only; the render reads `depthAt` through the sim module and never writes sim state.

- [ ] T9 Caustics, god rays and marine snow v2 [opus]
  - Acceptance:
    - Caustics (animated bright network on the water, strength = shallows light only) and god rays (soft shafts from above, shallows and upper twilight) are shader effects; medium has caustics and no rays, high has both, low has neither. Marine snow v2 is a deterministic particle field with per-layer size, speed and a slow downward drift; density rises with depth on every preset (scaled by the preset's particle share).
    - The reduced-motion setting (new in the settings panel, also on when `prefers-reduced-motion: reduce`) freezes caustic animation, halves particle drift and removes shake and flashes from effects; a unit test reads the setting from a fake `matchMedia`.
    - E2E: in the shallows the water crop's local contrast (standard deviation of a 128×128 crop) on medium is at least 20% above the same crop in the deep; with reduced motion on, two screenshots 1 s apart of the water crop are identical (animation frozen) except the player's own motion.
    - Budgets: `renderer.info` for the shallows scene stays inside the preset budget (checked in `m6-budget`, T27).

### Creature overhaul

- [ ] T10 Body plan v2: ADR 0025, karyotype v2, genesis spread
  - Acceptance (unit tests first):
    - ADR 0025 records the decisions: how karyotype v2 extends v1 (appended loci that default to the v1 behaviour when zero, so a v1 genome padded with zeros develops to the same body it did before, and v1 `birth` records still verify under their own rules version), the new body classes, and what changes for existing creatures. Existing goldens (`src/genome/__golden__`, ledger birth vectors) stay valid for v1 genomes; new goldens cover v2.
    - Codec totality holds: any byte string of v2 length decodes, shorter input zero-pads, longer is ignored; 10,000 random strings round-trip.
    - New expressed traits give the owner's silhouettes without labels: spine curl (S-curve and spiral), body shape (oval, round larva, bell, wing-flat), eye pair, claw pair (articulated chains with a pincer tip), antenna length and setae density, fan-tail fringe, wing membrane (flat webbed part with veins), and an inner anatomy block (gut line, chamber count, droplet count, organ hue). All are `quant` or `mendel` loci under the ADR 0006 rules, with dominance tables where needed, rare novel alleles for the rare forms, and load alleles unchanged in meaning.
    - Genesis spread: over 10,000 genesis genomes at least six classifier buckets (`bodyClass`: copepod, larva, tadpole, bell, winged, worm; the classifier is read-only and used by tests and the Lab, never by the sim) each hold at least 3%, no bucket holds over 35%, genesis cells still have exactly one segment (worms and copepods come from small curl and shape differences on one segment), and the median top speed stays within 0.9× to 1.2× the M1 cell's.
    - `inherit` (meiosis, mutation) handles the new loci: the Mendelian ratio tests of M3 pass for a new `mendel` locus; all 10,000-genome viability property tests run on v2.
  - Notes: change one thing at a time inside the task (loci, then expression, then genesis). The inner anatomy block and the new part kinds are only data here; T11 develops them and T12 to T14 draw them.

- [ ] T11 Development v2: new parts, caps and stats
  - Acceptance (unit tests first):
    - `develop` produces the new forms inside the ADR 0006 limits: 1 to 8 segments, at most 24 appendage instances, 4 joints, 1 branch level, 12 colliders, bound ≤2.5 core radii, ≤6,000 vertices (≤1,500 low detail). Property tests over 10,000 random and 10,000 mutated v2 genomes (and 5,000 offspring) find zero invalid plans, zero NaN, a propulsion source and a mouth in every body, and no overlapping appendages.
    - New plan data: spine curve (control points), bell flag and radial tentacle count, wing parts (membrane polygon with veins), claw chains, eye positions, fringe setae counts, and the anatomy block. Each has a cap and a repair rule, listed in DESIGN §6 and pinned by tests (a wing larger than the bound is scaled, not dropped).
    - Stats: bells thrust by pulsing (jet: lower top speed than a flagellate of the same size, better acceleration from rest), wings paddle at large sizes (the same crossing as paddles), claws add reach and weapon score (M7 reads it) and drag, eyes and antennae extend the detection ring. No archetype is best at everything: the archetype test (existing, extended) shows each `bodyClass` is top-two in at least one stat and bottom-two in at least one over 2,000 genesis-plus-bred genomes.
    - The starter genome (`starterGenome`) still reproduces `STARTER_PHYS` exactly.
  - Notes: the gait and beat code in `src/render` consumes new part kinds in T12; here they only exist in the plan. Keep `estimateVertices` an upper bound that equals the mesh.

- [ ] T12 Creature mesh v2: curves, bells, wings, claws, fine appendages [opus]
  - Acceptance (unit tests first, then gallery):
    - The mesh builder draws every v2 plan: a curved spine lofts without folds (no triangle flips over 1,000 random curled plans: the signed area sign is stable), bells are a dome with tentacles, wings are a flat membrane with vein geometry, claws are jointed chains, eyes are domes. The vertex count still equals `estimateVertices`, and the cap holds over 2,000 random v2 plans.
    - Fine detail: antennae with evenly spaced setae/beads, feathery fans and fringes are produced as thin strip geometry or shader detail with a separate per-preset budget (high ≤ 2,000 extra triangles per creature, medium ≤ 800, low none); the budget test is part of `creature-budget.test.ts`. LOD: `lowDetail` meshes drop setae and veins and keep the silhouette (the silhouette area differs from the full mesh by at most 8%).
    - Gait: the vertex shader animates curl, bell pulse, wing flutter and tail fans from the existing uniforms; a spine curve with zero beat is static; the gait tests extend to the new parts and still show attachment (an appendage root never detaches from its segment over a full cycle).
    - Gallery: the Lab gets the v2 specimens (new hex files added, ADR 0024: `g25` to `g36`, two per `bodyClass`), and a distinct silhouette test: for the twelve new specimens the pairwise silhouette IoU (rendered to a mask at a fixed size) is below 0.8 for every pair.
  - Notes: the owner's silhouettes are in `docs/art/README.md`; no two neighbours may share one.

- [ ] T13 Inner anatomy layer [opus]
  - Acceptance:
    - An inner layer inside the body (gut line, round fluid chambers, oil droplets, veins, an eye spot), derived only from the genome's anatomy block and drawn as part of the creature's single draw (no extra draw call per creature beyond the existing mesh count; `renderer.info.render.calls` for 20 creatures equals the T12 count). It parallaxes slightly against the shell with the view angle so it reads as inside.
    - Deterministic: the same genome gives the same anatomy (a hash of the anatomy parameters is pinned for five genomes); two different genomes give different anatomy (500 random pairs, no equal hashes); anatomy never changes with time except the gut's slow peristalsis and a heartbeat pulse (amplitude ≤ 10%).
    - The inner parts carry the colour and the shell stays glassy: in a screenshot of a common specimen the shell edge ring is brighter than the body interior, and the interior has at least three distinct hue clusters on a rare specimen and at most two on a common one (decoded pixels, loose bounds).
    - Low preset draws a simple dark core and one chamber, medium three chambers, high the full layer; budgets hold (T27).

- [ ] T14 Materials v2 and rare glints [opus]
  - Acceptance:
    - Materials from genes: glass versus chitin translucency, refraction of the scene behind the body on medium and high (sampling the T2 scene target with a small offset along the normal; low uses plain alpha), wet gloss (tiny specular points along edges and joints), pores and cell texture, small per-creature imperfections (hash-seeded). `materialParams` stays pure and pinned by tests; every new parameter has a range test over 10,000 genomes.
    - Rare glints are rarity-gated: `glintBudget(rarityTier)` gives expected glints per creature of 0 (common), at most 1 (uncommon), at most 3 (rare), at most 8 (exotic); a unit test over 10,000 genomes shows 95% or more of common creatures have no glint at all and the share of creatures with any glint is below 12% in the genesis distribution. Glints vary in shape, hue and size, are deterministic from the genome and time, and never look like screen-wide glitter.
    - Iridescence follows the existing iridescent allele; common bodies are pale silvery-blue with subtle amber, violet, cyan and pink only inside (palette test: mean saturation of the shell below 0.25 for common specimens, inner parts above 0.35).
    - The hurt, dissolve and plate/mouth readability behaviours of `creature.frag.glsl` are kept (existing tests pass).

- [ ] T15 Bioluminescence and dark-zone vision [opus]
  - Acceptance:
    - Luminescent creatures glow in their own hue and light the water around them in the deep and the abyss (a soft additive light, radius from `Glow` stat × body size, cheap: one sprite per luminous creature in an instanced layer, capped at 32 per frame by distance). Pulse genes pulse the light.
    - Dark-zone vision (render only, ADR 0004): below the twilight the visible radius around the player shrinks with depth to a floor of 3 body lengths, extended by the detection ring (antennae, eyes) and by the player's own glow; creatures and food outside it fade to black, except luminous creatures, which stay visible at their glow radius. It hides nothing the sim does: collisions, hazards and feeding are unchanged, and the readability rule holds (a threat within 3 body lengths is always visible).
    - Unit tests: `visibleRadius(depth, stats)` is monotone in depth, never below 3 body lengths, grows with the detection ring and with glow; E2E: in the abyss a luminous remote creature at 12 body lengths is visible and a dark one is not (screenshot luminance at its position), while a dark creature at 2 body lengths is visible.
    - The reduced-motion setting turns pulses into a steady glow.

- [ ] T16 Look pass 1 [opus]
  - Acceptance:
    - Renders the gallery (`npm run gallery -- --pass 1`), commits `docs/art/gallery/pass-1.png` and `pass-1.md` (ADR 0024) with an honest comparison against each of references 02 to 05, then fixes the largest gaps it lists (shape, inner detail, translucency, appendages, palette, glints, lighting) in `src/render`, `src/genome` and the shaders, and re-renders into `pass-1.png` after the fixes. The note records which gaps were fixed and which remain.
    - Every rating in the pass-1 table is no worse than pass 0's, and at least half of the cells that were 3 are now 2 or better (a unit test compares the two tables).
    - All earlier tests stay green; no budget is exceeded.
  - Notes: be critical. A pass is done when its largest gaps are fixed, not when the tests are green.

- [ ] T17 Readability, crispness and the threat outline [opus]
  - Acceptance:
    - Crispness (owner, Playtest v0.2.0): the canvas uses `devicePixelRatio` up to the preset cap, sized from the CSS size so a 960×540 viewport at dpr 2 on high has a 1920×1080 drawing buffer; HUD, labels and the card text are DOM text or SVG, never scaled canvas bitmaps. E2E asserts the buffer size at dpr 1 and 2 (Playwright device scale factor) and that the player's outline gradient at dpr 2 is at least 90% of the theoretical edge sharpness (the 10 to 90% edge width is at most 1.5 CSS pixels).
    - A threat outline by relative size tier: creatures at least one tier above the player get a warm outline, comparable ones a neutral rim and smaller ones none (a unit test over `outlineFor(playerTier, otherTier)`); the outline does not hide anatomy and respects the reduced-motion setting (no pulse).
    - Gameplay parts stay recognisable at the default zoom: mouths, plates and weapons keep a distinct tint and brightness (the T14 behaviour) and a screenshot test of five specimens at default zoom finds the mouth region at least 20% brighter or redder than the body next to it.
    - The mate card, courtship and death screens remain readable over the new look (contrast of text on its panel at least 4.5:1, a computed check on the CSS colours).

- [ ] T18 Progression pace and visible growth
  - Acceptance (unit tests first, then the pacing tool):
    - Owner feedback on v0.6.0: growth feels slow, size barely shows, and being bigger should matter. This task retunes the existing growth economy only; kill rewards and size advantage in fights belong to M7 (the M7 outline in `docs/ROADMAP.md` records them).
    - Targets, measured with `npm run sim:pacing` (12 genesis cells, the bot, as the M5 table; the new table goes in DESIGN §5 with the date and commit): median time from hatch to double the starting biomass 2 to 4 min; median time to 60% of the maximum biomass 8 to 14 min; hatch to first mating eligibility stays 14 to 25 min (the maturity gate of 12 min active time still decides; ADR 0022's cooldown is unchanged); at least four zoom steps visible in a life (camera half-height grows by 25% or more per step). The tuning knobs are the globule and detritus energy values, the conversion rate and the growth cap, all in `RULES`, and the PR states the old and new values and why.
    - A growth cue: a soft swell and a "Grew to X µm" tick in the HUD every time biomass crosses a 25% step since the last cue (at most one per 3 s), and a progress meter in the HUD, "Size 62% of adult · Mature in 4:10", from the existing life clock and biomass fraction (`progressText(life, biomass, maxBiomass)` pure, pinned by tests for young, grown-but-young, old-enough-but-small and mature).
    - Any change to an outcome regenerates goldens under rules version 6 and says so.
  - Notes: update DESIGN §4 (growth) and §5 (pacing). Do not change the lifespan or mating numbers.

- [ ] T19 The hatch reveal: an egg, not a spinner [opus]
  - Acceptance:
    - Owner feedback: "Awaiting beacon" should feel exciting, like catching a Pokémon or opening a loot box. The wait is real, 3 to 6 s for the drand round, so the sequence is driven by progress and ends on the actual arrival. Stages on the existing screens: a glowing egg wiggles left and right with rising speed and glow (the wiggle starts gentle, then swings wider and adds a flash each swing), sparks and ring pulses, then on arrival a crack, a burst and the creature emerging into its first frame.
    - `hatchSequence(elapsedMs, arrived)` is pure and unit-tested: before arrival it returns stage `wiggle` with intensity rising to a plateau at 3.5 s (never past it, so a slow beacon does not look broken); on arrival it returns `crack` (0.45 s) then `burst` (0.6 s) then `done`; with arrival before 1.2 s of wiggle it still shows at least 1.2 s of wiggle and the whole reveal never delays the play start by more than 1.2 s beyond arrival.
    - The flourish scales with the rarity tier of the hatched genome (known only at arrival, so the reveal is the climax): common = a clean burst, uncommon = a coloured ring, rare = rays and a longer glint, exotic = a full-screen bloom flash (bounded; off under reduced motion, which keeps the crack and burst as a fade). The tier word appears as the burst settles.
    - The same sequence plays for a mating egg when the child's round arrives (the existing egg-crack cue), reusing the stages in the offspring card; resuming a saved creature plays no sequence.
    - E2E (`m6-hatch.spec.ts`): the title-to-hatch path with the fixture hub shows `hatch.stage` from `__bs.state()` going wiggle → crack → burst → done in order, the creature is controllable within 1.2 s of arrival, and a screenshot during `wiggle` is not blank and differs between two moments.

- [ ] T20 Carrying the egg: breeding that feels heavy and rewarding [opus]
  - Acceptance:
    - Owner feedback: after breeding, carrying the egg should be exciting and meaningful, and breeding should take effort and feel rewarding. While a child is pending, the parent visibly carries a small egg that trails behind it on a short tether (a spring toward the tail, bobbing with the gait, glowing with the child's rarity tint and a slow heartbeat); it is drawn for the owner and for remotes who can see the creature. The egg is presentation only: the sim and the records are unchanged.
    - The cost lands visibly: at the commitment the energy bar chunk drops with a flash and the body shrinks with a small ripple; a toast says "Giving X energy and Y size" (existing numbers). At the birth a short sequence plays (T19 stages, shorter) and a card shows the child's body, species, rarity and "Promote with H or keep playing" (existing text).
    - A predator-eats-the-egg mechanic is not built here. The decision it needs (the pending child is a ledger record, so eating the egg must settle through the authority) goes to M7 with the owner's request, recorded in the M7 exit criteria and outline in `docs/ROADMAP.md` (done by the spec PR).
    - Unit tests: `eggTether(parent, dt)` is a stable spring (no divergence over 10 minutes of fixed steps, distance bounded by 3 body lengths); E2E: the pending egg is present in `__bs.state().egg` and in the render info while pending and gone after promotion; a screenshot shows a second small body behind the parent.

### Sound

- [ ] T21 Audio engine, depth ambience and settings [opus]
  - Acceptance (unit tests first):
    - `src/audio/engine.ts` creates one `AudioContext` lazily after the first user gesture (key, click or tap) and resumes it on visibility return; before the gesture no context exists (tested with a fake `AudioContext`). Master gain, an effects bus and an ambience bus, each with volume 0 to 1, and a mute that sets gains to 0 within 50 ms with no clicks (a ramp, tested on the fake param).
    - `synth.ts` has pure parameter builders (`bubblePop`, `thud`, `whoosh`, `chime`, `swell`, `pulse`, `rumble`, `tone`) returning small descriptions (oscillator type, frequency curve, filter, envelope, duration); unit tests pin their durations (every effect under 1.5 s except swells under 3 s), peak gain ≤ 0.5 and determinism (a seed gives the same parameters).
    - Depth ambience: a low filtered-noise bed plus slow tones whose brightness and level follow `zoneLook(depth)`; crossing zones cross-fades over 2 s; a unit test checks the ambience parameters are continuous in depth.
    - The settings panel gains master, effects and ambience volume sliders and a mute toggle, stored in the settings (T1); defaults master 0.6, ambience 0.5, effects 0.8; reduced-motion also lowers the ambience's slow swell depth. The tab hidden → ambience paused.
    - `__bs.audio()` reports `{ state, master, muted, bus levels, played: last 50 effect names }` for E2E. E2E: no `AudioContext` before a key press, one after; mute drops the reported levels to 0; the sliders persist across reload.
  - Notes: no audio files; everything is synthesised. Autoplay rules differ per browser, so the engine must never throw when the context is blocked.

- [ ] T22 Event sounds for every cue
  - Acceptance:
    - Every row of DESIGN §10's audio column plays through `events.ts` from the same `StepEvent`/UI events that drive the visuals: eat (soft bubble pop, pitch varies with food kind), damage (dull hit, level with damage), low energy (slow low pulse below 20%), hazard near (rumble that rises with proximity), dash (whoosh), death (descending tone), old age (slow low swell at 85%), court/accept/mate commitment (chime), hatch/birth (bright chime, rarity adds a shimmer), growth step (soft swell), UV and pressure damage (a crackle and a deep groan), plus UI sounds (invitation, toast, wheel select).
    - A table test maps each event name to a synth recipe: no event of the sim or UI event unions lacks one (the test enumerates the unions' names), and an unknown event is a no-op, not a throw.
    - Limits: at most 8 simultaneous voices (the oldest low-priority voice is stolen), the same effect at most once per 80 ms, and eat pops are throttled to 6 per second; a pure scheduler is unit-tested with fake time.
    - E2E: eating, dashing and taking toxin damage each append the right name to `__bs.audio().played` within 200 ms; with mute on, nothing is appended as audible but the names are still logged as `muted`.
  - Notes: `.claude/rules/game.md` already says every damage source has a cue "audible from M6"; keep it true.

### Social

- [ ] T23 Quick social wheel (#89) [opus]
  - Acceptance:
    - Holding `G` opens a radial wheel at the cursor with 10 slots (4 pings and 6 emotes, each with its icon and a number 1 to 0); releasing over a slot sends it; releasing in the dead centre or pressing Esc cancels; a quick tap of `G` (under 180 ms) repeats the last choice, or opens the wheel if none yet. Number keys 1 to 0 pick a slot while the wheel is open. The old random `G` pick is gone. Chat's `T` then digit path keeps working.
    - Pings are sent at the cursor's world position (look, danger, food, mate); emotes show on the creature (existing rules: 4 s pings, 1 ping per second). The wheel works with the mouse only, with the keyboard only, and is laid out so touch can drive it later (slots at least 48 px).
    - `wheelSlot(dx, dy, count)` is pure: the dead zone is 20 px, slots are equal angles starting at the top and clockwise, boundaries are pinned for 10 slots; unit tests cover the tap/hold timing with fake time.
    - E2E: hold `G`, move to the "danger" slot and release → the remote context receives a `ping` event with kind danger at the cursor world position; tap `G` again → the same ping; `G` held and Esc → nothing sent.
  - Notes: closes the control half of #89; the icons come in T26 and the arrows in T24.

- [ ] T24 Edge arrows, and finding other players [opus]
  - Acceptance:
    - Owner feedback: finding other players is very hard. Players already in the pond (≤24) are known from snapshots, so this is client-only. Off-screen pings within 6 screen-heights show an edge arrow at the screen border pointing to them, tinted by kind and fading as the 4 s ping ends. Off-screen mate-eligible players (by the existing `pairRefusal`/`ownRefusal` data the client holds) within the pond show a small chevron with the distance in body lengths; at most 4 chevrons at once, nearest first; smaller and larger-tier players do not get chevrons by default.
    - `edgeMarker(playerPos, targetPos, viewHalfW, viewHalfH, margin)` is pure: returns the point on the margin-inset rectangle along the ray and the angle; unit tests pin the four edges, the corners, a target inside the view (returns null) and a target at the player's position (null).
    - Markers never overlap the HUD panels (they are inset by the HUD's measured safe area), and respect reduced motion (no pulse).
    - E2E: two contexts in one pond; far apart, the first sees a chevron toward the second (`__bs.state().markers`) and its angle points within 5 degrees of the true bearing; a ping from the second shows an arrow that disappears after 4 s; a creature in view shows neither.
  - Notes: the pond map in T25 completes "finding players".

- [ ] T25 Pond map [opus]
  - Acceptance:
    - `M` toggles a pond map (default on, small, bottom-right; larger when held with Shift) showing the pond bounds, the player and every other player as dots (colour by relative size tier, ring for mate-eligible, a bright tick for a recent ping), the depth zones as faint bands from `depthAt` (sampled once per pond seed on a 64×64 grid into an offscreen canvas) and plumes as dark dots. It updates at 10 Hz. It shows only what the client already knows.
    - `mapPoint(world, pond, size)` is pure with tests for the corners and centre; the zone grid is deterministic from the seed (a hash of the grid is pinned for two seeds).
    - Clicking the map pings "look" at that place (using T23's ping path); the map is a DOM canvas element sized in CSS pixels and crisp at dpr 2.
    - E2E: with two contexts the map shows two dots (`__bs.state().map.dots` length 2), toggling `M` hides it, and the other player's dot moves when they swim.

- [ ] T26 Production-quality emote and ping icons [opus]
  - Acceptance:
    - The six emotes (wave, happy, love, angry, scared, question) and four pings (look, danger, food, mate) are redrawn as SVG icons in one style: 48×48 grid, a 2 px stroke with soft fills, a shared palette matching the HUD, a luminous edge, legible at 24 px. They are inline SVG strings in `src/game/icons.ts` (no files, no new dependency), used by the wheel, the chat bubbles, the ping markers and the map.
    - A test renders each icon at 24 px and 48 px in Chromium (E2E, `m6-icons.spec.ts`) and checks it is non-blank, within the bounds, distinct from every other icon (mean pixel difference above a threshold), and that the stroke colour contrast against the HUD panel is at least 3:1. Unit tests check each SVG is valid (parsed with `DOMParser`) and uses no external references.
    - An icon contact sheet is added to `docs/art/gallery/icons.png` for the owner (generated by the same test).
  - Notes: closes #89 when T23, T24, T25 and T26 are all ticked (the milestone step closes it after the owner accepts).

### Performance and budgets

- [ ] T27 Budgets, allocations and the per-preset report [opus]
  - Acceptance:
    - `tests/e2e/m6-budget.spec.ts` runs a fixed scene (a pond of 12 creatures in the twilight, one in the shallows with caustics, one in the abyss with luminous creatures) on each preset and checks `renderer.info`: draw calls and triangles within the preset budget (80/150k, 150/300k, 250/600k), render-target bytes within the preset's budget (listed in `presets.ts`), geometries and textures not growing across 60 s of play.
    - No per-frame allocations: a Chromium CDP check (`HeapProfiler.collectGarbage`, then `Performance.getMetrics` `JSHeapUsedSize`) before and after 600 rendered frames in the fixed scene grows by less than 2 MB on every preset; the render loop's scratch objects are named in the test so a failure is easy to read.
    - `npm run report:budget` prints a table of measured draw calls, triangles, target bytes and texture counts per preset and writes one screenshot per preset into `docs/art/gallery/budget-<preset>.png` (small, 960×540, JPEG at 80% if needed); DESIGN §12 gets a "Measured" column with the date and commit.
    - Mesh and shader compile on first use do not stall: building the 36 gallery meshes costs under 250 ms of main-thread time per mesh on the CI runner (a loose bound, to catch regressions), and meshes are cached by genome hash (existing).
  - Notes: CI is software-rendered; frame rate is never asserted. 60 fps at the default preset is an `(owner)` check.

### Closing

- [ ] T28 Look pass 2 and 3 [opus]
  - Acceptance:
    - Pass 2: re-render the gallery after T17 and T18's changes (`--pass 2`), commit the sheet and the honest table, fix the largest gaps, re-render. Pass 3: after T27, repeat, and keep going until no cell in the table is above 1 (extra passes are numbered 4, 5, … and each is committed). The final note also records in one paragraph how the common, uncommon, rare and exotic specimens compare with the references and what the remaining differences are.
    - The final pass table has no cell above 1; the unit test that compares tables shows no cell got worse than the previous pass without a stated reason in its sentence.
    - `docs/art/README.md` links the gallery folder and says how the passes are numbered; older sheets other than pass 0 and the last two may be deleted to keep the repository small (pass 0 is kept as the baseline).
  - Notes: this is a task for patient, critical work. If a gap needs a new body-plan feature, add it here and extend the gallery with a new specimen file (ADR 0024).

- [ ] T29 End-to-end scenario, owner checks and documentation sync
  - Acceptance:
    - `tests/e2e/m6-lifecycle.spec.ts` (`@slow` if over 20 s): see the end-to-end check below.
    - DESIGN.md is synced: §2 (zones, hazards and food), §3 (G wheel, M map), §4 (causes, growth, tolerances), §5 (new pacing table), §6 (body plan v2, anatomy, glints), §9 (wheel, markers, map), §10 (audio column marked as shipped), §12 (presets with measured numbers and the adaptive and benchmark rules). `.claude/rules/render.md`, `game.md`, `tests.md` and `docs/SETUP.md` are updated for the new hooks (`__bs.render()`, `__bs.audio()`, `__bs.state().markers`, `.map`, `.hatch`, `.egg`), the `?quality` parameter, the gallery commands and the audio rule (no files).
    - `docs/ROADMAP.md` keeps the M7 criteria for the owner's v0.6.0 feedback (kills as the main way to grow, size as an advantage, predators eating eggs); check they are still there and update them with anything the M6 playtest changes.
    - The Playtest issue text for v0.7.0 (written by the milestone step) lists the `(owner)` checks below; this task lists them in the PR body so the milestone step can copy them.
  - Notes: this task adds the long scenario and the sync only; do not move work from earlier tasks here.

## End-to-end check

Against the fixture authority (`wrangler dev --e2e`, scaled hooks, no live drand) and `?quality=medium`:

1. Start the game: the hatch reveal plays (wiggle → crack → burst → done) and the creature is controllable; the settings panel switches presets live; no `AudioContext` exists until the first key press.
2. Swim from the twilight into the shallows: the gauge says "Sunlit shallows" and the screenshot is brighter; a cell with tolerance 0 takes UV damage and the HUD cue shows; a forced death names "Burned by sunlight" and a sound named `death` is logged. The same in the abyss with pressure.
3. In the abyss a luminous remote is visible at distance and a dark one is not; a dark one at 2 body lengths is.
4. Two identities in one pond: the first sees a chevron and the map dot toward the second; the second holds `G`, picks danger and releases; the first sees the ping arrow for 4 s and hears the `ping` cue. They court and mate; the parent carries an egg; the birth sequence plays; the child promotes.
5. The gallery tool renders twice with identical bytes; the committed pass tables parse; `m6-budget` holds on all three presets with no heap growth over 600 frames.

Exit criteria map: "creature look overhaul to the owner's references (#90)" T5, T10 to T17, T28; "art pass to the reference (DOF, caustics, membranes, bioluminescence by depth)" T2, T3, T9, T14, T15; "depth zones with gameplay" T6 to T8; "low, medium and high presets with budgets" T1 to T4, T27; "procedural sound" T21, T22; "deliberate pings and emotes (#89)" T23 to T26; "(owner) creatures hold up next to the references" the rubric and the Playtest issue; "(owner) 60 fps at the default preset" the Playtest issue; readability and crispness T17; the v0.6.0 owner feedback T18 to T20, T24, T25 and the M7 note in T29; no per-frame allocations and the budget report T27; the end-to-end check T29.

## Rubric

- [ ] Creatures are diverse at a glance: no two neighbours in the gallery share a silhouette, and the twelve v2 specimens' pairwise silhouette overlap is below 0.8 (evidence: the gallery sheet and the IoU test).
- [ ] Creatures read as glass-like top-down micro-organisms with visible inner organs, fine antennae and setae, wet gloss and a luminous rim (evidence: the final pass sheet and its table with no cell above 1).
- [ ] Glints are rare: under 12% of genesis creatures show any, and common bodies show none (evidence: the T14 distribution test and the sheet).
- [ ] The zones are distinct at a glance and the hazards are never silent (evidence: the four-stop screenshot set in the E2E, the luminance steps, the cue tests).
- [ ] Dark-zone vision never hides a nearby threat (evidence: the T15 unit and E2E tests at 2 body lengths).
- [ ] Every preset stays inside its budget with no heap growth (evidence: `m6-budget` and `npm run report:budget`).
- [ ] Every cue in DESIGN §10 has a sound and mute silences all of them (evidence: the event table test and the E2E).
- [ ] Pings and emotes take one held key and a release; off-screen pings and mate-eligible players are findable in under 5 s with the map and chevrons (evidence: the E2E bearings and dot assertions).
- [ ] The text and cards stay readable and crisp over the new look at 960×540 and at dpr 2 (evidence: the contrast and edge-width checks).
- [ ] (owner) Creatures hold up next to the references in #90: diversity, translucency, inner detail, fine appendages, palette, rare glints and lighting. Close #90 when you accept it.
- [ ] (owner) 60 fps at the default preset on the player's hardware, and the automatic preset picks a sensible one.
- [ ] (owner) The hatch reveal feels like opening a loot box without dragging, and carrying an egg feels meaningful.
- [ ] (owner) Finding other players is now easy, and progression feels brisk with growth you can see.
- [ ] (owner) The sound fits the world and is never annoying after an hour; the ambience in the deep feels like a different place.

## Risks

- The look is subjective and the factory cannot see like the owner → ADR 0024: a fixed committed gallery, an honest per-reference table, at least three passes and an `(owner)` gate; the owner's reply drives the next passes.
- Karyotype v2 invalidates live creatures or old records → zero-default appended loci, v1 genomes pad to the same body, v1 records verify under their rules version, and ADR 0025 says what changes (T10); the M3 and M5 goldens stay.
- Software rendering in CI is slow and the post chain makes the E2E suite long → the PR suite runs the chain on one preset, the full budget scene is `@slow` if over 20 s, and tests set `?quality`.
- Fine detail (setae, veins, inner layers) blows the triangle or draw-call budget → separate per-preset detail budgets, an extra-triangle cap per creature, LODs that keep the silhouette, and `m6-budget` as the guard.
- A rules bump changes live behaviour (zones, hazards, growth) → one bump (version 6) in T6, goldens regenerated in the PRs that change outcomes, DESIGN synced, the authority unchanged (it clamps progress, ADR 0008); the pacing tool measures growth before and after (T18).
- Zone hazards make the game unfair (spawn in the shallows, UV with tolerance 0) → spawn only in the twilight or deep, tolerance medians pinned, damage rates from DESIGN, and the owner playtest.
- Dark-zone vision hides threats → render only, a floor of 3 body lengths, a test at 2 body lengths.
- Audio is blocked or crackles on some browsers → one lazy context after a gesture, ramped gains, a voice cap, and the engine never throws; sound quality is an `(owner)` check.
- The wheel conflicts with chat or movement keys → `G` is held, WASD and Space are untouched, and the wheel closes on blur and Esc (tested).
- The gallery sheets grow the repository → a size cap of about 1.5 MB, only pass 0 and the last two sheets are kept at the milestone step.
- T28 never converges → the loop continues in numbered passes; the PR for each pass is still one step. If a task has failed across three runs the plan changes (split or simplify) with an ADR, per `/next`.
