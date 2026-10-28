# 0025: Body plan v2: silhouettes from development, karyotype v2

- Status: accepted (extends 0006 and 0018; supersedes the development vertex cap of 0006, which moves to rendering; the chain layout and the part fit follow the karyotype since 0028)
- Date: 2026-10-27

## Context

The owner's bar for M6 (#90, `docs/art/reference-02.jpg` to `reference-05.jpg`) is a range of distinct micro-organisms: copepods and shrimp with long antennae, curled and S-shaped worms, nautilus-like coils, tiny crabs with jointed legs and claws, tadpoles with big eyes and feathery tails, spherical larvae ringed with setae or bead-tipped spines, jellyfish bells with tentacles, and plankton with veined wings or fan tails. Karyotype v1 cannot develop most of these. Its bodies are a straight chain of ellipses with tube appendages, so every creature in the Lab reads as a striped capsule with a tuft (Lab screenshots, 2026-10-27). Better meshes and shaders alone cannot fix that: the silhouette is decided in development.

Constraints carried over: development stays total, bounded and deterministic (0006); function follows form, and every benefit has a cost (0006); the sim sees `PhysStats` only (0018); released rules versions are never edited, and lineages keep their old genomes (0018); M9 must verify any birth under the rules version it was made with.

v1 also couples render detail to the body: development drops parts that would push the mesh over 6,000 vertices. M6 needs much finer detail (setae, membranes, inner organs), so that coupling would let a shader change alter which parts a creature has.

## Decision

**Karyotype v2 appends; v1 bodies keep their shape.**
- Each haplotype gains an extension block after its v1 bytes: new body loci, then a fixed extension of a few bytes per module slot. The v1 bytes keep their meaning and position.
- Every new locus is defined so that **0 means v1 behaviour**. A v1 genome decodes under v2 by zero-padding, and develops to the same plan and the same stats as under rules version 5. The one exception: v1 bodies whose parts v5 dropped for the vertex budget get those parts back (below).
- A genome is hashed over its own canonical bytes at its own length, so a living v1 creature keeps its genome hash and its records. Births and genesis under rules version 6 write v2 genomes; a v1 parent is padded to v2 before meiosis.
- `KARYOTYPE_VERSION` becomes 2 and `RULES_VERSION` 6. The v1 layout, decoder and v5 inheritance stay, and a birth is recomputed under the rules version in its record (so v5 births keep verifying).

**New developmental axes.** They are continuous where they can be, so breeding blends them and mutation can step between them:
- **Spine curve**: an amount and a mode bend the segment chain from straight into a C-curl, an S-wave or, at the top of the range, a coil.
- **Tagmata**: a head, trunk and tail profile (head scale, trunk swell, tail length and taper) turns the chain into a big-headed larva, a cephalothorax with an abdomen, or an even worm.
- **Fusion**: the front segments can fuse under one carapace shell (the oval copepod, the crab). The segments stay inside it, for the gut, joints and stats.
- **Symmetry**: bilateral to radial. A radial body is round, and its appendages ring the outline at even angles (spherical larvae, radiolarian spines). With rearward drape they trail behind as tentacles (the jellyfish bell).
- **Eyes**: none, or a pair, with size and stalk length.
- **Per module slot**: webbing (a membrane between a part's branches and its neighbours: wings, fans and tail fans), setae (density and length of bristles along the part), a bulb tip (bead-tipped spines and tentacles), a chela (an opposable last joint: a claw), and visible joint beads.

**Labels never drive function.** Every new feature acts through geometry and material formulas, each with a cost:
- Webbing adds paddle area (thrust that grows with size), plus drag and mass.
- Setae add drag, widen passive filter intake and the detection ring, and cost a little metabolism.
- Eyes widen the detection ring and cost metabolism.
- A carapace gives armour on the fused segments, and costs mass and flexibility.
- Radial symmetry turns well and drifts well, but thrusts poorly forward.
- A chela adds weapon power (used from M7), and costs mass.
- A curl shortens the body and lowers its turning inertia, and costs streamlining.

Archetype tests keep "no build is best at everything". A deterministic classifier, `silhouetteOf(plan)`, names a body's silhouette for tests, the diversity report, the Lab and the gallery, and is never read by stats or the sim.

**Caps and repair.** The part caps of 0006 stay: 8 segments, 24 appendage instances, 4 joints, one branch level with at most 2 branches, 12 colliders, bounds within 2.5 core radii. Setae, webbing, beads and eyes are detail on parts, not new parts: setae are capped per part (24) and per body (240), and eyes at 2. Repair still guarantees a propulsion source and a mouth, and keeps a radial body's parts evenly spaced and inside the bounds.

**Rendering detail never changes a body.** Development caps count parts, not vertices: under v6 nothing is dropped for a vertex budget. The mesh builder fits per-preset budgets on its own, by level of detail (fewer rings, fewer setae, simpler membranes), never by removing parts:
- high: 12,000 vertices per creature;
- medium: 6,000;
- low: 1,500.

The scene budgets in DESIGN §12 bound the total.

**Genesis stays the cell stage, with wider larval variety.** The brief starts every lineage as a small cell, so genesis bodies stay small and simple: one body unit (one segment, or one fused shell) plus few parts. They are drawn from a wider spread, though: round and oval cells with flagella or cilia, spherical larvae with radial setae or spines, small bells with short tentacles, and tadpole-like cells with a tail. At least four silhouette classes appear across 1,000 genesis seeds, and none takes more than 40%. The multi-segment forms (shrimp, copepods, worms, coils, crabs, winged plankton) arise through breeding and mutation. The Lab's wild mode, the gallery and the diversity report show them.

## Consequences

- Silhouettes become a property of the genome, so they breed: two parents blend curl, symmetry and webbing, and mutation can carry a lineage from a cell to a shrimp.
- Existing creatures and records stay valid. Verifying them needs the v1 layout and v5 inheritance kept beside v2, which costs some code.
- Nothing about a body depends on a preset or a shader. A render change can never change who survives.
- Every new feature needs formulas, costs, property tests over 10,000 random and 10,000 mutated genomes, and goldens under rules version 6. M6 spends four tasks on this (spec T6 to T9).
- Rejected:
  - a body-class gene that picks a template (a parts catalogue in disguise; nothing blends);
  - meshes and shaders only (cannot change the silhouette);
  - a new karyotype that drops v1 (breaks every living creature and its records);
  - raising the development vertex cap instead of decoupling it (keeps the render–genome coupling and still drops parts);
  - multi-segment genesis bodies (the brief starts lineages at the cell stage).
