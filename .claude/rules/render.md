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
- Pass 1 is the realism baseline (ADR 0034, amended by ADR 0043): pass 1's glass face and soft fresnel rim, organs at pass 1's size and midline band, and no milky haze (no organ halos, no scattered-light band inside the rim). Organs keep to two related tones: the main colour (the hue gene) and one second tone 0.04–0.10 turns away at another value (or, for a child whose parents' hues differ, the other inherited hue, up to 0.16 turns away: ADR 0049), never complementary; droplets, chambers and glint rays use only these two, and the iris takes the main colour. At most two organs (the heart, or the largest chamber) glow faintly inside their own outline (at most +15% luminance, +35% with the luminescence gene); nothing glows outside an organ. Rarity raises saturation, glints and glow, never the spread of hues.
- Nothing clips to white: a gallery cell or an in-game body has at most 12 solid-white pixels (min(R, G, B) ≥ 245 with all eight neighbours too; `m6b-clip.spec.ts`, `look-metrics.ts`). Judge a look change against `docs/art/gallery/pass-1.png` side by side, never from memory, and add no pass series: M6c's `pass-7` (rules 8, ADR 0043) is the only one.
- Art direction:
  - dark water, backlight and rim light, translucent membranes with internal glints, shallow depth of field, caustics in the shallows, bioluminescence in the deep;
  - silhouettes readable at a glance;
  - gameplay parts (mouths, weapons, plates) recognisable at default zoom.
- No Spore or EA names, assets or likenesses. All assets are procedural or original.
