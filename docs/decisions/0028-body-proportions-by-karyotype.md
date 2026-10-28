# 0028: Body proportions follow the karyotype

- Status: accepted (amends 0025: "every new locus is defined so that 0 means v1 behaviour" now holds for the loci, but the chain layout and the part fit follow the karyotype)
- Date: 2026-10-28

## Context

Look pass 1 (M6 T14, `docs/art/gallery/pass-1.md`) found that the three largest gaps against references 02–05 are development, not look. The core is the unit (radius 1) at the origin, the chain behind it is scaled to end within 1.8 core radii, and parts are cut so that root plus length stays within the 2.5 bounds. So trunk and tail segments came out at 0.1–0.2 core radii, every body read as a ball with a tail, and long antennae, trailing tentacles and spread wings were cut short. The body bound (`RULES.body.maxReach`, 2.5) stays: it sizes colliders, the Lab grid and the gallery.

ADR 0025 asks that every v2 locus read 0 as v1 behaviour, so that living v1 creatures keep their bodies. A proportion change keyed to one shape locus would leave most v2 bodies (genesis cells, and anything bred from them before the locus drifts) on the old proportions, and no existing locus means "proportions".

## Decision

- Development reads the genome's karyotype (`traits.karyotype`, from `genomeKaryotype`). A v1 genome develops exactly as before: the v5 chain and the v5 part rule, so the frozen v1 equivalence holds. A v2 genome, which every rules-6 genesis and birth writes, gets the new proportions whatever its loci:
  - In front of a chain the head is drawn at 0.65 of the v1 head (v1's at head scale 1, round as symmetry rises); a single cell keeps the v1 head. The core collider stays the unit circle, so the sim, sizes and hazards are unchanged, and drag takes at least the core's width.
  - The trunk is 0.8 core radii wide along the tagma profile and fits a reach of 2.1 by shortening its segments before it narrows; a radial body keeps its chain inside its core.
  - Parts fit by their drawn reach (development now owns the arc the mesh draws: `partCurve`), sweeping toward the core along the body before they are cut. The fit is independent of webbing, a rear part growing rearward never turns forward past sideways, and a ring keeps its order and trails as a ring.
- The tagma loci keep their meaning on top: head scale enlarges the head and narrows the chain, trunk swell and the tail loci shape the profile.

## Consequences

- Every rules-6 body has the new proportions; living v1 creatures, their records and their stats are untouched, and v1 parents' children (padded to v2 before meiosis) get them.
- `traits` carries the karyotype, so a v1 genome padded to v2 (`upgrade`) has the same traits but a different body. Rules 6 is unreleased, so its goldens are regenerated.
- The core collider can be wider than the head drawn in front of a chain. Today colliders only weigh toxin exposure; M7's hit shapes must account for it.
- Parts that sweep can swing past the bounds by a little while they beat (the bound is on the rest pose, as for every part before).
- Rejected: raising the body bound (sizes and the gallery scale with it, and the brief keeps creatures compact); keying the proportions to one shape locus (most v2 bodies would keep the old look); shrinking the core collider with the head (a sim and seam change for no gameplay gain today).
