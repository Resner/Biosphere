# 0041: A body plan reads as an organism: parts by region, a visible-part budget

- Status: accepted (refines 0025, 0031, 0037 and 0039; amends 0038's coil gate; keeps 0006's caps)
- Date: 2026-11-01

## Context

The owner's Creature Lab screenshot (2026-11-01, wild mode) shows bodies that "don't look like real, organic creatures; some have 20 antennas or limbs, that make it look like a spaceship". An honest reading of that sheet and of `docs/art/gallery/pass-6.png`:

- **Too many parts of equal weight.** A body can carry 24 appendage instances, and the wild mode draws random bytes: about half of the 8 module slots are present, each with 1 to 3 pairs, and branches double them. Ten to twenty spokes radiate at similar lengths. Real plankton show one pair of long antennae, a few short legs mostly under the body, and one tail structure (references 02–05).
- **No hierarchy by region.** Antennae, legs and tails differ only by their genes, so legs stick out at the front, antennae sprout mid-body, and long whips leave from the sides.
- **Rigging, not limbs.**
  - Parts are straight, evenly thin and often near-perpendicular to the body.
  - Branches fork like twigs, so a forked part reads as an antler or an aerial.
  - Most tips end in a bright bead, which reads as a lamp on a mast.
  - Setae combs are long straight fans, so a bristled leg reads as a brush or an explosion.
- **Radial bodies read as sea mines.** Evenly spaced, equally long spokes.
- **Machine symmetry.** Exact mirror pairs at identical angles; no curvature sweeps the parts back.
- **Colour like LEDs.** A row of differently coloured organs down the midline (fixed in 0034's rule, but pass 6 still shows several hues).
- **The wild mode is not life.** Uniform random bytes are extremes that no lineage would reach without selection, yet the Lab presents them as "wild" creatures.

## Decision

**Parts are read by the region they attach to**, and development shapes them by it. Function still follows form: regions constrain geometry, and stats come from the geometry as before.
- **Head** (attach start in the front 20% of the body, angle within 70° of the heading):
  - at most one pair of long antennae (up to 2.2 body lengths, the thinnest parts of the body);
  - one shorter pair (up to 0.6 body lengths).
  Antennae sweep outward and back in a gentle curve.
- **Trunk**: legs, at most 6 pairs.
  - Each is short (up to 0.9 body widths), jointed and swept back 25–70° from the side.
  - Legs on a fused carapace sit mostly under the shell, so only their outer half shows.
- **Rear** (the last 20%): one tail structure, either a furca (two short rami), a fan (webbing) or a single whip, up to 1.5 body lengths.
- **Radial bodies**: 5 to 9 spokes or tentacles, with lengths varying ±30% by a hash, and drape bending them rearward.

**A visible-part budget.** At most 14 visible appendage instances per body, down from 24, which stays the cap of 0006 for colliders and stats.
- An instance is one drawn part with its own root. A branch belongs to its parent's instance, and the default ciliary band (module −1) is already fringe and does not count.
- Parts beyond the budget, or beyond a region's count, become a short ciliary fringe on their segment: present for stats, drawn as fine cilia, never as spokes.
- The region counts are maxima, and the budget wins. The body keeps, in order: the tail structure, the long antenna pair, then legs from the front; the short antenna pair only while the budget allows. Extras turn to fringe from the rearmost leg forward.

**Shapes that read as tissue:**
- Every part tapers and curves, its curvature biased backward.
- Mirrored pairs differ by a small hashed jitter: angle ±6°, length ±5%.
- Branches stay on antennae (biramous) and tails only, at most 0.5× their parent, fanning backward.
- A bulb tip needs a bulb gene above 0.6 and occurs at most on one pair.
- Setae are shorter (at most 3× the part's width), soft and curved, and live on legs, antennae and tails.

**The Lab's wild mode shows evolved creatures**: lineages bred from genesis cells over many generations at the Lab's mutation rate, not random bytes.

**Coils stay**, as the nautilus and curled-worm silhouettes of #90 (references 02 #14, 04 #20). ADR 0038 makes every coil an 8-segment chain, so the gate is on the genes: a coil needs a segmentation trait that would give at least 5 segments on its own, and at most 2 leg pairs; otherwise the body takes the C-curl. Its legs sit on the outer side of the curve, so it reads as a spiral rather than a knot (this amends 0038's "3 or more").

## Consequences

- Silhouettes gain hierarchy: antennae, legs, tail. Bodies read as plankton at a glance, and diversity comes from proportions, curves, symmetry and webbing rather than from part count.
- Breeding still blends everything. A lineage gains parts by duplication, but past the budget they become fringe, so evolution cannot build a spaceship.
- Development, stats and goldens change (rules 8, with a world reset under ADR 0040, so nothing is frozen). Archetype and property tests are redone.
- Rejected:
  - a hard template per silhouette class (no blending; labels would drive form);
  - hiding extra parts only in rendering (stats would count invisible limbs; render must never change a body, 0025);
  - fixing the Lab only (bred creatures drift to the same look by duplication).
