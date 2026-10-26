# 0018: Body seam, genome encoding and sharing, shader gait (M3)

- Status: accepted
- Date: 2026-10-26

## Context

ADR 0006 fixes the genetics: a diploid karyotype, bounded development and function-follows-form. M3 has to build it and wire it into a game that so far has one kind of cell. Open questions: what the deterministic sim sees of a body, how a genome is encoded and hashed, how other players' bodies reach a browser, how a body that is generated at runtime can move like one living thing, and what the Creature Lab is. M4 (records), M5 (breeding commitments) and M9 (verification) will all re-derive bodies from genomes, so these choices must be stable and cheap to verify.

## Decision

- **The sim sees `PhysStats`, never a genome.** `src/sim/body.ts` defines `PhysStats` as plain data: multipliers for thrust, drag, turn, basal metabolism and growth, a maximum biomass, a mouth (`offset`, `radius`, `arc`, `type`, `digestion`) and up to 12 colliders in the body frame (units of the core radius). `STARTER_PHYS` reproduces the M1 cell. `CreatureState.phys` is part of the state hash, and an input log carries the `phys` its creature starts with. `src/genome` produces it (`physOf(stats)`); `src/sim` never imports `src/genome`. Dependencies point one way: `sim` ← `genome` ← `render`, `game`, `lab`, `net` (codecs only).
- **Genome encoding.** A genome is the concatenation of two haplotypes. Each locus is one byte, except a module slot, which is 15 bytes (a presence byte and 14 parameters). The layout lives in one table (`src/genome/karyotype.ts`) and is versioned (`KARYOTYPE_VERSION = 1`). Decoding is total: any byte string decodes (short input is zero-padded, extra bytes are ignored, values are wrapped or clamped into their tables). Encoding emits the canonical form. `genomeHash = hex(SHA-256('bs/genome/v1\n' ‖ canonical bytes))` through `@noble/hashes`. A genome travels as base64url (about 440 characters).
- **Rules version.** Karyotype, expression, development, stats and inheritance are frozen per `RULES_VERSION` with golden vectors (ADR 0006). M3 raises it to 3 once, in its first task (body seam and growth retune), and later tasks that change outcomes before the release regenerate the vectors under the same version. Released versions are never edited.
- **Size.** `maxBiomass = 300 · 2^(13·t)`, where `t` is the mean of three `quant` loci scaled to 0–1. Genesis cells have `t` near 0 (300–900 biomass); selection and mutation move a lineage up the tiers slowly. Growth runs at up to 0.012·b biomass per second (rules v3; M1's 0.005 was too slow, owner, Playtest v0.2.0).
- **Colliders.** Colliders feed toxin exposure (the share of collider area whose centre lies in a plume) and feeding geometry in M3, and creature hit shapes in M5 and M7. M3 adds no creature-to-creature physics.
- **Feeding.** Food is eaten through the mouth disc. A mouth type on the filter-to-jaw continuum sets the yield per food kind; kinds the mouth cannot process are left alone (DESIGN §2).
- **One body, one gait.** A creature is one merged `BufferGeometry` built from its `BodyPlan` and cached by genome hash (reference-counted, disposed at zero). All creatures share one shader program; look and gait come from per-genome uniforms. The vertex shader moves the whole body: a travelling wave along the spine, and a vertex of an appendage first takes the spine displacement at the spine position where the appendage attaches (`aAttach`), then its own beat, weighted from zero at its base. So no part can detach, for any generated design. A CPU reference (`src/render/gait.ts`) has the same formulas for tests. The wave phase is integrated per frame from speed, never `time × rate`.
- **Bodies on the wire.** A browser sends its genome once on the reliable `event` channel when a link opens and again when it hatches a new body. Snapshots carry a 16-bit `genomeRef` (the first two bytes of the genome hash) in their reserved bytes, so a receiver knows when a body changed. The genome is untrusted input: decoding is total, development caps bound the render cost of any genome, and receivers rate-limit and cap genome events. Remote stats are never trusted for anything the receiver decides in M3 (nothing is at stake yet; ADR 0016).
- **Creature Lab.** A second Vite page (`lab.html`, `src/lab/`) on the same build and the same render code, linked from the title screen. It uses no network and no sim.

## Consequences

- Sim goldens stay independent of genome code, while body goldens (plans, stats) live next to the genome code, and a replay of any creature needs only its `phys`.
- M4 and M9 can re-derive `phys` from a genome and a rules version, and compare.
- A hostile genome can look odd but cannot cost more than a maximal valid body.
- Changing the layout (new loci, new module parameters) is a new karyotype version with the old decoder kept, because lineages keep old genomes.
- Rejected:
  - the sim taking a genome (couples the verified core to a large, fast-moving module);
  - sending stats or body plans instead of genomes (not verifiable, larger, and a second source of truth);
  - skeletal skinning or bones (per-creature buffers and CPU cost; the shader gait gives the same readable motion at one draw call);
  - per-creature textures (memory and upload cost; uniforms and procedural shading are enough);
  - genomes inside every snapshot (330 bytes against the 24-byte budget).
