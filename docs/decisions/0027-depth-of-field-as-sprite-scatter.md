# 0027: Depth of field as a per-sprite scatter

- Status: accepted (supersedes "half-resolution depth of field" in the post-processing bullet of 0004)
- Date: 2026-10-27

## Context

ADR 0004 asks for a half-resolution depth of field with the circle of confusion (CoC) from depth, and the M6 presets called it half-res on medium and full on high. Biosphere's camera looks down on one gameplay plane: creatures, food and plumes all lie on it and must stay sharp, and the only things off the plane are the particle layers (far and near bokeh, marine snow), whose depths are known per speck. They are point sprites that cover about 0.4 of the screen in all. A gathered blur, even from half-resolution layer targets, costs at least one full-screen pass per layer: in M6 T3, two such composites made a medium frame about a third slower in software GL, and on an integrated GPU they move more memory than the sprites they blur.

## Decision

- Each off-plane speck draws its own CoC (a scatter): its sprite grows by the CoC of its depth, its edge widens by the CoC on both sides, and its peak falls so that it carries the same light. On high, bright discs get a chromatic fringe (red out, blue in). `src/render/post/dof.ts` holds the curve and a CPU mirror of the shape; `particles.vert.glsl` draws it.
- Depth is in camera heights, 0 at the gameplay plane; a layer's parallax and its depth are the same fact (`p = 1 / (1 - z)`). The focus plane follows the player's creature at the plane.
- The presets differ in strength, not resolution: the CoC is capped at 6 px on medium ("half") and 12 px on high ("full"), at a pixel ratio of 1. Low draws the plain sprites with no DOF. The `dof` pass appears in the post plan but adds no render target.

## Consequences

- Exact for points, free of halos and depth-buffer artefacts, and cheaper than any gather; the half-resolution saving 0004 aimed for is not needed.
- Anything else that ever leaves the plane (say, a creature diving in a later milestone) needs its own blur: a gather pass would then return, and this ADR would be revisited.
- Rejected: a layered gather on half-resolution targets (a full-screen pass per layer, slower than the sprites it blurs); a full-screen depth-buffer gather (costlier still, and nothing on the plane needs it).
