# 0037: One body, widest at the trunk

- Status: accepted (amends 0028: the head in front of a long chain and the work of head scale; amends 0031: a worm's curl narrows it, and the profile moves bulk from the head to the trunk)
- Date: 2026-10-31

## Context

Playtest #183 (v0.7.0) asked for long bodies that read as creatures: a worm a slim chain, a shrimp a segmented trunk, a copepod an oval front with a slim tail.

Under ADR 0028 the head in front of a chain is the v1 head scaled by 0.65, and head scale narrows every segment behind it. So most long bodies were a big ball with a thin chain behind it (look passes 4 and 5). ADR 0031 then narrows the whole chain to 2.5 times as long as wide, measured on its widest segment, which was usually the head.

Over 10,000 random v2 genomes, among bilateral chains of 3 or more segments:
- only 1.4% had a head narrower than 0.9 of the trunk;
- 61% of copepods had a shell wider than a slim tail;
- no worm was 4 times as long as wide.

## Decision

Under rules 7 (ADR 0035), a bilateral karyotype v2 chain of 3 or more segments is profiled before it slims (`RULES.develop.chain.profile`).

- **The head** keeps its own length up to 0.7 core radii, and the chain is laid behind it. Where a head that long would put the trunk's widest segment past 55% of the body's length, the head is 0.5 long instead. Head scale no longer narrows the chain. It sets the head's half-width, from 0.85 to 0.9 of the trunk's widest.
- **The trunk** is widest at the segment whose centre lies nearest 0.4 of the body's length.
  - In a body with a shell over 2 or more segments and a free tail, the widest segment is inside the shell.
  - The segments in front of the widest narrow toward the head by up to 15%.
  - Every segment behind it is no wider than the one in front. The tagma loci (trunk swell, tail taper, tail length) still shape it under that rule.
- **Chains of 5 or more segments** keep half of each narrowing except the last segment's, so a worm is even along its middle and still ends in a tapered tip.
- **A copepod's free tail** is at most 0.45 of the widest segment.
- **The bulk holds.** Every half-width then scales so that the outline keeps the plain chain's area. Stats read the girth (ADR 0031), so a body's mass stays as it was, now carried by the trunk instead of the head.
- **A worm's curl narrows it.** A chain of 5 or more segments that curls by 0.35π or more (the silhouette's worm) is at least 4.2 times as long as wide (`chain.wormAspect`), unless a shell leaves it a free tail. This amends ADR 0031, where a curl was only a pose. Fusion alone never changes how far a body narrows, so a shell still only adds armour and mass. A straight legged chain (a shrimp) keeps 2.5, so its trunk shows between its legs.
- **Eyes on a narrow head** move out sideways until the pair just touches, instead of overlapping.
- **The carapace gets the body's crisp rim** (`creature.frag.glsl`). A long chain's head no longer fills its shell, so the shell's own edge is the body's outline.
- **The silhouette classifier follows:**
  - a worm has 5 or more segments, and a shorter curled or plain chain is a tadpole or `other`;
  - a tadpole's big front is the head plus the trunk up to its widest segment;
  - a fan tail needs 45% of the webbing behind the rear segment (from 50%), because a slimmer body widens its side webs.

The core collider stays the unit circle, so the sim, sizes and hazards do not move.

## Consequences

- **The profile holds widely.** Over 10,000 random v2 genomes (`develop-long.test.ts`), 97% of long chains meet the profile:
  - a head at most 0.9 of the trunk;
  - their widest point 25–55% of the length from the front (unfused);
  - an outline that narrows to the tail.

  The rest are 3-segment chains whose first trunk segment lies past 55% even behind a 0.5 head. 99.8% of random copepods and every random shrimp and worm meet their class proportions, against 61%, 5% and 0% before.
- **Bulk moves to the trunk.** The 12 silhouette specimens' median trunk segment is 0.38 core radii as drawn (as before) and 0.71 in girth (0.53 before).
- **The balance checks hold:**
  - the archetype metrics;
  - the tournament rankings and the pacing report, both unchanged;
  - the speed band;
  - the radial twins: a radial body still thrusts at least 3% worse than its bilateral twin.

  The Lab's wild mode shows 8 or more classes for all 10 test seeds and 85 of 100 others (86 before). Rules 7 is unreleased, so the plan, stats and tournament goldens are regenerated.
- **Some shapes go.** A chain of 3 or more segments with a big head no longer exists: a big front is now trunk. A big set-in eye on a long chain sits half outside the narrow head.
- **Parts can lie over a slim body.** On slimmer bodies, parts crowd over the trunk more often (M6b T7 turns them outward).
- **Rejected:**
  - a fixed 0.5 head, which drew coil and shrimp heads so small that their head parts' bristles covered the trunk;
  - a head at 0.72 of the trunk, for the same reason;
  - narrowing every chain of 5 or more, which hid a shrimp's trunk under its legs;
  - narrowing only unshelled chains, because a whole shell then made a body wider and its parts shorter, so the shell lightened it.
