# M1: Swim and feed

Release: v0.2.0 · Gate: no

## Goal

On the Pages build, a single player hatches a starter cell, steers it with the mouse (or WASD), dashes, eats drifting nonliving food, burns energy, grows (the camera zooms out), and dies of starvation or a toxic plume. A death screen names the cause, and the player can hatch again. The fixed-tick deterministic simulation (`src/sim`) runs separately from rendering, and a recorded input log replays to the same state hash in Node and Chromium. The base macro look is in place: dark water with caustics, a translucent rim-lit membrane, bokeh particle layers.

## Out of scope

- Multiplayer, identity and the authority (M2, M4).
- Genome and morphology (M3). The starter cell's look varies only by a local random hue.
- Combat, mating, depth zones, UV and pressure (M5–M7).
- Quality presets, real post-processing depth of field, audio (M6).

## Touches

New code areas: `src/sim/` (shared, deterministic) and `src/game/`. `src/render/preview.ts` is replaced; the title screen keeps a live scene.

`src/sim/math.ts` — deterministic math (ADR 0005):

```ts
export const PI: number; export const TAU: number;
export function sin(x: number): number;
export function cos(x: number): number;
export function atan2(y: number, x: number): number;
export function exp(x: number): number;
export function log(x: number): number;          // x > 0
export function pow(x: number, y: number): number; // x > 0
export function wrapAngle(a: number): number;      // to (-PI, PI]
export function clamp(x: number, lo: number, hi: number): number;
export function lerp(a: number, b: number, t: number): number;
export function length(x: number, y: number): number;
```

`src/sim/prng.ts`:

```ts
export type Seed = readonly [number, number, number, number]; // four u32
export function seedFromString(text: string): Seed;
export function seedFromBytes(bytes: Uint8Array): Seed;
export interface Rng { nextU32(): number; next(): number; range(lo: number, hi: number): number; int(lo: number, hi: number): number }
export function createRng(seed: Seed, purpose: string): Rng; // xoshiro128**, SplitMix32-seeded
export function hashU32(...values: number[]): number;        // stateless integer hash
```

`src/sim/hash.ts`: `class Hasher { u32(n); i32(n); f64(n); str(s); bytes(b); digest(): string }`, where the digest is 16 hex characters from two 32-bit lanes; `hash64(bytes: Uint8Array): string`.

`src/sim/rules.ts`: `RULES_VERSION = 1`, `TICK_HZ = 30`, `DT`, and a deep-frozen `RULES` object holding every number from `docs/DESIGN.md` §2–§4 (starter, movement, metabolism, growth, food, hazards, currents, world, camera).

`src/sim/types.ts`:

```ts
export interface Vec2 { x: number; y: number }
export type DeathCause = 'starved' | 'toxin' | 'old-age' | 'uv' | 'pressure' | 'killed';
export interface CreatureState {
  id: string; x: number; y: number; vx: number; vy: number; heading: number;
  biomass: number; energy: number; health: number;
  dashReadyTick: number; alive: boolean; cause: DeathCause | null; bornTick: number;
}
export type FoodKind = 'detritus' | 'globule' | 'crystal';
export interface FoodItem { id: string; kind: FoodKind; x: number; y: number; value: number; radius: number; respawnTick: number }
export interface World {
  rules: number; seed: string; seed32: Seed; tick: number; size: number;
  creatures: CreatureState[];          // always sorted by id
  consumed: Record<string, number>;    // food id → tick it respawns
  options: { currents: boolean; hazards: boolean };
}
export type StepEvent =
  | { type: 'eat'; creature: string; food: string; value: number }
  | { type: 'damage'; creature: string; amount: number; cause: DeathCause }
  | { type: 'death'; creature: string; cause: DeathCause }
  | { type: 'dash'; creature: string }
  | { type: 'grow'; creature: string; biomass: number };
```

Other `src/sim` modules:

- `input.ts`: `Input { steer: 0..255; throttle: 0..15; dash: boolean }`, `IDLE`, `encodeInput(i): number` (u16), `decodeInput(n)`, `steerToAngle(steer)`, `angleToSteer(angle)`. Angle 0 points east (+x) and grows counter-clockwise; world y points up.
- `world.ts`: `createWorld(opts: { seed: string; size?: number; currents?: boolean; hazards?: boolean }): World` and `spawnCreature(world, { id, x, y, biomass? }): CreatureState`.
- `physics.ts`: `applyMovement(world, creature, input): StepEvent[]`.
- `food.ts`: `foodInCell(world, cx, cy): FoodItem[]`, `foodNear(world, x, y, radius): FoodItem[]`, `consumeFood(world, id): void`.
- `currents.ts`: `currentAt(world, x, y): Vec2`.
- `hazards.ts`: `plumesNear(world, x, y, radius): Plume[]`, where `Plume = { id; x; y; radius }` is a pure function of the seed and tick.
- `metabolism.ts`: `applyMetabolism(world, creature, input): StepEvent[]`.
- `step.ts`: `step(world: World, inputs: Readonly<Record<string, Input>>): StepEvent[]`. Within a tick, for each creature in id order: movement → feeding → metabolism and growth → hazards → death.
- `state-hash.ts`: `hashWorld(world): string`.
- `replay.ts`: `InputLog { rules; seed; spawn: { id; x; y }; ticks; runs: [tick: number, input: number][] }` (run-length encoded), `replay(log): { hash: string; world: World; events: Record<string, number> }`, `recordInputs(inputs: Input[]): InputLog['runs']`.

`src/game/`:

- `loop.ts`: `createLoop({ now, tick, render, maxTicksPerFrame = 5 })` → `{ frame(): void; stats(): { ticks: number; skippedMs: number } }`.
- `input.ts`: `mouseToInput(pointer, creatureScreenPos, pxPerWu, radius): Input`, `keysToInput(keys: ReadonlySet<string>): Input | null`, `class InputController`.
- `app.ts` (wiring), `hud.ts`, `screens.ts` (title / playing / dead).
- `debug.ts`: the `window.__bs` test hook, described under T9.

`src/render/`:

- `scene.ts` (renderer, resize, frame).
- `camera.ts`: `viewHalfHeight(r)` = `9·r^0.9`, plus `FollowCamera` with smoothing.
- `water.ts` (backdrop with caustics and haze), `cell.ts` (membrane, nucleus, organelle glints, flagellum), `food.ts` (one `InstancedMesh` per kind), `particles.ts` (three bokeh layers), `hazards.ts` (plumes), `effects.ts` (eat pop, damage vignette, dash ripple, death dissolve).
- `shaders/*.glsl`, imported with `?raw`.

## Tasks

- [x] T1 Deterministic math, PRNG and hashing
  - Acceptance:
    - Accuracy against `Math.*` over 100,000 samples from `createRng`:
      - `sin` and `cos`: absolute error ≤ 1e-12 for x in [−1e4, 1e4];
      - `atan2`: absolute error ≤ 1e-12 for random (y, x);
      - `exp`: relative error ≤ 1e-12 for x in [−50, 50];
      - `log`: relative error ≤ 1e-12 for x in [1e-6, 1e6];
      - `pow`: relative error ≤ 1e-11 for x in [1e-3, 1e6] and y in [−3, 3].
    - Golden table `src/sim/__golden__/math.json` (64 inputs per function, outputs as 16-hex-digit IEEE bit patterns): every output matches bit for bit.
    - `createRng(seedFromString('biosphere'), 'food')`: the first five `nextU32()` values equal the frozen values in the test. Purpose `'hazard'` gives a different first value. `int(0, 9)` over 100,000 draws fills each bucket to 10,000 ± 3%.
    - `hashU32(1, 2, 3)` is frozen, and changing any argument changes the result. `hash64(utf8('biosphere'))` is frozen, and flipping one input bit changes the digest. `new Hasher().f64(NaN)` throws.
    - Guard test (`src/sim/determinism.test.ts`): reading every `src/sim/**/*.ts` that isn't a test finds none of `Math.random`, `Math.sin`, `Math.cos`, `Math.tan`, `Math.atan`, `Math.exp`, `Math.log`, `Math.pow`, `Math.hypot`, `Math.cbrt`, `Date`, `performance`, `crypto`, `setTimeout`, `setInterval`, `requestAnimationFrame`, `window`, `document`, `from 'three'`, `from '../render`, `from '../net`. The same scanner reports the fixture string `const x = Math.random();`.
  - Notes:
    - Cody–Waite range reduction with π/2 split into three parts, then minimax polynomials on [−π/4, π/4].
    - `exp` = 2^k·p(r). `log` decomposes the double with a `DataView` (exponent and mantissa), because `Math.log2` is banned too.
    - Generate the golden files once with `UPDATE_GOLDENS=1 npx vitest run src/sim` and freeze them. After that they change only with a `RULES_VERSION` bump.
  - Done: `math.ts`, `prng.ts`, `hash.ts` use fdlibm kernels (all accuracy targets met); the guard allows only the exactly specified `Math.*` members and flags aliasing, `**` and `globalThis`.
  - Gotcha: `sin`/`cos` are accurate to about |x| 1e6 (callers pass wrapped angles); `exp` clamps, `log`/`pow` throw outside their domain.

- [x] T2 Rules, world state and state hash
  - Acceptance:
    - `hashWorld(createWorld({ seed: 'pond-1' }))` is equal across two calls, and seed `'pond-2'` gives a different hash.
    - With two creatures spawned in either order, `world.creatures` is sorted by id and the hashes are equal.
    - Changing `creatures[0].x` by 1e-9, or any other field, changes the hash.
    - `Object.isFrozen(RULES)` holds for every nested object.
    - `structuredClone(world)` deep-equals `world` and hashes the same.
    - `spawnCreature` defaults: biomass 100, energy 120 (60% of 200), health 100, `alive: true`.
  - Notes: the state hash walks fields in a fixed order (it never relies on `JSON.stringify` key order).
  - Done: `rules.ts` (deep-frozen `RULES` for DESIGN §2–§4), `types.ts`, `world.ts`, `state-hash.ts`; `consumed` ids are hashed in sorted order.
  - Gotcha: `hashWorld` throws on NaN/Infinity (via `Hasher.f64`); `options.currents`/`hazards` default to true.

- [x] T3 Movement physics and input encoding
  - Acceptance:
    - `decodeInput(encodeInput(i))` equals `i` for all 256 × 16 × 2 inputs.
    - With currents off, a starter at rest given steer 0 (east) and throttle 15 for 60 ticks moves 98.7 wu ± 5% east (closed form `a/k·t − a/k²·(1 − e^(−kt))` with a = 140, k = 2.2, t = 2 s).
    - From 60 wu/s with throttle 0, speed drops below 0.1 wu/s within 90 ticks.
    - Heading turns toward the steer angle at 5 rad/s: a 180° turn completes within 30 ticks. Thrust acts along the heading.
    - Dash adds 120 wu/s along the heading and costs 6 energy for a starter. A second dash within 75 ticks is ignored, with no event.
    - Driven toward x < 0 for 300 ticks, a creature never leaves [0, size] (soft wall within 64 wu of the edge).
  - Notes: integrate velocity first, then position (semi-implicit Euler).
  - Done: `input.ts` (u16 codec: steer bits 0-7, throttle 8-11, dash 12) and `physics.ts` `applyMovement`; new rule `movement.wallPush` (300 wu/s²).
  - Gotcha: turning needs throttle > 0 and a dash needs the energy for it (both unspecified, so decided here and in DESIGN §4); currents join the movement in T5.

- [x] T4 Food field and feeding
  - Acceptance:
    - `foodInCell(world, 3, 5)` returns identical arrays (ids, kinds, positions) on repeated calls, and a different world seed gives different items.
    - Ids look like `c3_5_s2_k0`.
    - A creature overlapping an item (distance < r + item radius) gets an `eat` event on the next `step`. Its energy rises by the item's value (capped at max), and the item disappears from `foodInCell` until its `respawnTick`, 20–60 s later. Then cycle `k1` of that slot appears at a new deterministic position.
    - Over 1,000 cells, the mean live item count per cell is between 6 and 10, and kinds split detritus : globule : crystal = 70 : 25 : 5 ± 5 points.
    - An item's position is a pure function of the tick and stays within 12 wu of its slot anchor (a bobbing drift).
  - Notes: a cycle's kind, position and respawn delay come from `hashU32(seed32, cx, cy, slot, k, salt)`.
  - Done: `food.ts` plus a first `step.ts` (movement → feeding; tick advances). `World.consumed` is now `slot id → { k, until }`, keyed by slot (`c3_5_s2`).
  - Gotcha: entries are not deleted after `until`, because they are the only record of a slot's cycle `k` (spec said delete; that would reset the slot to `k0`). At most one entry per slot, so growth is bounded. `FoodItem.respawnTick` is the tick the item appeared.

- [x] T5 Metabolism, growth, hazards and death
  - Acceptance:
    - An idle starter loses 8 energy ± 1% over 300 ticks (0.8/s), and 14 ± 1% at full throttle (basal 0.8 plus movement 0.6 per s).
    - At 80% energy, biomass grows by 0.5/s and energy drops by an extra 1.5/s. Radius = √biomass after every tick, and growth stops at 400.
    - With energy at 0, health drops 8/s: a starter dies with cause `starved` at tick 375 ± 1.
    - Inside a plume with energy at the growth threshold (75%): −15 hp/s, death with cause `toxin` at tick 200 ± 1.
    - `currentAt` is smooth (speed differs by < 0.05 wu/s between points 1 wu apart), never exceeds 12 wu/s, and moves a passive creature by the field's integral ± 1%.
    - A dead creature ignores input and emits no further events.
  - Notes: plumes drift deterministically with the currents. Spawn a plume beside the player through a debug hook (T9) for E2E.
  - Done: `metabolism.ts`, `currents.ts` (three shear waves; `currentDriftAt` is the closed-form integral), `hazards.ts` (one plume per anchor cell, drifting at 0.5× the current), and death in `step.ts`. A step is ~0.8 ms for 24 creatures. Currents advect creatures on top of their own velocity.
  - Gotcha: the toxin case starts at 75% energy, not full: above that the creature grows and growth adds health, which delays death by a few ticks (the spec said "full energy"). Food does not drift with currents (it would break the bob-within-12-wu rule); T9's `spawnPlume` needs an extra-plume list on `World`.

- [x] T6 Replay and golden scenarios
  - Acceptance:
    - The files `src/sim/__golden__/idle-starve.json`, `forage-route.json` and `hazard-dash.json` (each an `InputLog` plus the expected hash) replay to the stored hash in Node.
    - Changing one input in a log changes the hash.
    - Replaying 9,000 ticks takes under 1 s in Node.
    - `recordInputs` round trip: decoding the runs gives back the original per-tick inputs.
  - Notes: golden files change only with a `RULES_VERSION` bump (`.claude/rules/sim.md`).
  - Done: `replay.ts` (`replay`, `recordInputs`, `expandRuns`; rejects logs from other rules or with bad runs) and goldens `{ log, hash, events }`, regenerated with `UPDATE_GOLDENS=1 npx vitest run src/sim/replay.test.ts`. 9,000 ticks replay in ~0.1 s.
  - Gotcha: food is dense, so `idle-starve` uses the first grid spawn where nothing drifts into reach; before the first run a creature idles.

- [x] T7 Game loop, input mapping and camera
  - Acceptance:
    - With a fake clock advancing 1,000 ms in 16.67 ms frames, the loop runs exactly 30 ticks, and `render` receives alpha in [0, 1).
    - One 2,000 ms frame runs 5 ticks, and `stats().skippedMs` reports 1,833 ± 1.
    - `mouseToInput`:
      - a cursor 300 px right of the creature (2 px/wu, r = 10) gives steer 0 and throttle 15;
      - within 0.5·r on screen gives throttle 0;
      - up-left at 45° on screen gives steer 96 (135°, with screen y flipped to world y).
    - `keysToInput`: `{ 'w' }` gives steer 64 and throttle 15; `{ 'w', 'd' }` gives steer 32; no keys gives `null` (the mouse is in control).
    - `viewHalfHeight(10)` = 71.4 ± 0.1. It is monotonic, and r / viewHalfHeight(r) stays in [0.1, 0.3] for r in [5, 4,096].
    - The sim pauses while the tab is hidden (single player only).
  - Done: `game/loop.ts` (`createLoop`, `attachVisibilityPause`), `game/input.ts` (`mouseToInput`, `keysToInput`, `InputController`), `render/camera.ts` (`viewHalfHeight`, `FollowCamera`); new `RULES.controls` (dead zone 0.5 r, full throttle at 3 r).
  - Gotcha: a paused loop skips `render` too, and resume does not catch up; the camera's `smoothSeconds` is the time to ~98% of a zoom change.

- [ ] T8 Macro look v1: water, cell, food, particles, plumes (in progress)
  - Acceptance (`tests/e2e/m1-look.spec.ts`, `?debug=1&seed=look`):
    - No console errors and no WebGL warnings during 3 s of play.
    - On a canvas screenshot, the mean luminance of the annulus at 0.9–1.1 of the creature's on-screen radius is more than 2× the mean of the four corner patches (the membrane rim).
    - `__bs.render.info()` reports ≤ 40 calls and ≤ 60,000 triangles.
    - `__bs.state().visibleFood` equals the food instance count the renderer reports.
    - After `__bs.debug.spawnPlume(player.x + 40, player.y)`, the mean colour of the plume region shifts measurably from the frame before.
  - Notes:
    - Membrane: fresnel rim, an inner sparkle of organelle glints, a glowing nucleus, and a flagellum waved in the vertex shader (start from `preview.ts`).
    - Particle layers above and below the plane use soft bokeh sprites (fake depth of field until M6).
    - Food: one `InstancedMesh` per kind with distinct shape and colour (detritus flakes, round globules, faceted crystals).
    - Caustics: an animated procedural pattern on the backdrop.

- [ ] T9 Screens, HUD, test hook and the full loop
  - Acceptance (`tests/e2e/m1-loop.spec.ts`):
    - The title screen shows "Hatch". Clicking it gives `__bs.state().screen === 'playing'`, and the HUD shows biomass 100, energy 60% and health 100.
    - With `?debug=1`: calling `__bs.debug.steerTo(food)` on the nearest food three times gives `__bs.events().eat >= 3`, and energy is higher than its start value minus metabolism.
    - `__bs.debug.setEnergy(0)` followed by `__bs.debug.timeScale(4)`: within 10 s the death screen shows "Starved" with time survived and peak biomass. "Hatch again" starts a new creature with biomass 100.
    - `__bs.replay(log)` for each golden returns the Node golden hash in Chromium.
    - Without `?debug=1`, `__bs.debug` is `undefined`.
  - Notes:
    - `window.__bs = { ready, state(), events(), replay(log), render: { info(), fx() }, debug? }`.
    - `debug` offers `setEnergy`, `teleport`, `steerTo`, `nearestFood`, `spawnPlume` and `timeScale`.
    - Document the hook in `.claude/rules/tests.md` when it lands.

- [ ] T10 Feel and feedback
  - Acceptance:
    - Each eat increments `__bs.render.fx().eat`.
    - While damage is being taken, the vignette intensity is > 0.
    - A dash spawns a ripple (`fx().dash`).
    - The death dissolve runs for at least 1 s before the death screen appears (E2E timing).
    - After `debug` growth from biomass 100 to 400, the view half-height eases to its new value within 1.5 s with no overshoot above 5%.
    - The PR body includes screenshots of the title, play near food, play inside a plume, and the death screen.
  - Notes: tune constants for feel in `rules.ts` (sim) or `src/render` (presentation), and record sim changes in `docs/DESIGN.md`.

## End-to-end check

`tests/e2e/m1-loop.spec.ts`:

1. Hatch, forage three items, starve (debug), see the death screen with the cause, hatch again.
2. Every golden replay hash matches in Chromium.
3. `m1-look.spec.ts` keeps the render budget and the rim-light check green.

## Rubric

- [ ] The membrane reads as translucent with a bright rim; the three food kinds are distinguishable at default zoom (evidence: screenshots in the PR).
- [ ] Particles sit at three depths with soft bokeh discs (evidence: screenshot).
- [ ] The HUD is readable over both dark water and a plume (evidence: screenshot).
- [ ] Steering, dash and growth feel responsive and satisfying (owner).
- [ ] It runs smoothly on the owner's laptop (owner).

## Risks

- Polynomial accuracy versus speed → accuracy and golden tests, plus the replay timing test.
- SwiftShader is slow in E2E → a 960×540 viewport, short scenarios, `timeScale`.
- Feel needs tuning → keep every constant in `rules.ts` and document it in DESIGN.md, so tuning PRs stay small.
