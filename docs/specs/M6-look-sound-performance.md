# M6: Look, sound and performance

Release: v0.7.0 · Gate: yes

## Goal

Biosphere looks like the owner's references and plays better while doing it.

- **Creatures** are glassy micro-organisms seen from above. They have visible organs inside a clear shell, hair-thin antennae and setae, jointed legs, claws, veined wings and fan tails. Their silhouettes range from round larvae and tadpoles to copepods, shrimp, curled worms, crabs, jellyfish bells and winged plankton. Genesis cells are small larvae, and breeding carries a lineage towards the complex forms. Rare creatures glint; common ones stay crystal-clear and silvery.
- **The water** has depth. Bright, caustic shallows burn with UV, a calmer blue twilight surrounds the spawn, the deep is lit mostly by bioluminescence, and the abyss crushes creatures without pressure tolerance.
- **The camera** looks like macro photography: shallow depth of field, a luminous rim on every body, restrained bloom and a graded image. Three presets keep it within budget, and the default runs at 60 fps on a mid-range laptop with integrated graphics (owner check).
- **The game sounds alive**: procedural ambience by depth and a cue for every event, with volume, mute and reduced-motion settings.
- **The owner's v0.6.0 feedback is in.**
  - Growth is visible and faster.
  - Other players are easy to find: edge indicators and a pond map.
  - Waiting for a beacon is an exciting egg reveal.
  - A carried egg shows on the parent for everyone to see.
- **Pings and emotes** are chosen on purpose from a wheel or hotkeys, with production-quality icons and edge arrows for nearby off-screen pings (#89).

ADR 0004 is the rendering contract, ADR 0024 the look-pass method, ADR 0025 body plan v2 and ADR 0014 the pillars (zones, procedural audio).

This milestone is a **gate**: after v0.7.0 the factory waits for the owner's reply on the `Playtest: v0.7.0` issue. The owner judges the creatures against the references (#90) before M7 starts.

## Out of scope

- **Combat**: killing as the main way to grow, size as a fighting advantage, and predators eating eggs. An egg incubation period that makes carrying an egg risky belongs with predation (ROADMAP M7, from Playtest v0.6.0). M6 draws the carried egg and its reveal only.
- **Touch and mobile controls.** The social wheel is laid out so it can take touch later, but M6 ships mouse and keyboard only.
- **One continuous world, AoI and habitats** (M11, M12). Zones live inside today's 8,192 wu pond world.
- **New food kinds and carrion** (M7). Zones re-weight the three existing kinds and move vents.
- **Recorded audio files and music tracks.** Sound is procedural Web Audio only (ADR 0014).
- **WebGPU, `three/webgpu`, TSL** and post-processing libraries as hard dependencies (ADR 0004).
- **Shareable creature cards and the lineage viewer polish** (M9). The inspect card only picks up the new look.

## Touches

New:
- render and post: `src/render/post/` (chain, passes, `dof.ts`, `adaptive.ts`, `benchmark.ts`), `src/render/anatomy.ts`, `src/render/zones.ts`, `src/render/egg.ts`, `src/render/indicators.ts`;
- shaders: `src/render/shaders/{post,bloom,dof,caustics,godrays,anatomy,egg}.glsl`;
- sim and genome: `src/sim/bathymetry.ts`, `src/genome/silhouette.ts`, `src/genome/karyotype-v1.ts` (the frozen v1 table);
- audio: `src/audio/` (`engine.ts`, `ambience.ts`, `cues.ts`, `voices.ts`);
- game UI: `src/game/wheel.ts`, `src/game/pond-map.ts`, `src/game/icons.ts`;
- lab and tools: `src/lab/gallery.ts`, `tools/gallery.mjs`, `tools/specimen.ts`, `tools/budget-report.mjs`;
- data and docs: `tests/fixtures/gallery/`, `docs/art/gallery/`, `docs/perf/`;
- tests: `tests/e2e/m6-*.spec.ts`.

Changed:
- render: `src/render/{scene,camera,creature-mesh,creature-cache,materials,material-params,gait,particles,water,food,hazards,remotes,effects}.ts`, the creature and water shaders;
- genome: `src/genome/{karyotype,codec,express,develop,stats,genesis,inherit,offspring,rarity,names,describe}.ts`;
- sim and ledger: `src/sim/{rules,body,food,hazards,spawn,vitals,step,types}.ts`, `src/ledger/mating.ts` (rules-versioned recomputation);
- net: `src/net/protocol.ts` (genome size cap, the egg flag);
- worker: `worker/authority.ts` (rules version 6, maturity numbers);
- game: `src/game/{app,hud,screens,settings,settings-panel,social,social-ui,input,offspring,life,debug}.ts`;
- lab: `src/lab/*`;
- config and docs: `playwright.config.ts`, `package.json` (scripts `gallery`, `report:budget`), `docs/DESIGN.md` §2–§6, §9, §10, §12.

Presets (DESIGN §12, `src/render/presets.ts`; T1 pins them):

| Preset | Pixel ratio | Post-processing | Particles | Budget (draw calls / triangles) |
|--------|-------------|-----------------|-----------|---------------------------------|
| Low | 1 | none (fake bokeh sprites only) | 30% | 80 / 150k |
| Medium (default) | up to 1.5 | half-res DOF, bloom, grade | 100% | 150 / 300k |
| High | up to 2 | full DOF, bloom, chromatic aberration, grain | 150% | 250 / 600k |

Creature vertex budgets per preset (ADR 0025, render only): high 12,000, medium 6,000, low 1,500.

Interfaces (shapes may be refined in a task note, with the reason):

```ts
// src/render/post/chain.ts
export interface PostInfo { passes: string[]; targets: number; targetBytes: number; renderScale: number }
export class PostChain {
  constructor(renderer: THREE.WebGLRenderer);
  setPreset(preset: PresetName): void;          // turns passes on and off, sizes targets; low = direct render
  setRenderScale(scale: number): void;          // 0.5..1, adaptive resolution (T4)
  setFocus(z: number): void;                    // the focus plane for DOF (T3)
  render(scene: THREE.Scene, camera: THREE.Camera): void;
  info(): PostInfo;
  dispose(): void;
}

// src/sim/bathymetry.ts (sim math only, deterministic)
export type Zone = 'shallows' | 'twilight' | 'deep' | 'abyss';
export function depthAt(seed: number, x: number, y: number): number;   // 0 (surface) .. 1 (abyss floor)
export function zoneAt(seed: number, x: number, y: number): Zone;

// src/genome/silhouette.ts (tests, Lab, gallery, reports; never stats or the sim)
export type Silhouette = 'cell' | 'ciliate' | 'spiny-larva' | 'bell' | 'tadpole' | 'copepod' | 'shrimp'
  | 'worm' | 'coil' | 'crab' | 'winged' | 'fan-tail' | 'other';
export function silhouetteOf(plan: BodyPlan): Silhouette;

// src/audio/engine.ts
export type Cue = 'eat' | 'hurt' | 'low-energy' | 'hazard-near' | 'dash' | 'death' | 'old-age' | 'court' | 'mate'
  | 'hatch' | 'reveal' | 'grow' | 'tier' | 'ping' | 'emote' | 'chat' | 'uv' | 'pressure';
export interface Sound { cue(c: Cue, at?: { x: number; y: number }): void; setZone(z: Zone, depth: number): void;
  setVolume(v: number): void; setMuted(m: boolean): void; dispose(): void }
```

Hub E2E: each new M6 spec file that needs the authority gets its own `wrangler dev` port from 8797 on (`playwright.config.ts`, `.claude/rules/tests.md`), because files run in parallel.

`window.__bs` additions (documented in `.claude/rules/tests.md` by the task that adds them):
- `render.info()` gains `passes`, `targets`, `targetBytes`, `renderScale`, `vertices` (the player body's) and `lod`.
- `state()` gains:
  - `zone` and `depth`;
  - `audio`: `{ state, cues }`, where `cues` counts per cue since hatching;
  - `indicators`: what the edge markers point at;
  - `wheel`: `{ open, items }`;
  - `egg`: `{ phase, carried }`;
  - `growth`: `{ share, matureInMs }`.
- Under `?debug=1`, `debug` gains `setZone`, `setBench(ms)` and `revealNow()`.

## Tasks

The tasks run in layers:
- render foundations: T1 to T5;
- the creature overhaul: T6 to T14 (the centrepiece; genome first, because the silhouette is decided in development);
- the world in depth: T15 to T17;
- the owner's v0.6.0 feedback: T18 to T20;
- readability: T21;
- sound: T22, T23;
- social (#89): T24, T25;
- performance: T26;
- closing: T27 to T29.

A look pass never starts before the tasks it judges are ticked.

### Render foundations

- [x] T1 Render settings and presets [opus]
  - Acceptance (unit tests first):
    - `PRESETS` equals the table above and DESIGN §12 (a test pins every number). `resolvePreset(setting, detected)` returns the setting unless it is `auto`, then the detected preset (`medium` until T5 detects). `pixelRatio(preset, devicePixelRatio)` is `min(dpr, preset max)`, at least 1.
    - `loadSettings()` reads `localStorage['bs.settings']`: invalid JSON, wrong types, unknown preset names and a throwing `localStorage` all give the defaults (`quality: 'auto'`); `saveSettings` swallows a throwing store. `?quality=low|medium|high` in the URL beats the stored value without writing it (E2E and tests use it).
    - E2E (`m6-presets.spec.ts`): `?quality=low` and `?quality=high` start the game with `__bs.render().preset` set; the settings panel in the Esc menu switches preset at runtime and the pixel ratio, particle count and `renderer.info.render.calls` follow without a reload; the choice survives a reload; with `localStorage` blocked the game still runs.
  - Done: `render/presets.ts`, `game/settings.ts`, `SettingsPanel` (title and the Esc lineage panel link to it); `GameScene.setPreset` sets ratio and particle share (a draw range over a 150% buffer, no rebuild). `render.info()` gains `preset`, `pixelRatio`, `particles`.
  - Gotcha: the hook is `__bs.render.info()` (not `render()`, later tasks read it there too), and the draw-call count cannot differ by preset before the post chain (T2), so the E2E asserts calls stay within the preset budget and particles and pixel ratio follow.
  - Notes: this task owns the settings panel shell (quality now; T21 adds volume and T9 reduced motion reuse it). Particle counts scale with the preset in `ParticleLayer`. Presets only change presentation: nothing in `src/sim` reads them.
  - Rewrite note: T1 was built from the first M6 spec. In this spec, auto-detect is T4, volume is T22 and reduced motion is T22; the panel shell is unchanged.

- [ ] T2 Post chain: scene target, bloom, grade, vignette, grain, chromatic aberration [opus]
  - Acceptance (unit tests first, then E2E):
    - `postPlan(preset)` (pure) lists the passes and target scales:
      - low: `[]` (direct render to the canvas);
      - medium: `['scene', 'bloom', 'grade', 'vignette']`, with bloom at half resolution and 4 mip levels;
      - high: those plus `'grain'` and `'chromatic'`, with bloom at 5 levels.
      A test pins each list. DOF joins the list in T3.
    - `PostChain` renders the scene into a half-float target, then:
      - bloom: threshold, dual-filter down and up, added back;
      - grade: a filmic tone curve and a cool teal lift in the shadows, with highlights kept neutral;
      - vignette, film grain and radial chromatic aberration on the composite.
      Every target is disposed on `setPreset`, `resize` and `dispose`; `renderer.info.memory.textures` returns to its old count after a preset round trip.
    - E2E (`m6-post.spec.ts`, a pinned genome, `?quality=…`):
      - `render.info().passes` matches `postPlan`, and `calls` and `triangles` stay within the preset budget;
      - in decoded screenshots, at medium the four corner patches are at least 10% darker than the centre patch (vignette), and a bright food item has a halo: the ring 3–6 px around it is at least 8 luminance levels brighter than at low (bloom);
      - at high, the red and blue channel edges of a bright item are offset by at least 1 px near the frame edge (chromatic aberration);
      - low renders with no target (`targets: 0`).
    - The Creature Lab draws through the same chain (high preset), so the gallery (T5) shows the real look.
  - Notes:
    - Render order stays as in `scene.ts`; the DOM HUD is never post-processed.
    - The grade must keep the dark teal water of `reference-01.jpg`; check it against the reference by eye before ticking.
    - Use `THREE.WebGLRenderTarget` with `HalfFloatType`, falling back to `UnsignedByteType` when half float is not renderable, and check that path.
    - Allocate nothing per frame (uniform objects and full-screen triangles are reused).

- [ ] T3 Depth of field [opus]
  - Acceptance:
    - `circleOfConfusion(z, focusZ, preset)` (pure) is 0 at the focus plane and grows linearly with distance, up to a cap: 6 px at half resolution on medium, 12 px at full resolution on high. Its tests pin the curve.
    - The focus plane follows the player's creature at the gameplay plane. Creatures, food and plumes on the plane stay sharp. The far and near particle layers are blurred by their depth into round bokeh discs; on high, bright discs get a chromatic fringe.
    - E2E (`m6-dof.spec.ts`), measured on decoded screenshots:
      - at medium and high, the player creature's edge contrast is within 10% of low's (it stays sharp);
      - a near-layer particle's footprint is at least 3× wider than at low;
      - `render.info().passes` contains `'dof'` (half on medium, full on high).
    - Low keeps today's fake bokeh sprites and adds no pass.
  - Notes: ADR 0004 asks for CoC from depth. Gameplay is a plane with known layer depths, so a layered gather (blur the off-plane layers by their CoC) satisfies it at a fraction of the cost of a full-screen depth gather. Record the choice in the task note.

- [ ] T4 Auto-detect and adaptive resolution [opus]
  - Acceptance (unit tests first, on synthetic frame times):
    - `pickPreset(frameTimesMs)` takes the 75th percentile of a 2 s benchmark at medium and maps it: up to 11 ms → high, up to 20 ms → medium, otherwise low. The result is stored per GPU (`bs.bench` keyed by the unmasked renderer string when available), so another machine benchmarks again. `auto` in Settings shows "Auto (Medium)" with the detected preset.
    - `AdaptiveScale` steps the render scale between 0.6 and 1.0 by 0.1:
      - down when the 90th-percentile frame time over the last 2 s exceeds 1.25 × 16.7 ms;
      - up when it stays below 0.8 × 16.7 ms for 5 s;
      - never more than one step per 2 s, so it never oscillates (a test feeds alternating loads).
      The HUD and the DOM are never scaled.
    - E2E (`m6-auto.spec.ts`): `?debug=1` with `debug.setBench(8)`, `(15)` and `(30)` picks high, medium and low, and the stored choice skips the benchmark on reload. A forced slow frame budget (`setBench`) steps `render.info().renderScale` down, and a later fast budget steps it back up.
  - Notes: the benchmark runs behind the title screen while it is shown, never during play. `?quality=` skips it (tests).

- [ ] T5 Gallery tool and the baseline pass [opus]
  - Acceptance (as ADR 0024 decides):
    - `lab.html?gallery=1` draws the specimens from `tests/fixtures/gallery/*.hex` with:
      - a fixed camera, a 1600×1000 viewport at pixel ratio 1 and the high preset;
      - a fixed animation time (`debug.pause`, `advance`) and the dark-water backdrop;
      - specimens in file-name order, in a grid sized to fit them all (8×4 for the 32 of T9).
    - `npm run gallery -- --pass <n>` renders it with the shared Chromium to `docs/art/gallery/pass-<n>.png`. Two captures from one build are byte-identical (a test captures twice).
    - The baseline set has 20 v1 specimens: 6 genesis cells and 14 picks from the Lab's wild mode and bred children. They are chosen to show the most varied v1 bodies and stored as hex with a one-line comment each. They are never re-drawn from seeds.
    - `docs/art/gallery/pass-0.png` and `pass-0.md` are committed. The note holds the ADR 0024 gap table: aspects × references 02–05, each cell 0–3 with a sentence. It is honest: the baseline is expected to score mostly 3. A "Largest gaps" list follows, which T6–T13 address.
    - A unit test parses every `pass-*.md` and fails on a missing cell, a value outside 0–3 or a missing "Largest gaps" list.
  - Notes: open each reference image and the sheet side by side before writing the table; never score from memory. Specimens added later extend the set and never replace one (ADR 0024).

### Creature overhaul (#90)

- [ ] T6 Karyotype v2 and rules version 6 [opus]
  - Acceptance (unit tests first):
    - `KARYOTYPE_VERSION` is 2. The v1 table lives on in `karyotype-v1.ts`. The v2 layout appends to each haplotype:
      - the new body loci of ADR 0025: spine curve amount and mode, head scale, trunk swell, tail length, tail taper, fusion, symmetry, drape, eye size, eye stalk;
      - per module slot: webbing, setae density, setae length, bulb, chela, beads.
      The v1 bytes are untouched. DESIGN §6 gets the v2 table.
    - Decoding is total for any length. A 328-byte v1 genome decodes with every new locus 0, and its traits equal the v1 traits field by field. This is a property over 10,000 random v1 genomes.
    - `genomeHash` hashes a genome's own canonical bytes at its own length. A v1 genome keeps its hash (golden), and `upgrade(v1)` pads it to v2 with a different, stable hash.
    - Expression maps every new locus onto its range, with 0 meaning "off" or "v1": no curl, bilateral, no fusion, no eyes, no webbing, no setae.
    - Rules versions:
      - `RULES_VERSION` is 6, and every sim and genome golden is regenerated (the PR lists which and says the hashes changed for the version only).
      - `offspringPair` and `checkBirth` take the rules version from the record: v5 birth goldens (M5 T4) still verify through the v1 path, and v6 births pad v1 parents before meiosis.
      - Mutation under v6 can touch the new loci.
    - The worker accepts v2 genomes:
      - the genesis and birth paths write v2;
      - a v1 creature resumes unchanged;
      - `net/protocol.ts` raises the genome event cap to the v2 size;
      - the Lab's paste box takes both lengths.
  - Notes: this task changes no body: the new loci are expressed but unused until T7 and T8. Keep the v1 decoder and v5 inheritance callable for M9; mark them `frozen`.

- [ ] T7 Development v2: body (curve, tagmata, fusion, symmetry, eyes) [opus]
  - Acceptance (unit tests first):
    - **v1 equivalence**: a plan developed from all-zero new loci equals the v5 plan, and its stats equal v5's. This is checked over 10,000 random v1 genomes, except bodies whose v5 plan dropped parts for the vertex budget. The test counts them and reports the share; it must stay under 2%.
    - **Spine curve**: the segment chain bends along a curve with total turn `curve × π` (C-mode), as two opposite arcs (S-mode), or as a coil (a spiral that tightens) above 0.8. Segments keep overlapping neighbours, and colliders follow the curve.
    - **Tagmata**: head scale enlarges the first segment, trunk swell the middle, and tail length and taper set the rear. Tests pin each extreme's segment radii.
    - **Fusion**: the front `round(fusion × segments)` segments get one carapace outline (an ellipse hull over them) that colliders and plates use. The segments inside stay in the plan for the gut and joints.
    - **Symmetry**: at symmetry ≥ 0.5 the body becomes round (aspect towards 1), and appendages are placed radially at even angles around the outline. With drape > 0 they bend rearward and trail (tentacles). A radial body has no mouth offset (the mouth is central).
    - **Eyes**: size above 0.15 gives a pair on the head segment, with an eye stalk length. They are plan data for rendering and the detection ring.
    - **Caps and repair hold** over 10,000 random and 10,000 mutated v2 genomes: no throw, caps, bounds within 2.5, a propulsion source, a mouth, and colliders 1–12. `bodyViolations` gains checks for the new fields.
    - `silhouetteOf(plan)` classifies by geometry only: segment count, curve, symmetry, fusion, tail and webbing share, appendage reach. Hand-built plans for each class are classified correctly, and the classifier is total (`other` is allowed).
    - **Stats** follow form, as ADR 0025 lists. Curl lowers turning inertia and raises drag. A carapace adds armour coverage and mass. Radial symmetry raises turning and lowers forward thrust efficiency. Eyes add detection and metabolism. The archetype tests gain a radial, a coiled and a carapaced archetype, and none is best at everything.
    - The development vertex rule is gone under v6: parts are capped by count only (ADR 0025). `estimateVertices` moves to `src/render`.
  - Notes: the Lab inspector shows the silhouette name. Update DESIGN §6 (development, stats).

- [ ] T8 Development v2: fine parts (webbing, setae, bulbs, claws, beads) [opus]
  - Acceptance (unit tests first):
    - **Webbing**: a part with webbing > 0 gets a membrane spanning to its branches and its neighbouring part on the same side (`webSpan`). A tail fan forms when webbing sits on the rearmost parts. The plan stores membrane polygons in core radii, inside the bounds.
    - **Setae**: density 0–1 gives 0–24 bristles per part, evenly spaced along it, each with length = setae length × part width × 6. The body total is capped at 240, and the excess is dropped from the shortest parts first, deterministically.
    - **Bulbs and beads**: bulb > 0.3 gives a bead tip of radius bulb × width × 2. Beads mark each joint with a swelling.
    - **Chela**: on a hooked or pointed tip, chela > 0.5 gives an opposable last joint. A chela's weapon power counts in `stats.weapons`.
    - **Stats**:
      - webbing area adds paddle thrust (rising with size, like the paddle share), drag and mass;
      - setae add drag, widen the filter mouth's passive arc (by up to 25%) and add to the detection ring;
      - bulbs add contact damage like spines;
      - every feature adds to the basal complexity factor.
      The archetype tests gain a winged and a setose archetype, and none is best at everything.
    - Property tests over 10,000 random and 10,000 mutated genomes: totals within caps, no NaN, and membranes non-degenerate (area > 0, convex or split).
  - Notes: setae and membranes are detail on parts, not parts (ADR 0025). The sim sees them only through `PhysStats`. Update DESIGN §6.

- [ ] T9 Genesis spread, rarity, names and the specimen set
  - Acceptance (unit tests first):
    - **Genesis** (ADR 0025): every genesis plan has one body unit and at most 3 module slots present. Over 1,000 seeds, at least 4 silhouette classes appear and none takes more than 40%. Rare alleles keep their DESIGN frequencies. The median top speed stays within ±15% of v5's (a test pins the band).
    - **Wild variety**: the Lab's wild mode (24 cells) shows at least 8 silhouette classes for 9 of 10 seeds.
    - **Rarity**: new rare features are priced from exact genesis frequencies: coil, radial symmetry, carapace, chela, webbing, eyes. `npm run report:diversity` adds a silhouette histogram.
    - **Names**: species epithets can come from the new traits (for example *alata* for winged, *spiralis* for coil). The names stay deterministic per genome hash.
    - **Specimen set**: `tools/specimen.ts` builds a v2 genome for a target silhouette by deterministic search from a seed. The gallery gains one specimen per silhouette class except `other`: cell, ciliate, spiny larva (the spherical larva of #90), bell (jellyfish-like), tadpole, copepod, shrimp, worm (S-curved), coil (the curled worm and the nautilus coil), crab, winged and fan-tail. That makes 12, each verified by `silhouetteOf`, added after the baseline 20.
  - Notes: DESIGN §6 (genesis, rarity) gets the new numbers. The pacing tool (T18) uses v2 genesis.

- [ ] T10 Creature mesh v2 [opus]
  - Acceptance (unit tests first):
    - The body is a smooth loft along the curved spine: a Catmull-Rom centre line, with ring counts by level of detail. It follows the tagma profile, and a carapace adds a thin outer shell over the fused segments.
    - Appendages are tapered tubes with visible joint beads, curvature, bulb tips and chela pincers.
    - Setae are thin tapered ribbons from the parts. Membranes are triangle sheets with a vein UV, drawn double-sided. Eyes are small lens spheres.
    - **Budgets** (ADR 0025): for every gallery specimen and 10,000 random v2 plans, the vertex count is at most 12,000 on high, 6,000 on medium and 1,500 on low. The builder lowers detail to fit (rings, setae drawn, membrane subdivision) and never drops a part: the appendage count in `aPart` ids equals the plan's on every preset.
    - One merged geometry per creature per LOD, cached by genome hash and preset, and disposed at zero references. Attributes are finite and indices valid. `aAttach` and weights keep every vertex of a part attached to its root, which T11's property test checks.
    - **Screenshots** (`m6-creature-mesh.spec.ts`, gallery specimens at 1600×1000), on decoded images:
      - the crab's legs and the copepod's antennae reach beyond the body hull: bright pixels at more than 1.6 core radii from the centre in at least 6 directions;
      - setae show as at least 20 separate thin bright strokes on the setose specimen;
      - the winged specimen's membranes cover an area at least as large as its body.
    - The player's body at default zoom (960×540) stays within the medium budget, and its rim reads at least 40 luminance levels above the water.
  - Notes: keep one draw call per creature. The inner anatomy (T12) joins the same geometry with its own part kind.

- [ ] T11 Motion v2: flexible bodies [opus]
  - Acceptance (unit tests first, on the CPU reference in `gait.ts`):
    - The travelling wave runs along the curved spine, so a worm undulates and a coil breathes. Legs row in a metachronal wave (phase offset per segment). A radial bell pulses by contracting and recovering, with its tentacles lagging. Wings beat in a slow flap-and-glide cycle.
    - Secondary motion:
      - setae flutter with a small, fast, phase-shifted wiggle;
      - antennae sway with turning and lag behind heading changes by about 0.3 s;
      - when the creature is still, it breathes (a slow idle at 20% amplitude).
    - **No part detaches**: over 10,000 plans at 50 time samples, every appendage vertex's distance to its attach point stays within its rest distance × 1.15. The wave phase is integrated from speed (ADR 0018).
    - E2E: two screenshots 0.25 s apart differ on the moving creature's appendages (a mean absolute difference of at least 2 levels inside its box) and match outside it.
  - Notes: the owner called v1 creatures "rigid". Motion is half of looking alive, so check a short screen capture of each gallery class by eye.

- [ ] T12 Inner anatomy [opus]
  - Acceptance (unit tests first):
    - `anatomyOf(plan, traits, genomeHash)` (render data, deterministic) places organs inside the hull, never outside it:
      - a gut line along the curved spine, with a stomach swelling;
      - fluid chambers and oil droplets: their count grows with body size and metabolism trait, 3–14, at hash-seeded positions without overlap;
      - a heart or ganglion spot;
      - eye pigment.
      A test checks containment for 10,000 plans.
    - **Pigment moves inside**: organs carry the hue gene's colour at the gene's saturation, while the shell stays nearly clear. `materialParams` gives the shell a saturation of at most 0.15 for every genome (a property).
    - The organs are drawn in the creature's merged geometry, inside the shell, with their own part kind. They use at most 20% of each LOD budget.
    - **Screenshots** (gallery): inside each body's hull, the hue variance is at least 3× the shell rim's (colour lives inside), and at least 3 distinct bright blobs show inside each bilateral specimen of size class copepod or larger.
  - Notes: reference 02 and 03 are the bar for how much shows through. Organs are presentation only: nothing in the sim or stats reads `anatomyOf`.

- [ ] T13 Materials v2: glass, wet gloss, surface detail, rare glints [opus]
  - Acceptance (unit tests first):
    - **The shell** is glass:
      - a fresnel rim of at least the `MIN_RIM_LUMINANCE` of today;
      - wet specular from a fixed key light, plus a backlight;
      - on medium and high, a refraction that offsets the water behind the body by the normal (sampled from the scene target, so the post chain renders the backdrop first);
      - on low, plain translucency.
    - **Surface detail**: procedural pores, a cell texture, vein networks on membranes and small hash-based imperfections. All scale with screen size, so they never alias into noise at default zoom; a test pins the fade-out band.
    - **Palette**: shells are silvery pale blue, with up to 15% saturation of the gene hue. Pigment lives in the organs (T12). Iridescence and luminescence alleles still show (thin film, glow).
    - **Rare glints**: `glintsFor(rarity, iridescence)` (pure) gives the count, size and brightness of jewel-like glints:
      - common: 0–1, dim;
      - uncommon: up to 3;
      - rare: up to 8;
      - exotic: up to 16, at reference 04/05 intensity.
      Count and brightness never fall as the tier rises (a test). Positions are hash-seeded on joints and organs.
    - **Screenshots**:
      - over the 32 gallery specimens, the median count of saturated pixels (S > 0.6) on shells is below 5% of the body area;
      - the exotic specimen has at least 8 glint maxima and the common ones at most 2;
      - every specimen's rim stays the brightest ring of its body.
  - Notes: the rule from #90 is "sparkles must feel exceptionally rare". When in doubt, fewer glints.

- [ ] T14 Look pass 1 [opus]
  - Acceptance (ADR 0024):
    - `npm run gallery -- --pass 1` is committed with `pass-1.md`. The gap table is filled honestly against references 02–05 and its "Largest gaps" list is ordered by visual impact.
    - Fix the top gaps in this task, as far as one session allows: shader, mesh, anatomy or palette tuning, but no new mechanics. Re-render, and commit the sheet and table after the fixes.
    - The PR body states which cells improved and which gaps remain for passes 2 and 3.
    - Also check the in-game look: a 960×540 screenshot at default zoom with six different bodies (`debug.setRemotes` with gallery genomes). Note in `pass-1.md` whether the bodies stay readable at that size; detail must never fight the silhouette (`docs/art/README.md`).
  - Notes: never call a pass done because the tests are green.

### The world in depth

- [ ] T15 Rules v6: bathymetry, zones, food and hazards
  - Acceptance (unit tests first, sim math only, deterministic in Node and Chromium):
    - **Bathymetry**: `depthAt(seed, x, y)` is smooth fractal noise on a 2,048 wu period. The zones are shallows below 0.25, twilight up to 0.55, deep up to 0.8 and abyss above that.
      - A disc of 600 wu around the pond's spawn centre is twilight.
      - The nearest shallows and the nearest deep are each at most 1,800 wu from it.
      - Over 20 seeds, the world shares are: shallows 20–30%, twilight 30–40%, deep 20–30%, abyss 5–15%.
      Goldens pin `depthAt` samples.
    - **Food by zone**: a slot's food kind is weighted by its zone, per DESIGN §2: globules in shallows and twilight, vent crystals near vents in deep and abyss. Vents sit in deep and abyss only, and at least 80% of plumes lie in deep and abyss.
    - **Hazards**:
      - UV in the shallows deals `2 × (1 − uvTolerance)` hp/s;
      - pressure in the abyss deals `3 × (1 − pressureTolerance)` hp/s;
      - both ramp in over a 64 wu band at the zone edge;
      - the death causes `uv` and `pressure` are named on the death screen.
      `PhysStats` gains `uvTolerance` and `pressureTolerance`, and the state hash covers them.
    - Spawn stays inside the twilight disc and clear of plumes. The M2 food-claim and pond-clock rules are unchanged.
    - Goldens are regenerated under rules version 6, and the replay determinism E2E passes.
  - Notes: DESIGN §2 and §4 are updated (zones, food, hazards). Plume density changes the early game, so run the pacing tool and record any change in starvation or toxin deaths in the PR.

- [ ] T16 Zones on screen: light, fog, colour, bioluminescence, depth gauge [opus]
  - Acceptance:
    - **The water** takes its colour, brightness and fog density from the bathymetry under each pixel: a 256² `DataTexture` per pond seed, built once. The zones blend over their edge bands.
      - shallows: bright cyan-green;
      - twilight: blue;
      - deep: blue-black;
      - abyss: near black.
    - **Bioluminescence and dark-zone vision**: in deep and abyss, luminescent creatures light a pool around themselves, and vent crystals glow. The player sees clearly within its detection ring, while beyond it the water and food dim. Creatures always keep their rim, so a creature is dimmed but never invisible. (The brief: never hide an opponent who can still affect you.)
    - **The HUD** shows a small depth gauge: zone name and depth bar. The UV shimmer and pressure vignette cues appear when the hazard applies.
    - E2E (`m6-zones.spec.ts`, `debug.setZone`):
      - mean water luminance falls strictly from shallows to twilight to deep to abyss;
      - a luminescent creature in the abyss has a brighter surround than a dark one;
      - `state().zone` matches `zoneAt`;
      - the UV cue appears only in the shallows and only for a creature with tolerance below 1.
  - Notes: presentation reads the sim's `depthAt` and never writes back.

- [ ] T17 Caustics, god rays and marine snow v2 [opus]
  - Acceptance:
    - **Caustics**: animated bright caustic lines on the water and over bodies (additive, top-down projection). They are strongest in the shallows, fade through twilight and are absent in the deep and abyss.
    - **God rays**: in the shallows and twilight, slow-moving light shafts cross the plane from a fixed light direction. They are off on low.
    - **Marine snow v2**: three depth layers of drifting specks carried by the currents. Through the DOF (T3) they become bokeh above and below the plane, with occasional bright specks on high. Particle counts follow the preset share.
    - E2E: in the shallows, a 2 s screenshot pair shows moving caustics (a mean difference of at least 2 levels on open water) and in the abyss none. `render.info()` stays within budget with every effect on.
    - Check the result by eye against `reference-01.jpg`: water never flat, haze clouds, sparse snow.
  - Notes: keep total full-screen passes on medium at most 4 including the post chain. Fold caustics into the water shader rather than adding a pass.

### Owner feedback from v0.6.0 (Playtest #134)

- [ ] T18 Visible growth and faster progression
  - Acceptance (unit tests first):
    - **The camera curve**: the visible half-height becomes `k · r^e` with `e` between 0.6 and 0.75 (DESIGN §3), keeping today's view for a hatchling (r = 10). Tests pin it:
      - a creature that triples its radius is at least 1.35× larger on screen;
      - at the genetic maximum the view still shows at least 6 body radii from the centre to the top edge.
    - **The growth meter**: the HUD shows "Size 62% of adult" and, once size is enough, "Mature in 4:10", from the authority's `matureAtMs` and the local life clock. Each time size crosses another 10% of adult size, a cue plays: a soft ring pulse, and a sound after T23. Crossing a tier plays the bigger tier cue.
    - **Pacing retune** (rules version 6, `npm run sim:pacing`):
      - hatch to first eligibility, as the bot's median, falls from 17.3 min to 7–10 min;
      - matings per full life stay at 10 or fewer;
      - the cooldown (ADR 0022) is unchanged.
      Tune `RULES.life.matureMinMs`, `matureMinShare` and `RULES.growth.maxRate`, and the worker enforces the same numbers.
    - DESIGN §3, §4 and §5 and the pacing table are updated with the run date and commit.
  - Notes: kills as the main way to grow wait for combat (M7). Do not add a kill-like shortcut here.

- [ ] T19 Finding other players: edge indicators and the pond map [opus]
  - Acceptance:
    - **Edge indicators**: every pond player outside the view gets an indicator on the screen edge, pointing at them, with the distance in body lengths. The nearest 6 are shown, plus every ping.
      - The shape shows relative size (smaller, comparable, bigger) and a mate-ready mark when the hub's `mate-check` says so, asked at most every 5 s per player.
      - A ping within 2 view radii that is off screen shows its icon on the edge for its lifetime (#89).
    - **The pond map** (`M`): an overlay with the pond bounds, the zone map (T15), every player as a dot (yourself highlighted, mate-ready players marked) and live pings. `M` or Esc closes it. Steering continues under it.
    - Text stays plain, and colour is never the only signal (shape and a label too).
    - E2E (`m6-find.spec.ts`, two contexts on the M6 hub):
      - B is placed 3 views away: A's `state().indicators` points at B within 5°, and the edge element is visible;
      - B pings off screen: A sees the ping indicator;
      - `M` lists both players at positions within 2% of the map size.
  - Notes: positions come from pond snapshots (every pond member already streams them). No new hub load except the rate-limited `mate-check`.

- [ ] T20 The egg: beacon reveal, carried egg, hatch [opus]
  - Acceptance:
    - **The reveal**: while a genesis or a mating waits for its beacon, an egg appears over the creature or beside the parent.
      - It wiggles with rising frequency and glow (the owner's Pokéball moment). On the beacon it cracks and bursts, and the card slides in.
      - The flourish scales with the child's rarity tier: common is a soft pop; exotic is a bright burst with a short slow-motion of the effects.
      - A beacon later than 10 s settles the egg into a calm idle (it never builds forever).
      - Reduced motion (T22) replaces the shake with a fade.
      `state().egg.phase` goes `waiting` → `cracking` → `revealed`.
    - **The carried egg**: a pending child is drawn as an egg on a short tether behind the parent. It follows with a spring, in render only, and glows faintly by rarity.
      - Pond peers see it: a snapshot flag bit, with `PROTOCOL_VERSION` raised if the flag mask needs it, and older clients get `outdated`.
      - The HUD says "Egg: H to hatch".
    - **The hatch**: promoting cracks the egg, the child grows out of it with a pop, and the frozen parent fades to its checkpoint ghost.
    - E2E (`m6-egg.spec.ts`, M5 hub hooks): a genesis shows the phases in order. After a mating, both players' eggs are visible to the other (snapshot flag), and `H` plays the hatch with `egg.carried` false afterwards.
  - Notes: the egg cannot be harmed in M6. Predation and incubation are M7 (ROADMAP).

### Readability

- [ ] T21 Readability, crispness and the size outline [opus]
  - Acceptance:
    - **Crispness** (owner, Playtest v0.2.0: "the cell and UI looked blurry"):
      - the canvas backing size equals CSS size × pixel ratio, with no CSS scaling of the canvas;
      - HUD text sits on whole pixels (no fractional transforms on text containers);
      - icons are SVG.
      E2E: at a pixel ratio of 2 (Playwright `deviceScaleFactor`), the canvas backing is twice its CSS size, and HUD text edges in a screenshot have a 10–90% rise of at most 2 device pixels.
    - **The size outline**: a creature at least one tier bigger than the player gets an outline that differs in shape (a broken ring) and pulse, not only colour. A comparable creature gets none, and a smaller one a faint dot ring. This prepares M7 threats.
    - **Readable parts**: at default zoom, mouths, claws and plates stay recognisable, checked by eye on six gallery bodies at 960×540, with a note in the PR.
  - Notes: the outline follows the game rules: colour is never the only signal.

### Sound

- [ ] T22 Audio engine, ambience by depth, settings [opus]
  - Acceptance (unit tests first, on `OfflineAudioContext`):
    - **The engine**: one `AudioContext`, started on the first user gesture, with a master gain, a limiter and per-cue voices with a polyphony cap (4 per cue, 16 total). A hidden tab suspends it, and it resumes on return.
    - **Ambience by zone**: filtered noise and slow drones whose filter and level follow `setZone(zone, depth)`, cross-fading over 2 s. The shallows are airy, the abyss low and pressured.
    - **Settings**: volume 0–100 and mute in the Settings panel, stored with the other settings; mute is instant. Reduced motion defaults to `prefers-reduced-motion`, and the egg (T20) and camera effects read it.
    - Unit tests:
      - an offline render of each zone's ambience is not silent (RMS above −50 dBFS) and never clips (peak at most −1 dBFS);
      - mute gives digital silence;
      - two renders with the same seed are sample-identical.
    - E2E: `state().audio.state` is `running` after a click and `suspended` while hidden. Changing the zone changes the ambience parameters (`debug.setZone`).
  - Notes: no audio files (ADR 0014). Keep it quiet and organic; the reference is a microscope, not an arcade.

- [ ] T23 Event sounds for every cue [opus]
  - Acceptance:
    - Every row of DESIGN §10 has its sound: eat, hurt, low energy, hazard near, dash, death, old age, court, mate, hatch and reveal (T20), growth and tier (T18), ping, emote, chat, UV and pressure (T15). Death causes each play the death tone, so a death is never silent.
    - Positional cues (another player's emote or ping) pan by screen position and fall off with distance.
    - Unit tests: each cue renders non-silent and below clipping, and its length is pinned (eat ≤ 0.25 s, death 1–2 s).
    - E2E: `state().audio.cues` counts `eat` after eating, `hurt` in a plume, `death` on dying, `ping` when a peer pings, `reveal` on a beacon. A starved death plays `death`.
  - Notes: update DESIGN §10's audio column with the shipped sounds in words.

### Social (#89)

- [ ] T24 The quick social wheel [opus]
  - Acceptance:
    - `G` opens a radial wheel at the cursor: 4 pings (look, danger, food, mate) and 6 emotes. While it is open, `1`–`0` pick directly.
      - Holding `G` and releasing over an item sends it; a click sends it too; Esc or releasing in the centre cancels.
      - A ping lands at the cursor's world position and an emote over your creature.
      - Middle-click still sends a quick "look" ping. `T` + `1`–`6` keeps working for chat users.
      The random pick is gone.
    - Steering pauses only while the wheel is open. Combat keys are untouched (M7 uses 1–3 only in combat).
    - Targets are at least 44 px, and the wheel lays out for a future touch hold (no hover-only actions).
    - E2E (`m6-wheel.spec.ts`, two contexts):
      - A opens the wheel, presses `3`: B sees the food ping at A's cursor position (within 2 wu);
      - releasing over "happy" shows the emote over A for B;
      - Esc sends nothing;
      - `state().wheel` reflects open and closed.
    - DESIGN §3 and §9 are updated (controls, wheel).
  - Notes: close #89 only after T25 and the owner's check.

- [ ] T25 Production-quality emote and ping icons [opus]
  - Acceptance:
    - 10 original SVG icons: wave, happy, love, angry, scared, question, look, danger, food, mate. They share one line weight and style (glowing line art that fits the dark water) and are drawn on a 24 px grid. They are used in the wheel, over creatures, on edge indicators (T19) and in chat. No emoji glyphs remain.
    - Each is legible at 20 px and 40 px: a screenshot at 20 px shows each with a distinct shape, judged by eye and noted in the PR. A test checks every icon has a `title` for screen readers.
    - E2E: every emote and ping renders an `svg` element and no text glyph.
  - Notes: no third-party icon sets (licences); draw them.

### Performance

- [ ] T26 Budgets, allocations and the budget report [opus]
  - Acceptance:
    - **A crowded scene** (`m6-budget.spec.ts`, `@slow`): 24 remotes with gallery genomes, every zone effect on. Per preset, `calls`, `triangles` and `targetBytes` stay within the DESIGN §12 budgets plus a render-target memory budget: medium ≤ 48 MB and high ≤ 96 MB at 1920×1080.
    - **No per-frame allocations**: over 1,200 frames in the crowded scene, after a forced GC (`--js-flags=--expose-gc`), JS heap growth is below 1 MB, and `renderer.info.memory` geometries and textures are constant. A code review of the render loop and the post chain finds no `new` in per-frame paths, with a note in the PR.
    - `npm run report:budget` writes `docs/perf/budget.md`: per preset, the calls, triangles, targets and memory for an empty pond, a crowded pond and the abyss. It also saves per-preset screenshots to `test-results/` (not committed).
    - **Low** keeps the game playable: no post targets, and every effect falls back.
  - Notes: frame rate on real hardware is the owner's check (60 fps at the default preset). CI renders in software, so judge budgets, not fps.

### Closing

- [ ] T27 Look pass 2 [opus]
  - Acceptance:
    - `pass-2.png` and `pass-2.md` are rendered after T15–T26, with the honest gap table. The top gaps are fixed, the sheet and table re-rendered after the fixes, and every cell improved since pass 1 is named in the PR.
    - The in-game check at 960×540 is repeated, in the shallows and in the deep.

- [ ] T28 Look pass 3 [opus]
  - Acceptance:
    - `pass-3.png` and `pass-3.md` are committed. The bar for M6 is no cell above 1 (ADR 0024).
    - If cells above 1 remain after this pass's fixes, the task adds `T28b Look pass 4` to this spec with the remaining gaps, rather than ticking the rubric. Passes continue until the bar holds.
    - The PR body links #90 and summarises the journey from pass 0.

- [ ] T29 End-to-end scenario, owner-facing checks, documentation sync
  - Acceptance:
    - `m6-lifecycle.spec.ts` (`@slow`, its own hub port) at `?quality=medium`:
      1. A hatches; the egg reveal plays.
      2. A swims from the twilight spawn into the shallows (the UV cue and sound, a uv hit) and the abyss (pressure, the dark-zone view).
      3. A finds B by its edge indicator and the pond map.
      4. A pings and emotes through the wheel.
      5. A and B court and mate; both see the other's carried egg.
      6. A promotes, with the hatch sequence.
      Every step asserts `render.info()` budgets and `audio.cues`.
    - The exit criteria map below names a test for each criterion. The PR E2E suite stays under 5 minutes in CI: record the time, and move any new spec over 20 s to `@slow`.
    - Docs:
      - DESIGN §2–§6, §9, §10 and §12 match the shipped numbers;
      - `.claude/rules/render.md` gains the post chain, budgets and LOD;
      - `.claude/rules/genome.md` gains karyotype v2 and the v1 equivalence rule;
      - `.claude/rules/tests.md` gains the M6 hooks and hub ports;
      - `docs/art/README.md` links the gallery passes.
  - Notes: this task adds the scenario and the sync only. The milestone step sets ROADMAP status and opens the Playtest issue with the owner checks below.

## End-to-end check

Against the fixture authority and a build at `?quality=medium` (`m6-lifecycle.spec.ts`, release gate):

1. Hatching shows the egg reveal: `waiting` → `cracking` → `revealed`. The new body is a v2 genesis larva whose `silhouetteOf` is one of the genesis classes.
2. The post chain is on (`passes`). The creature is sharp and the off-plane particles are bokeh, while the frame stays within the medium budget.
3. Each zone shows its look and, where it applies, its hazard with its cue and sound. A death in the abyss names `pressure` and plays the death sound.
4. Growth shows on the meter, and the size cue plays on each 10% step.
5. A second player is found through an edge indicator and the pond map. Wheel pings and emotes reach them with icons.
6. A mating shows both carried eggs to both players, and promotion plays the hatch.
7. `audio.cues` has counted a cue for every event above. Allocation and memory counters are stable over the run.

Exit criteria map (ROADMAP M6):
- creature look overhaul to the owner's references (#90): T5–T14, T27, T28;
- art pass to the reference (DOF, caustics, membranes, bioluminescence by depth): T2, T3, T13, T16, T17;
- depth zones with gameplay: T15, T16;
- low, medium and high presets with budgets: T1, T4, T26;
- procedural sound: T22, T23;
- deliberate pings and emotes (#89): T19, T24, T25;
- owner feedback from v0.6.0 (#134): T18, T19, T20;
- readability and crispness: T21;
- end-to-end: T29.

## Rubric

- [ ] The gallery holds up next to references 02–05: the final pass has no gap-table cell above 1 (evidence: `docs/art/gallery/pass-*.png` and `.md`, ADR 0024).
- [ ] Silhouette variety: the gallery's 12 v2 specimens are 12 distinct `silhouetteOf` classes, and each reads as its class on the sheet by eye (evidence: the classifier test and the sheet).
- [ ] Colour lives inside: shells stay near-clear and silvery, organs carry the hue (evidence: T12/T13 saturation measurements on the gallery).
- [ ] Glints are rare: common creatures show at most 2, and only exotic ones reach reference 04/05 intensity (evidence: `glintsFor` tests and the gallery measurement).
- [ ] Bodies stay readable in play: at 960×540 and default zoom, six different bodies keep distinct silhouettes and a bright rim (evidence: the in-game screenshots in passes 1–3).
- [ ] Every zone looks and sounds different, and every hazard has a visible and an audible cue (evidence: the T16 luminance order, T23 cue counts).
- [ ] Every preset stays within its budgets in a crowded pond, and nothing allocates per frame (evidence: `docs/perf/budget.md`, the T26 E2E).
- [ ] Growth is visible: tripling the radius makes the creature at least 1.35× larger on screen (evidence: the T18 camera test and before and after screenshots).
- [ ] Pings and emotes are chosen on purpose in one key press and drawn with production icons (evidence: the T24 E2E and the T25 icon sheet).
- [ ] (owner) The creatures hold up next to the references: diverse, glassy, alive, with colour inside and rare sparkles (#90).
- [ ] (owner) 60 fps at the default preset on a mid-range laptop with integrated graphics, and Auto picks a sensible preset.
- [ ] (owner) The egg reveal is exciting, and carrying an egg feels meaningful.
- [ ] (owner) Finding other players is easy, and growth feels fast and visible.
- [ ] (owner) Sound adds to the mood and never annoys over a long session.
- [ ] (owner) The social wheel feels natural, and the icons look production quality (#89).

## Risks

- **Karyotype v2 breaks living creatures or old records.** v1 equivalence is a property test, hashes are length-preserving, v5 inheritance stays for verification, and the M5 birth goldens must still pass (T6, T7).
- **Body plan v2 unbalances the game.** Archetype tests gain the new forms (T7, T8). Genesis stays the cell stage, with top speed held within ±15% (T9). The pacing tool reruns (T15, T18).
- **The look stalls below the bar**, because software rendering in CI hides problems and taste is hard to test. The gallery is fixed and committed (ADR 0024), passes are judged against the references image by image, and T28 adds passes until the bar holds. The owner has the final word at the gate.
- **Fine detail turns to noise at gameplay zoom.** Detail fades with screen size (T13), every pass checks the in-game view at 960×540, and the readability task (T21) protects the silhouette.
- **The post chain and new materials blow the budget on integrated GPUs.** Per-preset budgets, the auto-detect benchmark, adaptive resolution and a post-free low preset (T2–T4, T26). The owner checks real fps.
- **Refraction needs the backdrop before creatures**, which adds a pass. It is medium and high only, drawn into the post chain's scene target, with plain translucency on low (T13).
- **Audio annoys or fails on some browsers.** It starts on a gesture, has a limiter and polyphony caps, mute and volume, and suspends in hidden tabs (T22). Offline renders are tested for silence and clipping.
- **The egg flag breaks older clients.** The snapshot flag mask rejects unknown bits, so the protocol version rises with it, and old clients are told to reload (T20).
- **The PR E2E suite grows past its budget.** New long scenarios are `@slow` from the start, and T29 records the suite time.
- **M6 is long (29 tasks).** The layers are independent after T9, so a blocked task does not stall the rest. The milestone ships only when the gate's look bar holds.
