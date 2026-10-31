# M6b: Look and HUD polish

Release: v0.7.1 · Gate: yes

## Goal

M6b answers the owner's reply on Playtest #183 (v0.7.0), which closed #177 as a duplicate. Looks come first: stats, genesis code and goldens may change as far as needed, while ADR 0006's bounds and caps stay.

- **Creatures look like pass 1 again.** Pass 1 is `docs/art/gallery/pass-1.png`.
  - Shells are clear glass with a crisp rim.
  - Organs are pass 1's size, and their colours sit close together or match as complements.
  - There is no milky haze or artificial glow.
  - Nothing clips to a white blot where parts overlap.
- **Long bodies read as creatures.** A worm is a slim S-curved chain, a shrimp a segmented trunk with many thin, bristled legs, a copepod an oval front with a slim tail, and a coil a real spiral.
- **The play screen is minimal.**
  - One menu button sits in a corner.
  - The stats are small bars, and a modern minimap sits in another corner.
  - No text stays on screen.
  - UV, pressure and other damage make the creature and the camera shake slightly instead of painting a red border.
- **The egg reveal is a gacha moment.**
  - The egg rests and answers clicks while it waits.
  - It stirs only once the beacon has come, then cracks and bursts by rarity, and a result card shows what hatched.
  - Nothing covers it, including after a death.
- **Play feels right.**
  - The social wheel no longer stops your movement.
  - Top speed lives in a band (the answer to "is it a bug?" is in DESIGN §4).
  - The shallows are calmer, while the depth zones keep their look.

ADR 0034 sets the look method: one pass, judged against pass 1. ADR 0035 covers rules 7, with bodies that follow the current rules, and ADR 0036 the speed band. ADRs 0024, 0025, 0028, 0031 and 0032 still hold where these do not amend them.

This milestone is a **gate**. After v0.7.1 the factory waits for the owner's reply on the `Playtest: v0.7.1` issue before M7 starts.

## Out of scope

- **Combat**: predators eating eggs, kills as growth, and combat telegraphs (M7).
- **New genome loci or a karyotype v3.** Rules 7 reshapes development from the existing loci (ADR 0035).
- **Changes to inheritance, mutation or expression** (ADR 0035). Max biomass, growth and lifespan stay the same for every genome.
- **More look passes after pass 6** (ADR 0034). The owner judges whatever gaps remain at the gate.
- **Touch and mobile controls.** The menu button, minimap and wheel stay touch-friendly in size only.
- **New sound design.** The only new cue is the egg's stir.
- **The lineage view and the inspect card**, beyond picking up the new HUD style.
- **Turning speed.** T1 reports it, and a later milestone may band it.

## Touches

New:
- tools: `tools/speed-report.ts` and `npm run report:speed` (T1); `tests/e2e/look-metrics.ts`, the shared screenshot measures (T3, T4);
- game: `src/game/hud-menu.ts` (T9), `src/game/minimap.ts` (T10), `src/game/hints.ts` (T9);
- render: `src/render/shake.ts` (T10);
- genome goldens: `src/genome/__golden__/{inherit,offspring}-v6.json` (T1), `genesis-v7.ts` and `genesis-v7.json` (T13);
- tests: `tests/e2e/m6b-*.spec.ts`;
- docs: `docs/art/gallery/pass-6.{png,md}` (T12).

Changed:
- sim: `src/sim/rules.ts` (`RULES_VERSION` 7, `RULES.stats.speedBand`, the shallows' light constants);
- net: `src/net/protocol.ts` (`PROTOCOL_VERSION` 5);
- genome: `src/genome/{develop,stats,genesis,silhouette}.ts`, their goldens, `src/ledger/genesis.ts` (`genesisFor`);
- render: `src/render/{anatomy,material-params,materials,creature-mesh,creature-view,effects,egg,zones,scene,camera}.ts`, the creature, egg, water, caustics and god-ray shaders, `src/render/post/chain.ts` (grade);
- game: `src/game/{app,hud,screens,eggs,wheel,input,pond-map,indicators,social-ui,zone-readout,debug,settings-panel,lineage-panel,sound-cues}.ts`, `src/style.css`, `index.html`;
- audio: `src/audio/cues.ts` (the `stir` cue);
- lab: `src/lab/gallery-page.ts` (organ and outline geometry in the hook);
- tools: `tools/gallery-notes.ts` (the "Against pass 1" table), `tools/specimen.ts`, `tools/diversity-report.ts`;
- config: `playwright.config.ts` (hub ports 8801–8803), `package.json`;
- docs: `docs/DESIGN.md` §2–§6, §9, §10; `.claude/rules/{render,genome,game,tests}.md`; `docs/art/README.md`.

Interfaces (a task note may refine a shape, with the reason):

```ts
// src/sim/rules.ts (T1, ADR 0036)
RULES.stats.speedBand: { min: 0.6; max: 1.6; /* the soft knee: identity inside [min·k, max/k] */ knee: number };

// tests/e2e/look-metrics.ts (T3, T4; used by T12)
/** Pixels with min(R, G, B) ≥ 245 whose eight neighbours are too (ADR 0034). */
export function solidWhite(rgba: Uint8ClampedArray, width: number, rect: Rect): number;
```

`window.__bs` additions (documented in `.claude/rules/tests.md` by the task that adds each):
- `state().hud` (T9): `menu` (open), `bars` (`health`, `energy`, `size`, `life`, each 0..1 as drawn), `chips` (the chips shown: `egg`, `ready`, `practice`, `offline`) and `hints` (a first-time hint shown).
- `state().minimap` (T10): `shown`, `radiusWu`, `zone`, `depth`, `hazard` (`uv|pressure|null`), and `players` and `pings` (`id`, CSS-pixel `x` and `y` inside the minimap, `size`, `ready`).
- `render.fx()` (T10): `shake` (`{ body, camera }`, current offsets in CSS pixels). `vignette` stays in the hook and reads 0.
- `state().egg` (T11): `phase` gains `stirring` (`none|waiting|stirring|cracking|revealed`), plus `angle` (radians), `glow` (0..1) and `card` (`{ shown, tier }`).
- `__gallery.state().specimens[i]` (T3): `organs` (CSS-pixel discs `x`, `y`, `r`) and `outline` (the body hull as a CSS-pixel polygon, parts excluded), so screenshot measures can mask by geometry.

Hub E2E ports: `m6b-egg` 8801 (the M5 hooks), `m6b-minimap` 8802 and `m6b-lifecycle` 8803 (`@slow`).

## Tasks

The tasks run in layers:
- play: T1 and T2;
- the look on screen: T3 and T4;
- long bodies, under rules 7: T5 to T7;
- water and HUD: T8 to T10;
- the egg: T11;
- closing: T12 and T13.

ADR 0034 allows exactly one look pass (T12), and it starts only after T1 to T11 are ticked. Before it, look tasks judge their work with their own measures and side-by-side crops. They commit no pass sheet.

### Play

- [x] T1 Speed review, the speed band and rules 7
  - Acceptance (unit tests first):
    - **The report.** `npm run report:speed` (`tools/speed-report.ts`, through Vite as `report:diversity` runs) prints the M1 starter's numbers, then four sets:
      - genesis bodies at hatch (biomass 80) and as adults;
      - bodies bred for 6 generations, at hatch and as adults.

      Each set has 1,000 bodies and shows p1, p10, median, p90, p99 and max of:
      - top speed in wu/s, in body radii per second, and in screen heights per second at the default zoom (DESIGN §3);
      - dash speed;
      - turning.

      A unit test pins the report's shape, and the PR shows the numbers before and after.
    - **Bug candidates, each ruled out or fixed with a test:**
      - the game loop runs at most 5 ticks per frame and never catches up faster than real time after a hidden tab or a 2 s stall;
      - a remote creature is never drawn faster than 1.25× the speed between its two bracketing snapshots, including across a 1 s snapshot gap (it eases, it does not jump);
      - the camera's zoom never makes a hatchling's on-screen speed exceed what its sim speed and DESIGN §3's view give.
    - **The band (ADR 0036).** Under rules 7, `statsAt` rescales thrust so that the top-speed multiplier (thrust ÷ drag, relative to the reference cell at the same biomass) passes through a strictly increasing soft clamp into `RULES.stats.speedBand` (0.6–1.6). Tests check:
      - over 10,000 random and 10,000 mutated genomes at 5 sizes (biomass 80, 25%, 50% and 100% of the maximum, and the maximum):
        - every top speed is within 0.6–1.6× the starter's at that biomass;
        - a dash stays within √0.6 to √1.6 of the starter's;
        - of two bodies, the faster before the band is never slower after it;
      - the genesis hatchling median is 1.0–1.3× the starter, and p10 is at least 0.7×.
    - **Rules 7 (ADR 0035):**
      - `RULES_VERSION` is 7 and `PROTOCOL_VERSION` rises to 5 (an older client gets `outdated`);
      - `inherit.json` and `offspring.json` are first copied to `inherit-v6.json` and `offspring-v6.json`, and the rules 6 births there still verify through `checkBirth`;
      - `express.json` is unchanged;
      - every regenerated golden is listed in the PR, with the reason.
    - **The balance holds:**
      - `stats.test.ts`: every archetype is best at one metric at some size, and none is best at everything;
      - the archetype tournament;
      - `npm run sim:pacing` stays within ADR 0029's targets (new medians in DESIGN §5);
      - the Lab's wild diversity: 8+ classes for 9 of 10 seeds;
      - zero invalid bodies over 10,000 random and 10,000 mutated genomes;
      - the development speed budget (ADR 0030).
    - DESIGN §4 gets the band and the report's numbers. It also gets one plain line answering the owner: "Too fast was the design, not a bug: form allowed 40× speed differences; rules 7 bands them." Adjust that line if a bug candidate turns out real. DESIGN §6 gets the band in the stats.
  - Notes:
    - The spec-time probe numbers are in ADR 0036; the report replaces them.
    - Keep the band in genome stats, so the sim and its goldens see the banded `PhysStats`, and leave the sim's physics untouched.
    - If turning's p99 is above 3× the starter's, note it in DESIGN §4 as a known spread (out of scope).
    - Done: `npm run report:speed`; `bandSpeed` (rational soft clamp, middle 1.0–1.1, so the tournament still holds) in `statsAt`; rules 7 and protocol 5; `-v6` goldens kept.
    - Gotchas: the sim uses the adult `phys` at every size, so "at hatch" in the report is the adult `phys` at biomass 80. The remote-interpolation bug candidate was real (a jump after a snapshot gap) and is fixed in `RemoteBuffer`; the loop and the camera were fine. `develop-v5.test.ts` now expects the v5 stats with the band applied.

- [x] T2 The wheel keeps your movement
  - Acceptance (tests first):
    - While the social wheel is open, the creature keeps the input it had when the wheel opened: the cursor's steer and throttle at that moment. WASD still steers live, Space still dashes, and closing the wheel hands steering back to the cursor. The choice is a pure function (`wheelInput(open, held, sampled, keys)` or similar) with unit tests: open with no keys gives `held`, open with WASD gives the keys, and closed gives `sampled`.
    - E2E (`m6-wheel.spec.ts`; the old "steering pauses" assertion is replaced, as #183 asks):
      - swimming right at full throttle, with the wheel held open for 1 s, the creature travels at least 80% of the distance of the same second with the wheel closed;
      - its heading turns by at most 5° while the cursor moves across the wheel's items;
      - sending a ping or an emote, and cancelling with Esc, change nothing about the movement.
    - DESIGN §3 and §9 already say this (spec); check them against the code.
  - Notes: a middle-click look ping and `T` with 1–6 never touched steering; keep it that way.
    - Done: `wheelInput` in `input.ts` and `InputController.keyInput`; `chooseInput` holds the last closed-wheel input, WASD steers live and releasing it coasts, and `enter` clears the hold for a new life.
    - Gotcha: the E2E compares 1 s windows of real time (80% of distance, under 5° of heading), so keep the creature far from the world edge while it runs.
    - Gotcha: `m3-anatomy` "each hatch is a new genesis body" starves a creature at `timeScale(4)` within 20 s and timed out once on a loaded CI runner (green locally, unrelated to input); if it recurs, give it its own spec task.

### The look on screen (ADR 0034)

- [x] T3 Pass 1's glass, without the haze and the glow [opus]
  - Acceptance:
    - **Measure first.** On main, before any change, render the gallery to a scratch file and record in the PR the two measures below. Do the same with side-by-side crops of cells 01, 07, 12, 24, 27 and 31 against `pass-1.png` (scratch files, not committed).
    - **What comes out** (unit tests on `anatomyOf` and `materialParams`, plus the shader's code):
      - the organ halos of look pass 2 (`Organ.halo`, `HALO`); `anatomyOf` returns no halo discs;
      - the scattered-light band inside the rim (look pass 3);
      - the denser organ glows on small bodies (look pass 3);
      - chambers that glow from the centre. They go back to pass 1's glassy chambers, with a brighter wall and a clearer centre.

      Organs return to pass 1's chamber radius (0.23 body scales, from 0.36), spacing (gap 1.2, from 1.05) and midline band (0.55 of each segment's half-width, from 0.7). Their sizes still vary by ±45%.
    - **Palette** (a property over 1,500 genomes):
      - every organ's hue is within 0.06 turns of the hue gene, except at most one complementary accent group (0.5 ± 0.05 turns) on at most a third of the organs, for uncommon and rarer bodies only;
      - droplets turn 40% toward amber, as in pass 1.

      `ORGAN_HUES` keeps rarity's rising saturation, not its hue spread. Luminescence still lights the organs (photophores), and glints keep `glintsFor`.
    - **What stays:**
      - pearl bulb tips;
      - wet joint points, dimmed to at most half of the rim's luminance;
      - segment walls, faint, at most 0.35 of the rim's luminance;
      - lens eyes set into the head;
      - plumose setae;
      - clear broad parts;
      - the fainter gut;
      - refraction;
      - the rim as every body's brightest ring (M6 T13's check).
    - **Screenshot measures** (`tests/e2e/look-metrics.ts`, on the gallery sheet, masked by the new `organs` and `outline` hook geometry):
      - *colour stays in the organs*: inside each body's outline, at least 85% of the pixels with chroma (max − min) ≥ 0.15 lie within 1.3 organ radii of an organ centre (the pass 2 halos reached 2.4);
      - *the shell is clear*: the median luminance of shell-only pixels (more than 3 px inside the outline, outside every organ disc × 1.3) is at most half of main's excess over the water, as measured first.

      Both run in `m6b-look.spec.ts` (`post` project; `@slow` if over 20 s).
    - The existing look checks stay green: M6 T10's parts, setae and membranes, M6 T12's hue variance inside the hull (pass 1 passed it with one organ hue per body), M6 T13's saturation, glints and rim, and M6 T21's readable mouths and plates.
    - DESIGN §12 (inner anatomy, materials and the look-pass 2 and 3 paragraphs) describes what remains.
  - Notes:
    - `git diff e90b4af HEAD -- src/render/anatomy.ts src/render/material-params.ts src/render/shaders/creature.frag.glsl` shows every change since pass 1.
    - M6 T21 (8f3010e) turned plates milky, and pass 2 fixed it; keep that fix.
    - Judge by eye on the crops before ticking: "glassy and clear like pass 1, with the detail of pass 5".
    - Done: halos, scatter and centre-lit chambers out; pass 1 layout; `Organ.accent`, `ORGAN_HUES` `{ vivid, accent }`; a crisp rim term (power 5); fainter face, markings, plates, carapace, walls (0.35) and joints (0.5). Main: shell 63.1, 14 cells under 85%; now 28.8, all ≥ 91%.
    - Gotcha: pass 1's face measures as bright as main's, so the bar needs glass clearer than pass 1; the hook's `organs` include the gut's rings; `m3-clip`'s starter now checks for a hole by comparison, since its clear centre shows the water.

- [x] T4 No white clipping [opus]
  - Acceptance:
    - `solidWhite` counts pixels whose min(R, G, B) is at least 245 and whose eight neighbours are too (ADR 0034). On the gallery sheet, every cell has at most 12. On pass 5, cell 31 had 430, 37 had 336, 39 had 427, 07 had 72, 29 had 61, 08 had 29 and 38 had 22.
    - `m6b-clip.spec.ts` (`post` project; `@slow` if over 20 s) captures the gallery with `captureGallery` and asserts the bar for every cell. T12 reruns it on the final sheet.
    - **In game**, at medium and at high: gallery specimens 07, 08, 31, 37, 38 and 39 are drawn as remotes (`debug.setRemotes`) at default zoom in the twilight, with the world frozen. Within each body's box (from `render.info().pxPerWu`), `solidWhite` is at most 12.
    - What must survive:
      - the exotic specimen's ≥ 8 glint maxima and the common one's ≤ 2 (M6 T13);
      - the rim as the brightest ring;
      - the setose specimen's ≥ 20 bristle strokes and the winged membranes' coverage (M6 T10);
      - the bloom halo check (M6 T2);
      - T3's two measures.
  - Notes:
    - White blots come from bright part strokes stacking where parts overlap (setae, setules, the edges of broad parts), then the bloom and the grade's shoulder.
    - Options:
      - cap each part layer's HDR output so full coverage stays below white;
      - stop strokes stacking within one creature (depth or max blending for part strokes);
      - roll the grade's shoulder to a cool near-white below 245, except for glints.

      Pick one or more, and note which in DESIGN §12.
    - Done: options 1 and 3: fine parts capped after all their light (legs, pearls, membranes 0.5, setae 0.75, setules 0.3; pearls keep their hot point), and the grade (`post/grade.ts`) rolls off to (237, 249, 255) unless a pixel stands 0.8–1.4 above its diagonal neighbours (a glint). Pass 5's 31/37/39 had 330–430; every cell and in-game body now 0.
    - Gotcha: the grade alone passed the measure but left pale-blue blots, so the part cap carries the look; setae need 0.75 to keep M6 T10's 20 strokes (22 now).

### Long bodies (rules 7, ADR 0035)

The three tasks share these balance checks, re-run in each (the "balance checks"):
- `stats.test.ts` archetypes: each best at one metric at some size, none best at everything; a radial body turns better and thrusts worse than its bilateral twin;
- the tournament;
- `npm run sim:pacing` within ADR 0029's targets;
- the Lab's wild diversity: 8+ classes for 9 of 10 seeds;
- zero invalid bodies over 10,000 random and 10,000 mutated genomes;
- the development speed budget (ADR 0030);
- T1's speed band property;
- the M6 T10 mesh budgets over every gallery specimen and 1,500 random plans per level of detail.

Stats keep reading a slimmed chain's girth (ADR 0031). If a gallery specimen changes `silhouetteOf` class, a new specimen for the lost class is added (ADR 0024), so specimens 21–32 plus the additions still cover 12 distinct classes.

- [x] T5 One body, widest at the trunk [opus]
  - Acceptance (unit tests first, on plans):
    - In a bilateral karyotype v2 chain of 3 or more segments (parts excluded):
      - the drawn head's half-width is at most 0.9 of the trunk's widest half-width;
      - an unfused chain's widest point lies 25–55% of the body's length from the front;
      - behind the widest point every segment is at most 1.05 times as wide as the one in front of it, so the outline narrows to the tail;
      - the body is still at least 2.5 times as long as wide (ADR 0031).

      This holds for 95% or more of 10,000 random v2 genomes with such chains, and for gallery specimens 07, 09–12, 18, 19, 26, 27 and 30.
    - **Per class**, on `tools/specimen.ts`'s class specimens and on at least 80% of random bodies of the class:
      - a copepod's fused carapace is the widest part, in the front 45%, and its free tail is at most 0.5 of the carapace's width;
      - a shrimp's head is narrower than its trunk, with 3 or more leg pairs along the trunk;
      - a worm has 5 or more segments, is at least 4 times as long as wide, and varies in width by at most 30% over its middle 80%.

      `silhouetteOf` follows any geometry it reads that changes.
    - The balance checks above hold. A new ADR (the next free number) amends 0028 and 0031 with the new proportions, and DESIGN §6 (Proportions, Long bodies) follows.
    - A scratch gallery render is compared by eye with references 02 and 05 (the long copepods and shrimps) and noted in the PR. No pass sheet is committed.
  - Notes: the core collider stays the unit circle (ADR 0028), so the sim, sizes and hazards do not move. Expect a smaller head and a wider trunk inside the 2.5 bound.
    - Done (ADR 0037): `chain.profile` (head ≤ 0.7 long at 0.85–0.9 of the trunk, widest near 0.4, area kept); curled 5+ chains (worms) 4.2:1; `silhouetteOf` worms from 5, a tadpole's front, fan tails at 45%; eyes part on a narrow head; carapace gets the crisp rim.
    - Gotcha: 97% pass (3-segment chains put the widest past 55%); thinner heads or straight shrimps at 4.2:1 let head-part bristles cover the trunk, failing M6 T10/T13's setae and rim checks (27, 39) until T7.

- [ ] T6 Spirals and S-worms [opus]
  - Acceptance (unit tests first):
    - A curled v2 chain fits the bounds along its curve, not laid straight (#177 option 2a; amends ADR 0031's "a curl is only a pose"). Its length may exceed the straight reach as long as the curled pose stays within 2.5 core radii.
      - **A coil** (curve ≥ 0.8) turns at least 2.5π (1.25 turns), its links shrinking toward the inner end.
      - **An S-curve** (S mode, curve ≥ 0.5, 5 or more segments) has two opposite arcs of at least 0.6π each.
      - **No self-overlap**: segments that are not neighbours keep at least 0.1 of their summed radii apart. `bodyViolations` checks this, over the 10,000 random and 10,000 mutated genomes.
    - Stats follow the longer chain (length, mass, inertia, drag, by its girth). The curl terms in `RULES.stats.v2` are re-tuned so the coiled archetype keeps its niche and is best at no more metrics than before. All the balance checks hold.
    - In the gallery, plan checks:
      - 29 (coil) and 39 (spiral) turn at least 2.5π;
      - 28 (worm) is an S-curve.

      If a stored genome cannot show it, a feature specimen is added (`npm run specimens -- --features`, ADR 0032).
    - The mesh lofts the longer curved chain within the LOD budgets.
    - A new ADR amends 0031, and DESIGN §6 (Spine curve, Long bodies) follows.
  - Notes: reference 05's nautilus (15) and S-worm (06) and reference 02's worm (06) and nautilus (14) are the targets. If the coiled archetype cannot be balanced, cap the curled chain's extra length and say so in the ADR.

- [ ] T7 Thin, bristled legs that keep off the body [opus]
  - Acceptance (unit tests first):
    - **Thin legs.** Under rules 7, a v2 part's base width scales with its root segment: at most 0.5 of that segment's girth half-width (the head's for head parts). Legs on a slim trunk are thin, and a paddle tip still widens toward its blade. Over random v2 bodies of 3 or more segments, the median trunk-leg width is at most 0.12 core radii; record the before and after in the PR.
    - **Off the body.** Over 10,000 random v2 bodies, at least 95% of parts have no more than 25% of their drawn centre line inside the body outline. Parts swept along the body (ADR 0028) shorten or turn outward instead of lying over the trunk, which fixes the worm tangles of pass 1's gap 8.
    - **Bristles common.** Rules 7 genesis (`genesis.ts`) gives a setae density of at least 0.3 to at least 50% of genesis module slots other than whips, from the form's own PRNG stream, so the v5 and form draws never shift. The genesis checks hold:
      - at least 4 silhouette classes over 1,000 seeds, none above 40%;
      - the rare alleles' frequencies;
      - one body unit and at most 3 slots.

      In `report:diversity`'s bred sample (6 generations), at least 50% of trunk legs carry 6 or more bristles; record before and after.
    - All the balance checks hold. Thinner legs thrust and drag less, setae add drag, and the band holds speed.
    - In the gallery, the trunk legs of 26, 27, 30, 37 and 38 have a median width of at most 0.12 core radii (plan check).
    - DESIGN §6 (genesis, development, fine parts) follows, and the next free ADR records the width rule if it amends 0028.
  - Notes: rarity does not price setae, so rarity is unchanged. `genesis.json` is regenerated (rules 7), and `genesis-v6.json` never changes.

### Water and HUD

- [ ] T8 Calmer shallows [opus]
  - Acceptance:
    - **Measure first** (record in the PR, then pin the new bounds in `m6-light.spec.ts` or a new `m6b-water.spec.ts`), on an open-water patch away from food, at medium:
      - the mean absolute frame difference between two frames 2 s apart (`timeScale(1)`);
      - the luminance standard deviation of a 200×200 patch;
      - `render.info().caustic` and `rays`.
    - **Targets** in the shallows, against those values on main:
      - frame difference at most 50%;
      - standard deviation at most 60%;
      - caustics over bodies at most 0.4 strength (from 1.4);
      - god rays at most 0.5 (from 1).
    - **The zones still read apart:**
      - mean water luminance still falls from shallows to twilight to deep to abyss (M6 T16);
      - the shallows' frame difference is still at least 1.5× the abyss's;
      - twilight, deep and abyss measures stay within ±5% of main.
    - Bodies over the shallows keep their rim at least 40 luminance levels above the water (M6 T10's in-game check).
    - DESIGN §2 (Sunlight and marine snow) gets the new strengths.
  - Notes: the owner liked the depth-zone background, so keep the colours and fog. Only the shallows' busy effects calm down: caustic contrast and speed, god rays, and caustics over bodies. T10 removes the UV shimmer overlay.

- [ ] T9 The HUD shell: one menu button and stat bars [opus]
  - Acceptance (E2E `m6b-hud.spec.ts`, unit tests for the pure parts):
    - **In play, with no event pending**, at 1280×720 and 960×540, the visible HUD is:
      - one round menu button in the top-left corner (`hud-menu`; a 44 px target, an SVG profile glyph, `aria-label="Menu (Esc)"`);
      - four thin stat bars in the bottom-left corner: health, energy, size toward adult with a tick at the 60% maturity size, and life left. Each has its own icon shape, `role="meter"` and `aria-valuenow`, and its value as a tooltip;
      - until T10, a compact depth bar.

      These elements' boxes together cover at most 6% of the viewport (the M6 HUD covered about 9% at 1280×720). No text is permanently visible: a test lists the visible text nodes under `[data-for="playing"]` and allows only toasts, chat lines, labels over creatures, edge-indicator labels, the first-life hints and the chips below.
    - **Chips** appear beside the bars only while they apply:
      - an egg with `H` while a child is carried;
      - a heart while ready to mate;
      - "Not recorded" on a practice cell;
      - an offline dot when the hub is unreachable.

      `state().hud` reports the menu, bars, chips and hints.
    - **The menu** (button or Esc) opens a panel that holds everything the play screen dropped:
      - the species and rarity;
      - biomass, energy %, health, "Size 62% of adult" with "Mature in 4:10", the life stage and time left, and mating readiness;
      - buttons for Lineage, Settings and Controls;
      - Players (the roster: click a name to mute);
      - the build label.

      Esc or the button closes it, and steering carries on under it. The title screen keeps its own buttons, and its build label stays.
    - **Hints.** The two control lines and the social line leave the play screen. On a browser's first life a short hint fades in at the bottom for 8 s: "Mouse or WASD to swim · Space to dash". After 30 s of play a second one shows: "G wheel · M map · Enter chat". Later lives show none. The choice is stored in `localStorage['bs.hints']`, and every read and write is wrapped in try and catch. The Controls section of the menu always lists all the keys.
    - **Toasts, the mate hint, invitations and the offspring card** keep working, restyled to match. The edge indicators keep clear of the corners the HUD uses.
    - **No test is weakened.** Existing test ids (`hud-biomass`, `hud-energy`, `hud-health`, `hud-growth`, `hud-remaining`, `hud-ready`, `hud-egg`, `roster`, `build-label` and the rest) stay, inside the menu where they moved. An E2E that reads a moved element opens the menu first; no assertion is dropped.
    - DESIGN §5, §9 and §10 (HUD) follow.
  - Notes:
    - Text stays plain, and colour is never the only signal: icons differ in shape.
    - Take a 1280×720 screenshot before and after for the PR, judged by eye against "minimal and uncluttered".

- [ ] T10 The minimap, and shaking instead of borders [opus]
  - Acceptance:
    - **The minimap** (`src/game/minimap.ts`, top-right corner, round, 12% of the viewport's short side and at least 120 px):
      - it is north-up and centred on the player, covering 6 view half-heights;
      - it shows the zones' colours from the pond's depth map, the pond's edge when near, other players as dots shaped by size class (the shapes of DESIGN §9), mate-ready hearts, live pings, and the player as an arrow on its heading;
      - a depth arc on its rim marks the player's depth, with the zone's name in small type under it; this replaces the depth gauge;
      - a UV or pressure icon (shape, not colour alone) sits on the rim while that hazard hurts;
      - a click on it, or `M`, opens the full pond map;
      - it draws on a 2D canvas at most 10 times a second, with no per-frame allocations (M6 T26's heap check still holds).

      `state().minimap` reports it.
    - **E2E `m6b-minimap.spec.ts`** (two contexts, hub 8802): B placed 2 views from A shows on A's minimap at B's bearing within 5°, and a ping by B shows there for its lifetime. `debug.setZone` checks the zone name and the hazard icon.
    - **Shake instead of borders.** The red edge vignette and the `uv-cue` and `pressure-cue` overlays are removed for every damage over time: UV, pressure, toxin and starvation.
      - The body shakes (a render offset of at most 6% of its radius: UV a fast fine tremble, pressure a slow squeeze, toxin and starvation a short jolt).
      - The camera shakes by at most 1.5 CSS px while the damage lasts.
      - Under Reduce motion, neither shakes. The body's red pulse and a flash of the health bar remain in every case.
      - The HUD and the DOM never shake, and the sim is untouched.

      `render.fx().shake` reports the offsets. `m1-feel`'s "damage raises the vignette" and the UV and pressure steps of `m6-lifecycle` now assert the shake and the hazard icon: the cue changed, so the tests change, and no assertion is dropped. Every damage source keeps a visible and an audible cue (`.claude/rules/game.md`).
    - DESIGN §2 (zones on screen), §9 (finding players) and §10 (Damage, UV and pressure, presentation timings) follow; the spec wrote the shape.
  - Notes: reuse `pond-map.ts`'s zone canvas and marks where possible. The full map stays as it is, apart from its style.

### The egg

- [ ] T11 The egg reveal as a gacha moment [opus]
  - Acceptance (unit tests on the reveal timeline in `render/egg.ts` first, then E2E `m6b-egg.spec.ts` on hub 8801):
    - **Waiting** (from the request until the beacon):
      - the egg drops in over 0.4 s, then rests: sampled at 10 Hz over 2 s with no input, `state().egg.angle` stays within 0.01 rad, while its glow breathes slowly;
      - **reactive**: a click on the egg (or Space during a genesis) gives one damped wobble (a peak of 0.1–0.2 rad, back within 0.01 rad in 1 s), and during a genesis it leans at most 0.05 rad toward a nearby cursor;
      - after 10 s a small "Waiting for the beacon…" line shows under it. It never wiggles steadily.
    - **Stirring** (new phase): it starts when the beacon arrives (the `genesis` event, or the child's check for a mating). It lasts 1.2 s for common up to 1.8 s for exotic, and it holds the hatch until it ends.
      - Three twitch bursts, each stronger, with shorter pauses between them.
      - From the second burst, light leaks through in the rarity colour (`EGG_TINT`): the rarity tell, on the player's own eggs only.
      - A soft rising `stir` cue plays (a new `Cue`, with `CUE_SOUNDS`, its render check and DESIGN §10's sound column).
    - **Cracking and the burst** follow M6's flourish by tier, plus shell shards and, for rare and exotic, light rays.
    - **The result card**:
      - after a genesis (from the title or the death screen), a card shows the creature's preview, species name, rarity with 1–4 stars and its silhouette class. It slides away after 3 s or on a click or key, and the game is already playable underneath;
      - after a mating, the offspring card gets the same rarity frame and stars;
      - `state().egg.card` reports it.
    - **Skip.** A click or Enter during stirring or cracking jumps to the burst.
    - **Time cap.** From the beacon to the burst, where the creature comes out and play begins, takes at most 2.2 s for common and 4 s for exotic, not counting the hub's verification. Stirring plus M6's crack times fit: 1.2 + 0.9 s and 1.8 + 2.1 s.
    - **Nothing covers the egg.** During a genesis from the title or the death screen ("Hatch again"), the egg sits at the screen's centre, and both screens hide their menus and pass pointer events through. `document.elementFromPoint` at the egg's centre, and at four points 0.8 of its radius out, returns the canvas on both paths. The current bug: the death screen stays up while the egg waits.
    - **Reduced motion.** No drop, wobble or twitch: the glow pulses instead, and the burst fades.
    - `state().egg.phases` show `waiting`, `stirring`, `cracking`, `revealed` in order for a genesis and for a mating. `m6-egg.spec.ts` is updated to the new order.
    - DESIGN §10 (Beacon reveal row, The egg) follows; the spec wrote the shape.
  - Notes: no protocol change. The stir starts on the beacon's arrival, because only then is the hatch certain, which is what "wiggles only right before hatching" asks. Hatching the carried egg (`H`) keeps M6's sequence, now with the card styling.

### Closing

- [ ] T12 Look pass 6, the one pass [opus]
  - Acceptance (ADR 0034):
    - `npm run gallery -- --pass 6` is committed with `pass-6.md`. The note holds:
      - ADR 0024's gap table against references 02–05, where the 04 and 05 columns judge the rare and exotic specimens only;
      - the "Against pass 1" table, with each aspect `better`, `same` or `worse` and a sentence;
      - the "Largest gaps" list.

      `tools/gallery-notes.ts` checks the second table for passes 6 and on, and fails on a missing aspect or any other word.
    - **Method:** each reference and `pass-1.png` side by side with the sheet, never scored from memory, with cells enlarged two to four times. Fix the largest gaps one session allows (render tuning only, no new mechanics), then re-render and commit the sheet after the fixes.
    - **The in-game check** at 960×540 and default zoom, with gallery bodies as remotes, in the shallows, the twilight and the deep, with the new HUD on screen, is noted in `pass-6.md`.
    - `m6b-clip.spec.ts` and T3's measures pass on the final sheet.
    - **The bar** (rubric): no aspect worse than pass 1, silhouette variety and fine appendages better; against 02 and 03 no cell above 1; against 04 and 05 no cell above 2. If it fails, the note and the PR say which cells fail and why. There is no pass 7.
    - The PR body summarises pass 1 → pass 5 → pass 6 for the owner.
  - Notes: "never call a pass done because the tests are green". `docs/art/README.md` names pass 1 as the realism baseline and pass 6 as M6b's pass.

- [ ] T13 End-to-end scenario, genesis freeze and documentation sync
  - Acceptance:
    - `m6b-lifecycle.spec.ts` (`@slow`, hub 8803, `?quality=medium`) walks the end-to-end check below, asserting `render.info()` budgets at every step.
    - **Freeze rules 7 genesis**: `genesis-v7.ts` and `genesis-v7.json`; `genesisFor` picks v5, v6, v7 or current by `rules`. `.claude/rules/genome.md` lists it as frozen, with ADR 0035's rule for development and stats.
    - **Docs:**
      - DESIGN §2–§6, §9 and §10 match the shipped numbers and code tables, and the header says rules version 7;
      - `.claude/rules/render.md` gets the clipping rule and the removed haze;
      - `.claude/rules/game.md` gets the HUD rules (one menu button, no permanent text, shake not borders);
      - `.claude/rules/tests.md` gets the new hooks, the hub ports and `look-metrics.ts`;
      - `docs/art/README.md` follows.
    - Record the PR E2E suite time in CI. M6b adds at most 30 s, and any spec over 20 s is `@slow`.
  - Notes: the milestone step sets the ROADMAP status and opens the `Playtest: v0.7.1` issue with the owner checks below.

## End-to-end check

Against the fixture authority and a build at `?quality=medium` (`m6b-lifecycle.spec.ts`, release gate):

1. **Title, Hatch.** The egg rests with no wiggle (`angle` within 0.01 rad) until the beacon, then goes `stirring` → `cracking` → `revealed`. Nothing covers it (`elementFromPoint`), and the result card shows the rarity.
2. **Play.** Only the menu button, the four bars and the minimap are visible. Esc opens the menu with the numbers.
3. **Speed.** Swimming at full throttle, `state().player.speed` stays within the band (0.6–1.6× the starter's top speed at that biomass).
4. **The wheel.** Held open for 1 s mid-swim, the creature keeps at least 80% of its pace, and a ping reaches the minimap.
5. **Hazards.** In the shallows (UV) and the abyss (pressure), the body and the camera shake, the minimap shows the hazard icon, and no edge vignette or overlay appears.
6. **Death and Hatch again.** After a pressure death the death screen names `pressure`, and "Hatch again" plays the reveal with nothing covering the egg.
7. **Look**, in the `post` project with the gallery: `m6b-clip.spec.ts` (at most 12 solid-white pixels per cell) and `m6b-look.spec.ts` (colour in the organs, a clear shell) pass.

Exit criteria map (ROADMAP M6b):
- creatures return to the pass-1 glassy realism without the milky haze, white clipping or artificial glow: T3, T4, T12;
- long bodies that read as worms, shrimps and copepods: T5, T6, T7, T12;
- a minimal gameplay HUD (one profile or settings icon, progress-bar stats, a modern minimap, no red hazard borders): T9, T10;
- a reactive gacha-style egg reveal: T11;
- the wheel no longer stops movement: T2;
- creature speed reviewed: T1;
- calmer shallows: T8;
- one pass, no pass series: T12 (ADR 0034);
- (owner) the look and the HUD hold up: the owner checks below, at the gate;
- end-to-end: T13.

## Rubric

- [ ] Bodies keep pass 1's realism: clear glass, organs sized and coloured as in pass 1, no milky haze, no artificial glow (evidence: T3's two measures and crops, and `pass-6.md`'s "Against pass 1" table with no aspect worse).
- [ ] Nothing clips to white: every gallery cell, and every body in the in-game check, has at most 12 solid-white pixels (evidence: `m6b-clip.spec.ts`).
- [ ] Long bodies read as worms, shrimps, copepods and spirals (evidence: T5–T7 plan tests and the pass 6 sheet's long-body cells).
- [ ] The pass 6 bar of ADR 0034 holds: silhouette variety and fine appendages better than pass 1; no cell above 1 against 02 and 03; no cell above 2 against 04 and 05 on rare and exotic bodies (evidence: `pass-6.md`).
- [ ] The play screen is minimal: one menu button, four bars and the minimap, at most 6% of the screen, with no permanent text (evidence: `m6b-hud.spec.ts` and the before and after screenshots in the T9 and T10 PRs).
- [ ] Damage shakes slightly and never paints a border (evidence: T10's E2E and `render.fx().shake`).
- [ ] The egg rests until the beacon, stirs, cracks and bursts by rarity, and nothing covers it, after a death too (evidence: `m6b-egg.spec.ts`).
- [ ] The wheel keeps your movement (evidence: T2's E2E).
- [ ] Every body's top speed lies in the band, and DESIGN §4 answers "bug or design" (evidence: `npm run report:speed` and T1's property test).
- [ ] The shallows are calmer, and the zones still read apart (evidence: T8's measures).
- [ ] (owner) The creatures keep the glassy realism of pass 1, and the long bodies look like real worms, shrimps and copepods.
- [ ] (owner) The HUD feels clean and modern, and the minimap is useful.
- [ ] (owner) The egg reveal feels polished, like a gacha reveal.
- [ ] (owner) Movement feels right: no creature is way too fast, and the wheel never stops you.
- [ ] (owner) The shallows feel calmer, and the depth zones still look as good as in v0.7.0.

## Risks

- **Restoring pass 1 throws away later gains.** ADR 0034 lists what stays (pearls, set-in eyes, plumose setae, clear broad parts, long antennae), and T3 compares crops against both pass 1 and main.
- **Long-body development breaks the balance.** Stats read the girth (ADR 0031), the speed band bounds speed (T1), and every development task reruns the balance checks.
- **Spirals longer than the reach unbalance curled bodies.** T6 re-tunes the curl terms. As a fallback it caps the extra length and records that in its ADR.
- **Rules 7 changes living creatures' bodies.** ADR 0035 accepts this before M7. Genomes, records and the authority's clamps do not change, and old clients must reload (`PROTOCOL_VERSION` 5).
- **The HUD rework breaks many E2E selectors.** Test ids stay, moved elements sit inside the menu, tests open the menu where needed, and no assertion is dropped (T9).
- **The stir lengthens the wait.** It is capped (T11's time cap, at most 1.8 s), can be skipped, and starts only when the hatch is certain.
- **Software rendering hides how the look plays on real hardware.** The look is judged on a fixed sheet against pass 1 and the references, and the owner judges it on real hardware at the gate.
- **Pass 6 misses the bar.** ADR 0034 allows no pass 7. The gaps go to the owner at the gate, with the evidence.
- **The PR E2E suite grows past its budget.** New screenshot and lifecycle specs are `@slow` when they take over 20 s, and T13 records the suite time.
