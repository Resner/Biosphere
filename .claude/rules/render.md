---
paths:
  - "src/render/**"
  - "**/*.glsl"
---

# Rendering (`src/render`)

ADR 0004 is the contract; `docs/art/` is the look.

- Render reads sim snapshots and interpolates with `alpha`. It never writes sim state or decides an outcome.
- WebGL2 through `THREE.WebGLRenderer` and GLSL only. No `three/webgpu`, no TSL.
- Dispose of geometries, materials, textures and render targets when their entity goes away; sessions last hours.
- No per-frame allocations in the render loop (vectors, arrays, closures). Reuse scratch objects.
- One merged geometry per creature, cached by genome hash. `InstancedMesh` or `Points` for food, particles and carrion.
- The post chain (`src/render/post/`, M6) draws the scene into a half-float target, then composites bloom, grade and vignette (plus grain and chromatic aberration on high); low renders straight to the canvas. Adding a pass means counting its targets in `PRESETS[…].budget.targetBytes`; `render.info()` reports `passes` and `targets`.
- Budgets per preset (`PRESETS[…].budget`: draw calls, triangles, target bytes; `docs/DESIGN.md` §12) are checked through `renderer.info` in E2E (`m6-budget.spec.ts`, and every step of `m6-lifecycle.spec.ts`). Nothing allocates per frame: the budget spec forces a GC and the heap stays level.
- Level of detail: a creature mesh carries the preset's level (high 12,000 vertices, medium 6,000, low 1,500) and drops to low under 12 px of radius. A lower level lowers detail and never drops a part. CI renders in software: judge visuals by screenshot properties, never by frame rate.
- Art direction:
  - dark water, backlight and rim light, translucent membranes with internal glints, shallow depth of field, caustics in the shallows, bioluminescence in the deep;
  - silhouettes readable at a glance;
  - gameplay parts (mouths, weapons, plates) recognisable at default zoom.
- No Spore or EA names, assets or likenesses. All assets are procedural or original.
