# 0006: Genome, inheritance and bounded development

- Status: accepted (karyotype v2 extends the genome, and the mesh vertex cap moves to rendering: 0025; top speed lives in a band: 0036; at most 14 visible parts, shaped by region, within the 24-part cap: 0041; nothing is frozen per rules version before v1.0: 0040)
- Date: 2026-10-25

## Context

The brief wants genuinely new shapes and behaviours from breeding, not a fixed parts catalogue or stat sheets. Mendelian inheritance, recombination and mutation should drive a bounded developmental system whose anatomy affects movement, collision, feeding, combat and appearance. Every inherited organism must stay viable and cheap to compute, and size, armour or complexity must come with tradeoffs, so evolution finds different successful adaptations instead of one superior build. Development and inheritance must be deterministic in every engine, because offspring are verified (ADRs 0005 and 0009).

## Decision

**Genome (karyotype v1).** Diploid: two haplotypes of 6 chromosomes each. Every locus has one of four kinds:

- `quant`: an allele value 0–255, expressed additively as the mean of both alleles and mapped to a trait range. Polygenic traits sum several `quant` loci.
- `mendel`: an allele id from a small per-locus table. Each locus has a dominance table: complete (a rank order), co-dominant (both expressed, such as spots and stripes) or incomplete (a blend).
- `load`: a functional allele or a recessive loss-of-function (`lof`). Only homozygous `lof` expresses a defect (weaker membrane, poorer metabolism, a malformed part), so inbreeding has a cost.
- `module` slot: a presence flag plus 14 parameters (length, thickness, taper, curvature, joints, branching, tip shape, stiffness, beat, phase, attach start, attach span, angle, pairs). A module is expressed when present in either haplotype; when present in both, its parameters average. Mutation can duplicate a module into an empty slot, and the copies then diverge. That is how new kinds of part arise.

The canonical byte encoding decodes **any** byte string of the right length (values clamped or wrapped into their tables). Decoding never fails.

**Development pipeline**: `genome → express → Traits → develop → BodyPlan → computeStats → PhysStats`. It is a total function with hard caps, and it repairs instead of rejecting:

- 1–8 segments along a bilateral axis (genesis cells have exactly 1).
- At most 24 appendage instances, ≤4 joints each, one branching level with at most 2 branches.
- At most 12 collision circles; bounding radius ≤2.5× the core radius; mesh vertices ≤6,000 (≤1,500 at low detail).
- Repairs guarantee at least one propulsion source (a default ciliary band) and a mouth opening at the front, keep appendages from overlapping (angular spacing), and clamp lengths.

**Function follows form.** Abilities are derived from geometry and material parameters, never from labels:

- Thrust comes from motile parts: area × beat × an efficiency that depends on tip shape and body size. Whip-like flagella and cilia win at small sizes and paddle-like fins win at large ones, so the best locomotion changes as a lineage grows.
- Drag comes from frontal width, streamlining (taper, aspect) and appendages. Turning is asymmetric thrust and flexibility divided by moment of inertia. Mass is body area × density, and plates add density.
- Intake comes from mouth aperture and type (a filter continuum to a jaw). Weapon reach and damage come from tip sharpness × stiffness × length. Spines deal contact damage. Armour is plating coverage × thickness. Senses come from antenna and sensor modules. Luminescence matters in dark zones.
- **Every benefit has a cost.** Metabolism scales with mass^0.75 times a complexity factor (segments, appendages, plates, luminescence). Mass slows acceleration and turning, and appendages add drag.

**Behaviour genes** set the swimming gait (undulation amplitude, frequency and phase), display patterns (bioluminescent pulses) and the combat autopilot (aggression, caution, target preference, brace reflex). Behaviours breed like shapes do.

**Inheritance:**

- Meiosis per parent: 0–2 crossovers per chromosome at locus boundaries, with independent assortment across chromosomes.
- Bounded mutation per gamete, at most 3 events: a quant step, an allele change, a load flip, parameter drift, module duplication or deletion, or a rare novel allele that exists only through mutation.
- Child = gamete(A) + gamete(B), with all randomness drawn from `seed = SHA-256('bs/offspring/v1' ‖ beacon randomness ‖ commit id ‖ slot)` through named PRNG streams (`meiosis-a`, `meiosis-b`, `mutation-a`, `mutation-b`). Slot 0 is player A's child and slot 1 player B's.

**Versioning**: the karyotype, expression, development and inheritance are frozen per rules version (ADR 0005), with golden vectors per version.

## Consequences

- Breeding can create shapes nobody designed (duplicated and diverged modules), yet every result is valid, bounded and quick to build. Property tests over at least 10,000 random and mutated genomes enforce this on every change.
- Balance becomes a property of formulas and tradeoffs. Archetype and tournament tests (M3, M7, M14) check that no build dominates.
- Players can read heredity: Mendelian traits give exact Punnett odds for mate-choice hints (M5).
- Rejected:
  - a fixed parts catalogue with stat values (no genuinely new shapes);
  - neural-network brains (opaque, expensive, hard to verify);
  - voxel or soft-body creatures (unbounded compute, fragile determinism);
  - haploid genomes (no dominance or recessive surprises).
