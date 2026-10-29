# Budget report

Written by `npm run report:budget` on 2026-10-29 at ffe17f3 (Chromium 153.0.8010.12). Each scene is the game at a 1920×1080 drawing buffer (pixel ratio 1) with the world frozen, read from `render.info()` once every body is drawn. The budgets are DESIGN §12; the render-target memory budget holds for that drawing buffer. CI and cloud sessions render in software, so this is no measure of frame rate: 60 fps at the default preset is the owner's check on real hardware. The same scenes are asserted by `m6-budget.spec.ts`.

Scenes:

- **empty**: the twilight spawn, the player alone.
- **crowded**: the shallows (caustics, god rays), 24 bodies, a plume, carried eggs, size outlines.
- **abyss**: the abyss (glow pools, vent crystals, dark-zone sight), the same 24 bodies.

## Low

Budget: 80 calls, 150,000 triangles, no render target. Passes: none (direct to the canvas).

| Scene | Bodies | Draw calls | Triangles | Targets | Target memory (MB) | Within budget |
|-------|--------|------------|-----------|---------|--------------------|---------------|
| empty | 1 | 8 (10%) | 1,650 (1%) | 0 | 0.0 | yes |
| crowded | 25 | 35 (44%) | 22,886 (15%) | 0 | 0.0 | yes |
| abyss | 25 | 36 (45%) | 22,868 (15%) | 0 | 0.0 | yes |

## Medium

Budget: 150 calls, 300,000 triangles, 48.0 MB of render targets. Passes: scene, refraction, dof, bloom, grade, vignette.

| Scene | Bodies | Draw calls | Triangles | Targets | Target memory (MB) | Within budget |
|-------|--------|------------|-----------|---------|--------------------|---------------|
| empty | 1 | 21 (14%) | 4,554 (2%) | 6 | 26.2 | yes |
| crowded | 25 | 49 (33%) | 75,032 (25%) | 6 | 26.2 | yes |
| abyss | 25 | 51 (34%) | 75,048 (25%) | 6 | 26.2 | yes |

## High

Budget: 250 calls, 600,000 triangles, 96.0 MB of render targets. Passes: scene, refraction, dof, bloom, grade, vignette, grain, chromatic.

| Scene | Bodies | Draw calls | Triangles | Targets | Target memory (MB) | Within budget |
|-------|--------|------------|-----------|---------|--------------------|---------------|
| empty | 1 | 23 (9%) | 7,662 (1%) | 7 | 26.3 | yes |
| crowded | 25 | 51 (20%) | 152,936 (25%) | 7 | 26.3 | yes |
| abyss | 25 | 53 (21%) | 152,872 (25%) | 7 | 26.3 | yes |

## Verdict

Every preset is within its budgets in every scene.
