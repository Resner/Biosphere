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
- Budgets per preset (`docs/DESIGN.md` §12) are checked through `renderer.info` in E2E. CI renders in software: judge visuals by screenshot properties, never by frame rate.
- Art direction:
  - dark water, backlight and rim light, translucent membranes with internal glints, shallow depth of field, caustics in the shallows, bioluminescence in the deep;
  - silhouettes readable at a glance;
  - gameplay parts (mouths, weapons, plates) recognisable at default zoom.
- No Spore or EA names, assets or likenesses. All assets are procedural or original.
