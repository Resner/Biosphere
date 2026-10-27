# 0004: Rendering with Three.js and WebGL2 over a 2D gameplay plane

- Status: accepted (the half-resolution depth of field superseded by 0027)
- Date: 2026-10-25

## Context

The brief asks for polished 3D organisms in a top-down 2D world (Three.js), a macro-photography look (shallow depth of field, translucent membranes, caustics, bioluminescence), 60 fps on integrated graphics at the default preset, and low, medium and high presets. Targets are current desktop Chrome, Edge, Firefox and Safari. CI and cloud sessions have no GPU. Their headless Chromium renders WebGL2 through SwiftShader and exposes no WebGPU (`navigator.gpu` is missing, checked on 2026-10-25).

## Decision

- **`THREE.WebGLRenderer` (WebGL2), with GLSL `ShaderMaterial`s** for membranes, water, particles and post effects. Shaders live in `src/render/shaders/*.glsl`, imported with `?raw`.
- **Camera**: perspective, looking down the z axis at the x–y gameplay plane. z is presentation only: creature thickness, particle layers above and below the focus plane, a slight tilt for depth. The camera follows the player and zooms out as the creature grows (the zoom curve is in `docs/DESIGN.md`).
- **Render reads, never writes.** Each frame interpolates between the last two sim ticks (`alpha`) and reads sim snapshots. Nothing in `src/render` changes sim state or outcomes.
- **Creatures**: one merged `BufferGeometry` per genome, built from its body plan (M3). Swimming gait, beating and pulsing are animated in the vertex shader from uniforms (time, speed, phase). Meshes are cached by genome hash and built at most once per creature. A low-detail mesh is used at distance.
- **Many small things** (food, particles, carrion) use `InstancedMesh` or `Points`.
- **Post-processing**: our own short chain of half-resolution depth of field (circle of confusion from depth), dual-filter bloom, grade, vignette, grain and subtle chromatic aberration. Each preset turns passes on or off and sets resolution scales.
- **Presets** low, medium and high, with an automatic default and adaptive resolution. Each preset has budgets (draw calls, triangles, render-target memory) checked through `renderer.info` in E2E (M6).
- **Evidence for visuals**: screenshots decoded and checked for properties in E2E (non-blank, contrast, element present). There are no pixel-exact baselines, because software rendering changes between browser versions. Frame rate on real hardware is an owner check.

## Consequences

- One rendering path that works the same in CI and on players' machines. GPU-specific behaviour (performance, driver quirks) is only seen in owner playtests.
- Visual polish depends on hand-written shaders, a chain the factory owns, so it changes only when we change it.
- Rejected:
  - `WebGPURenderer` and TSL: no WebGPU in CI, and the node and post-processing APIs churned between r179 and r185;
  - `pmndrs/postprocessing` as a hard dependency (may be revisited for single passes in M6 if it saves code);
  - Babylon.js and PlayCanvas (the brief names Three.js);
  - a 2D canvas or Pixi renderer (no 3D organisms).
