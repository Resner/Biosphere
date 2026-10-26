# M3: Procedural morphology

Release: v0.4.0 · Gate: no

## Goal

Every creature has a genome, and the genome decides its body. A player hatches a genuinely different single-celled creature each time, sees it as one living, attached body (not a flat sprite with a tail), and sees other players' bodies as they are. Anatomy changes how a creature swims, turns, feeds, drinks poison and grows. The Creature Lab page lets anyone browse genesis creatures, mutate one and breed two into eight offspring, so the morphology risk (diversity, viability, render cost) is judged long before breeding is a game mechanic (M5). ADR 0006 is the contract for the genetics, and ADR 0018 records the choices for how it meets the sim, the network and the renderer.

## Out of scope

- Mating, offspring commitments and drand (M4, M5). The Lab breeds with a local fake seed; the game hatches random genesis cells from a browser-local seed. Genesis DNA from a committed future round arrives in M4.
- Records, lifespan, maturity and rarity as a game system. M3 only computes and shows the rarity score.
- Creature-to-creature physics, weapons in play, combat (M5, M7). Combat stats are computed and shown in the Lab, not used in the game.
- Depth zones, UV, pressure and the art pass (M6): tolerance genes are expressed and displayed only. The crispness complaint from Playtest v0.2.0 is in M6.
- Area of interest and tiers as a networking rule (M11). Tiers are still displayed.

## Touches

New: `src/sim/body.ts`, `src/genome/` (karyotype, codec, express, develop, stats, genesis, inherit, rarity, names, validate), `src/render/creature-mesh.ts`, `src/render/creature-cache.ts`, `src/render/gait.ts`, `src/render/creature-view.ts`, shaders `creature.vert.glsl` and `creature.frag.glsl`, `lab.html`, `src/lab/`, `tools/` diversity report, `tests/e2e/m3-*.spec.ts`. Changed: `src/sim` (physics, metabolism, feeding, hazards, state hash, replay, rules), `src/net/protocol.ts` (genome event, snapshot ref), `src/net/pond-sync.ts`, `src/render/remotes.ts` and `scene.ts`, `src/game/app.ts`, `online.ts` and `debug.ts`, `vite.config.ts` (second page), `index.html` (Lab link), `docs/DESIGN.md`.

New dependencies: none (`@noble/hashes` is already present).

Interfaces:

```ts
// src/sim/body.ts (plain data; part of the state hash)
export interface Mouth { offset: number; radius: number; arc: number; type: number; digestion: number }
export interface Collider { x: number; y: number; r: number }          // body frame, units of the core radius
export interface PhysStats {
  maxBiomass: number;                                                  // wu of biomass (b); radius is √b
  thrust: number; drag: number; turn: number;                          // multipliers on RULES.movement
  basal: number; growth: number;                                       // multipliers on metabolism and growth rate
  mouth: Mouth;
  colliders: Collider[];                                               // 1..12; [0] is the core { 0, 0, 1 }
}
export const STARTER_PHYS: PhysStats;                                  // reproduces the M1 cell, maxBiomass 400
// CreatureState gains `phys: PhysStats`; spawnCreature(world, { id, x, y, biomass?, phys? }).
// InputLog.spawn gains an optional `phys`.

// src/genome/*.ts (deterministic; imports src/sim only for math, prng and types)
export const KARYOTYPE_VERSION = 1;
export const GENOME_BYTES: number;
export interface Genome { readonly haplotypes: readonly [Haplotype, Haplotype] }   // plain data
export function decodeGenome(bytes: Uint8Array): Genome;               // total: never throws
export function encodeGenome(g: Genome): Uint8Array;                   // canonical, GENOME_BYTES long
export function genomeHash(g: Genome): string;                         // hex SHA-256('bs/genome/v1\n' ‖ canonical bytes)
export function genomeToBase64url(g: Genome): string;
export function genomeFromBase64url(text: string): Genome | null;     // null only when the text is not base64url
export function express(g: Genome): Traits;
export function develop(t: Traits): BodyPlan;
export function computeStats(plan: BodyPlan, t: Traits): Stats;
export function physOf(stats: Stats): PhysStats;
export function buildCreature(g: Genome): Creature;                    // { hash, traits, plan, stats, phys }
export function bodyViolations(plan: BodyPlan): string[];              // [] when every ADR 0006 cap and guarantee holds
export function genesisGenome(seed: Seed): Genome;
export function starterGenome(): Genome;                               // the reference cell; physOf ≈ STARTER_PHYS
export function offspringSeed(randomness: Uint8Array, commitId: string, slot: 0 | 1): Seed;
export function breed(a: Genome, b: Genome, seed: Seed, opts?: { mutation?: number }): Genome;
export function mutateGenome(g: Genome, seed: Seed, opts?: { mutation?: number }): Genome;
export function rarityOf(g: Genome): { score: number; tier: 'common' | 'uncommon' | 'rare' | 'exotic'; features: string[] };
export function speciesName(g: Genome): string;                        // for example "Velothrix natans"
export function describeCreature(c: Creature): string[];               // plain-words sentences for the Lab and the HUD
```

```ts
// src/render/creature-mesh.ts, creature-cache.ts, creature-view.ts, gait.ts
export type Detail = 'full' | 'low';
export function buildCreatureGeometry(plan: BodyPlan, detail: Detail): THREE.BufferGeometry;  // one merged geometry
export class CreatureCache { acquire(c: Creature, detail: Detail): CreatureAsset; release(asset: CreatureAsset): void; live(): number }
export class CreatureView { update(view: CreatureViewState | null, time: number): void; dispose(): void }
export function gaitOffset(out: Vec3Like, v: GaitVertex, g: GaitUniforms): void;               // CPU reference of the shader
```

Wire (`src/net/protocol.ts`): `PeerEvent` gains `{ t: 'genome'; data: string }` (base64url, ≤ 2 KB). The snapshot's two reserved bytes become `genomeRef` (u16), and its version byte becomes 2.

## Tasks

- [x] T1 Body seam and the rules-version-3 retune
  - Acceptance (unit tests unless noted):
    - `STARTER_PHYS` and `PhysStats` as in the interface above; `spawnCreature` defaults to `STARTER_PHYS` and rejects nothing (a `phys` with out-of-range values is clamped by `sanitizePhys`, which also enforces the 1–12 colliders with the core first).
    - Movement: `thrust: 2` doubles the steady-state top speed of a full-throttle run (within 1%); `drag: 2` halves it; `turn: 2` doubles the heading change rate (a 90° turn takes half the ticks); a dash scales with √(thrust ÷ drag).
    - Metabolism: `basal: 1.5` drains 1.5× the energy per second of an idle creature; `growth: 2` doubles the growth rate while energy is above 75%.
    - Growth stops at `phys.maxBiomass`: a creature with 150 and one with 900, both held full of energy, stop within 1 unit of their maximum (and growth no longer subtracts energy there).
    - Pace (owner, Playtest v0.2.0): `RULES.growth.maxRate` becomes 0.012 and `RULES.growth.maxBiomass` is removed (the cap comes from `phys`). A scripted nearest-food forager in a seeded pond (default options, 3 simulated minutes, a starter with `maxBiomass: 900`) at least doubles its biomass between 60 s and 150 s; record the measured time in the task note.
    - `RULES_VERSION` is 3. `hashWorld` covers `phys`. All sim goldens are regenerated under version 3 (`replay.test.ts`, `__golden__/*`); the PR says so. Add one golden replay for a non-starter `phys` (thrust 1.4, drag 0.8, basal 1.2).
    - `InputLog.spawn.phys` is optional, validated, and replayed (Node and Chromium agree: extend the existing determinism E2E with the new golden).
  - Notes: update the DESIGN.md header ("rules version 3") in the same PR. Dash: `dashSpeed · (b/100)^dashExp · sqrt(thrust/drag)`. No genome code yet; tests build `PhysStats` by hand. The state hash must keep rejecting NaN and Infinity inside `phys`.
  - Done: `src/sim/body.ts` (`PhysStats`, `STARTER_PHYS`, `sanitizePhys`, `isPhysShape`), caps in `RULES.body`, rules v3, five goldens regenerated (`math.json` untouched) plus the new `body-forage` golden (also run in Chromium).
  - Pace: a value-per-distance forager that avoids plumes (`maxBiomass: 900`) has 194 at 60 s, 398 at 120 s (doubles in 60 s) and 515 at 150 s; the starter's cap of 400 is only lifted when T15 hatches genome bodies. A forager that ignores plumes died at 100 s in that pond. `STARTER_PHYS.mouth` is a placeholder (type 0.5, all-round) until T2.

- [x] T2 Feeding through the mouth, toxin through the colliders
  - Acceptance:
    - `STARTER_PHYS` feeds exactly as before: an item at distance `r + item.radius − 0.1` is eaten, one at `+ 0.1` is not, in every direction (the M1 forage golden, regenerated only if T1 already changed it, shows no feeding difference).
    - A jaw mouth `{ offset: 0.9, radius: 0.35, arc: 0.6, type: 1 }` eats a crystal straight ahead at `1.2·r` from the centre, and does not eat the same crystal behind the creature or 60° off the heading.
    - Yield is `value × efficiency(kind, type) × digestion` with the table in DESIGN §6 (`RULES.feeding`): type 0 eats detritus for 8, a globule for 15 and ignores crystals (the item stays and `foodNear` still lists it); type 1 eats a crystal for 60, a globule for 20 and detritus for 3.2; type 0.5 gives 6.4, 25 and 36; digestion 0.5 halves each. Energy never passes the maximum, and a full creature leaves items alone, as before.
    - A mouth with an efficiency of 0 for an item never "eats" it, never emits `eat`, and never marks the slot consumed.
    - Toxin: exposure is the share of collider area (`r²` per circle, no overlap correction) whose centre, rotated by the heading and scaled by `√biomass`, lies inside a plume. A starter takes 15 hp/s or none, as before. A creature with colliders `[core, { x: −2.5, y: 0, r: 0.6 }]` heading east, with a plume covering only the tail circle's centre, takes `15 × 0.36 / 1.36` hp/s (check to 1e-6); turning the creature the other way changes the damage.
    - `findClearSpot` keeps its clearance for the creature's body: with a body whose farthest collider reaches `2.5·r`, the spot is at least `plumeClearance` from every plume for the next 10 s measured from the farthest collider centre (compare with a brute-force scan on a 20-point sample).
    - Performance: a tick of 24 creatures with 12 colliders and a mouth each in a world with plumes and food stays under 2 ms in Node (`sim.md` budget; record the number).
  - Notes: `RULES.feeding` holds the anchors; efficiency is linear between them. Item "size" plays no further role in M3. Update DESIGN §2 only if the numbers change.
  - Done: `efficiency()` and `applyFeeding` use the mouth disc and arc (arc is measured from the creature centre; an `eat` event's `value` is the yield); `applyHazards` uses collider exposure; `findClearSpot(world, x, y, reach)` takes `colliderReach(phys, biomass)` (the game passes 0 until T15). Goldens regenerated under v3: a starter's type-0.5 mouth pays crystals 36 and detritus 6.4, so `hazard-dash` grows 1 time, not 3. A 24-creature, 12-collider tick takes about 1.2 ms in Node.
  - Gotcha: `sanitizePhys` pulls a collider to within `2.5 − r` of the core, so the acceptance example `{ x: −2.5, r: 0.6 }` lands at −1.9; the tests use −1.9 (same 0.36 / 1.36 share).

- [x] T3 Karyotype v1, the total codec and the genome hash
  - Acceptance:
    - The loci table (`karyotype.ts`) follows DESIGN §6 and ADR 0006: 6 chromosomes, `quant`, `mendel` (with complete, co-dominant or incomplete dominance), `load` and 8 `module` slots of 15 bytes. `GENOME_BYTES` is the diploid size. If the layout differs from the DESIGN table, update the table in the same PR. Each `mendel` table also has at least one allele that genesis never produces (a "novel" allele, reachable by mutation only).
    - `decodeGenome` never throws for 10,000 random byte strings of lengths 0, 1, `GENOME_BYTES − 1`, `GENOME_BYTES`, `GENOME_BYTES + 1` and 4096, nor for the all-zero and all-0xFF strings.
    - Canonical form: `encodeGenome(decodeGenome(b))` has length `GENOME_BYTES`; decoding it again is deep-equal; for any `b` already canonical it equals `b`. Two strings that differ only in non-canonical bits (a `mendel` byte plus a multiple of its table size; a `load` byte with the same parity class; a module parameter byte under an absent module) have the same hash. Strings that differ in an expressed allele have different hashes (1,000 single-byte mutations of a random genome: no collision).
    - `genomeHash` golden vectors for three genomes (all zero, a counter pattern, and one random) are committed under `src/genome/__golden__/` with `RULES_VERSION`; the hash input is the domain tag `bs/genome/v1\n` followed by the canonical bytes.
    - `genomeToBase64url` and `genomeFromBase64url` round-trip 1,000 random genomes; `genomeFromBase64url('')`, text with characters outside the alphabet and text of 5,000 characters return `null` or a decoded genome, and never throw.
    - `src/genome` imports nothing from `src/render`, `src/net`, `src/game` or the DOM, and `src/sim` imports nothing from `src/genome` (a test greps the import graph).
  - Notes: arithmetic follows `sim.md` (use `math.ts`). SHA-256 comes from `@noble/hashes`. Add `.claude/rules/genome.md` lines for the codec only if a gotcha shows up.
  - Done: `karyotype.ts` (164 bytes per haplotype, 328 per genome; one `LOCI` table with `rank`, `dominance` and `novelFrom` per `mendel` locus) and `codec.ts`; goldens in `__golden__/genome-hash.json`. DESIGN §6 now lists a `texture` locus (incomplete dominance) so every dominance kind has a locus, plus the encoding rules.
  - Gotcha: genome bytes fold to canonical form (`mendel` mod size, `load` low bit, absent module zeroed), so mutation (T8) must act on canonical values; haplotype order is part of the hash.

- [x] T4 Expression: dominance, polygenic sums, homozygous load
  - Acceptance:
    - `express(genome): Traits` is a total function that returns finite numbers inside each trait's range for 10,000 random genomes and for the extreme genomes (all zero, all 0xFF, alternating).
    - Order invariance: swapping the two haplotypes gives deep-equal `Traits` (1,000 genomes).
    - `quant`: the trait is the mean of the two alleles mapped to its range, and rises monotonically with either allele (test every quant locus by stepping one allele 0→255). Polygenic traits (segmentation drive ×2, max size ×3, hue ×3, plating ×2) sum their loci; changing any one locus by 255 moves the trait by its weight.
    - `mendel` dominance (one test per locus kind, covering every genotype of the first two alleles): iridescence (plain dominant over iridescent); pattern (none < rings < spots ≡ stripes; spots with stripes shows both, a co-dominant mask); albino (recessive); luminescence (on dominant); target preference (nearest > weakest > largest by complete rank); an incomplete locus blends (heterozygote halfway).
    - `load`: a heterozygous `lof` changes no trait at all (compare every field with the all-functional genome); homozygous `lof` at L1, L2, L3, L4 each degrades its named trait (membrane integrity, a malformed part, beat strength, metabolism) by the amount in `RULES.genes` and nothing else.
    - Modules: a slot is expressed when present in either haplotype; when present in both, parameters average with a deterministic rounding rule (test odd sums and the 0/255 extremes); the absent module's parameter bytes do not influence any trait.
    - Segments: the segmentation drive maps to 1–8, and every genome from `genesisGenome` (T7) expresses 1. Max size: `maxBiomass = 300 · 2^(13·t)` per DESIGN §6; `t = 0` gives 300, `t = 1` gives 300·8192.
  - Notes: `Traits` is plain data, grouped (`body`, `skin`, `modules`, `mouth`, `senses`, `behaviour`, `colour`, `physiology`, `defects`). Tables of ranges live in `RULES.genes` and in DESIGN §6. Behaviour genes are expressed now and used in M7.
  - Done: `express.ts` returns `Traits` (groups `body`, `skin`, `modules`, `mouth`, `behaviour`, `colour`, `physiology`, `defects`; the gait genes sit under `behaviour` and no locus feeds a `senses` group), and `RULES.genes` holds the ranges and load factors (DESIGN §6). `QUANT_TRAITS` is the one table of linear traits; the tests walk it.
  - Gotcha: the "every genesis genome has 1 segment" check waits for T7 (`genesisGenome`). Max size multiplies whole octaves exactly, so t = 0 and t = 1 give exactly 300 and 2,457,600; `express` also tolerates non-canonical hand-built genomes.

- [x] T5 Development: bounded, repaired body plans
  - Acceptance:
    - `develop(traits): BodyPlan` is total and deterministic. A plan has 1–8 segments along a bilateral axis, at most 24 appendage instances of at most 4 joints each, at most one branching level with at most 2 branches, at most 12 colliders with the core first, plates, a mouth, and a bounding radius ≤ 2.5 core radii.
    - `bodyViolations(plan)` returns `[]` for the repaired plan of every genome in these sets: 10,000 random genomes (seeded), the extreme genomes (all zero, all 0xFF, alternating, every module present with all parameters 0 and with all 255, all 8 modules present in both haplotypes), and 10,000 mutated genomes (random genome → `mutateGenome` with mutation ×4, if T8 is not built yet use a local helper that flips 1–6 random bytes). A test also feeds `bodyViolations` a hand-made bad plan for each rule (too many segments, an overlapping appendage pair, no mouth, no propulsion, oversized bounds) and sees the matching message.
    - Repair guarantees (each shown by a hand-made genome that would violate it): at least one propulsion source (a default ciliary band is added when motile area is below `RULES.develop.minThrustArea`); a mouth opening at the front; appendages on one attach segment keep at least `RULES.develop.minAngleGap` radians apart (or are merged); lengths are clamped so the bounds hold; appendage counts are trimmed in a stable order (never by hash-map order).
    - Mesh budget by construction: `estimateVertices(plan, 'full') ≤ 6000` and `(plan, 'low') ≤ 1500` for all the sets above (the builder in T10 meets the estimate).
    - Determinism and plain data: `structuredClone(plan)` hashes the same; no NaN or Infinity; a golden `hashPlan` for 20 fixed genomes (stored with `RULES_VERSION`).
    - Speed: `develop` plus `computeStats` (T6, add its call in T6) median under 0.1 ms on 1,000 genomes, and the 20,000-genome property suite finishes within 8 s of `npm run check`'s budget (record the time; if it is slower, make development faster rather than shrinking the sets).
  - Notes: development is where the caps live (ADR 0006), never the renderer. Segment `i` has length, radius and taper from the body traits; modules become appendage instances per `pairs`, mirrored left and right, positioned by `attach start` and `attach span`.
  - Done: `develop.ts` (`develop`, `bodyViolations`, `estimateVertices`, `motileArea`, `planBounds`, `hashPlan`) with `RULES.develop` and DESIGN §6; goldens in `__golden__/develop.json`. 20,000 genomes (10k random, 10k byte-flipped stand-ins for `mutateGenome`) develop and check in about 2.7 s; `develop` alone takes about 50 µs at the median (so T6's `computeStats` has the other 50).
  - Gotcha: parts are built for the left side and mirrored, so every repair is symmetric. Beat strength (L3), membrane integrity (L1) and metabolism cost (L4) are applied by `computeStats` (T6), not here; only the malformed part (L2) is a development effect. The mutated set switches to `mutateGenome` when T8 lands.

- [x] T6 Stats from form, with costs
  - Acceptance:
    - `computeStats(plan, traits)` returns thrust, drag, turn, mass, basal multiplier, mouth, colliders, `combat` (reach, arc, power, armour, spines), `sense` (detection ring), `glow` and the physiology multipliers (lifespan, UV and pressure tolerance, kept for M4 and M6). `physOf(stats)` returns a `PhysStats` that `sanitizePhys` leaves unchanged.
    - Formulas (DESIGN §6): thrust sums over motile parts of length × thickness × beat × efficiency (tip shape and size); weapon reach and power come from pointed or hooked tips × stiffness × length; armour is plating × coverage; spines add contact damage; the basal multiplier is `1 + 0.1(segments − 1) + 0.04·appendages + 0.2·plating + 0.1·luminescence`. No stat reads a part label (a plan has none); renaming nothing matters.
    - Whip versus paddle: for a plan whose only motile part is a whip and one whose only motile part is a paddle (same area), thrust per unit of biomass crosses exactly once between biomass 1,024 and 262,144, with the whip ahead below the crossing and the paddle above (scan sizes 100 to 1e6 on a log grid).
    - Costs: adding an appendage never lowers drag; adding plating raises armour and mass, raises the basal multiplier, and lowers turn; adding a segment raises the basal multiplier; luminescence raises the basal multiplier. (Property test over 1,000 genomes: apply each change at the genome level and compare.)
    - Archetypes: `tests/archetypes.ts` builds six genomes through the karyotype API: flagellate (one whip), ciliate (a ciliary band), swimmer (long body, paddle fins), armoured (plates and spines, heavy), filter feeder (wide filter mouth, slow), hunter (jaw, weapon tip). Metrics at sizes 100, 3,000 and 30,000 biomass: top speed, acceleration, turn rate, distance per energy, detritus intake, crystal intake, armour, weapon power. Each archetype is best at one or more metric at some size, worst at one or more at some size, and none is best at more than 3 of the 8 at any one size.
    - Genesis starters: the median top speed over 1,000 `genesisGenome` seeds is within 0.8–1.2× of the M1 cell's (`STARTER_PHYS`), and `physOf(buildCreature(starterGenome()))` is within 1% of `STARTER_PHYS` on every multiplier (the mouth and colliders match exactly).
    - Determinism across engines (E2E, `m3-determinism.spec.ts`, chromium): with `?debug=1`, `__bs.genome.hashes(list)` returns `{ planHash, statsHash }` for the 20 golden genomes and they equal the Node goldens (the same floating-point operations in every engine).
  - Notes: normalise so the starter flagellate ≈ `STARTER_PHYS`. All constants are in `RULES.genes` and DESIGN §6; function follows form, never a hard-coded bonus for a named part.
  - Done: `stats.ts` (`computeStats`, `statsAt`, `physOf`, `buildCreature`, `hashStats`), `starter.ts` (`starterGenome`), constants in `RULES.stats` and DESIGN §6; goldens in `__golden__/stats.json`; `tests/archetypes.ts`; `m3-determinism.spec.ts` through `__bs.genome.hashes` (`?debug=1`). `develop` + `computeStats` run in about 75 µs at the median.
  - Gotcha: `computeStats(plan, traits)` is the adult value (`statsAt` takes a size, which only thrust efficiency uses); the sim keeps it for the whole life. Multipliers are normalised to the reference cell, so the starter equals `STARTER_PHYS` by construction. To make its colliders match exactly, parts too thin for a minimum-radius circle (width × 0.5 below `minColliderRadius`: cilia, whips) now get no collision circle (two develop goldens regenerated under rules version 3). The "genesis median speed within 0.8-1.2x" check waits for T7 (`genesisGenome`).

- [x] T7 Genesis distribution and unique DNA
  - Acceptance:
    - `genesisGenome(seed)` is a pure function of the seed. Every genesis genome expresses exactly 1 segment (a single cell), has a propulsion source (M1 slot holds a whip-like flagellum; M2 slot is present in half of them as a ciliary band), `maxBiomass` in 300–900, and an empty `bodyViolations`.
    - 20,000 seeds: all genome hashes are different; the number of distinct appearance keys (hue bin of 24 × pattern 4 × membrane band 3 × albino × iridescent × luminescent) exceeds 400 for the first 1,000 seeds; the hue histogram over 12 bins has no bin under 5% or over 14%.
    - Allele frequencies (counted over the alleles themselves, ±4σ): iridescent 5%, albino 4%, stripes 10%, each load allele 3%. The expressed phenotype frequencies match their exact values from the allele frequencies within ±4σ (for example iridescent expressed 0.25%).
    - Golden: three fixed seeds produce the committed genome hashes. `starterGenome()` is a fixed constant whose `physOf` matches T6, with no rare features.
    - Genesis speed (carried from T6): the median top speed over 1,000 `genesisGenome` seeds is within 0.8–1.2× of the M1 cell's (`STARTER_PHYS`); `starterGenome()` already exists (`starter.ts`).
    - Look and shape distinctness: no two of the first 200 genesis creatures have identical (appearance key, appendage count, mouth type band) triples more than 3 times (a loose guard against a distribution collapsing).
  - Notes: genesis uses its own PRNG stream (`createRng(seed, 'genesis')`). Rare alleles mostly arise through breeding (DESIGN §5), so keep the genesis frequencies as listed. Update the DESIGN §6 genesis lines if the implementation differs.
  - Done: `genesis.ts` (`genesisGenome(seed: Seed)`, `GENESIS_FREQ`), tests in `genesis.test.ts` (20,000 seeds, about 450 appearance keys in the first 1,000, median speed about 1.1× the M1 cell's), golden hashes in `__golden__/genesis.json`.
  - Gotcha: the M1 whip must keep `length × width × beat` above `RULES.develop.minThrustArea`, or development adds its own band and the speed jumps. A cell with the malformed-part defect (L2, about 1 in 1,100) can fall below it by design. Trait loci are scattered around a target mean (`Builder.mean`) so cells are heterozygous but their traits are exact. The starter's gait amplitude is 0 and the speed grows with size, so genesis keeps gait low and sizes skewed small to hold the median speed near 1.1×.

- [x] T8 Meiosis, mutation and inheritance
  - Acceptance:
    - `offspringSeed(randomness, commitId, slot)` is `SHA-256('bs/offspring/v1' ‖ randomness ‖ commitId ‖ slot)` reduced to a four-word `Seed`; a known-answer vector is committed. Slots 0 and 1 differ.
    - `breed(a, b, seed, { mutation })`: the child is `gamete(a) + gamete(b)` with named streams `meiosis-a`, `meiosis-b`, `mutation-a`, `mutation-b`. The child's first haplotype is built from `a`'s two haplotypes only, and the second from `b`'s.
    - Meiosis: per chromosome 0–2 crossovers at locus boundaries with the probabilities in `RULES.genetics`, and independent assortment across chromosomes.
    - Mendelian ratios with mutation off, over 4,000 children from fixed parents and a fixed seed (within 4σ): `Aa × Aa` for iridescence gives 3 plain : 1 iridescent phenotype and 1 : 2 : 1 genotypes; a test cross `Aa × aa` gives 1 : 1; the dihybrid iridescence (chromosome 2) × albino (chromosome 6) gives 9 : 3 : 3 : 1.
    - Linkage: two loci next to each other on one chromosome recombine at the rate the crossover model predicts (compute it exactly from `RULES.genetics` and compare within 4σ); two loci at opposite ends recombine in 35–50%; loci on different chromosomes recombine in 50% ± 4σ.
    - Mutation: at most 3 events per gamete; the kinds are quant step, allele change within a table, load flip, parameter drift, module duplication into an empty slot, module deletion, and a rare novel allele. With `mutation: 0` every child allele at every locus equals one of the parents' alleles at that locus (1,000 children). Over 20,000 gametes each kind occurs and the event count distribution follows `RULES.genetics`. A duplicated module starts as a copy and the two copies diverge under later drift.
    - Named streams isolate: with the same seed, the meiosis outcome (which parental allele goes where) is identical with mutation on and off apart from the mutated loci.
    - Distinct slots: for 1,000 pairs of different parents, slot 0 and slot 1 children differ in at least 99%.
    - Viability: 10,000 children of random genesis pairs and 10,000 descendants after 5 generations of repeated breeding at mutation ×4 all have an empty `bodyViolations`, and `express` and `computeStats` return finite numbers. (Reuse the sets of T5.)
    - Determinism: the same inputs give the same child; three child hashes are committed as goldens (`RULES_VERSION`).
  - Notes: `mutateGenome` is the single-parent path for the Lab (a child of one genome with a mutation pass). All randomness comes from the seed (ADR 0006); no `Math.random`.
  - Done: `inherit.ts` (`offspringSeed`, `meiosis`, `mutateHaplotype`, `applyMutation`, `breed`, `mutateGenome`), `RULES.genetics` and DESIGN §6; goldens in `__golden__/inherit.json`. The 10,000-genome mutated set in `develop.test.ts` now uses `mutateGenome` ×4.
  - Gotcha: an end-to-end linkage check needs quant markers, because load and `mendel` bytes fold to 0/1 (a 0/255 marker cannot survive canonical form). Many `expect` calls in 10,000-genome loops are slow; test with plain booleans and `expect` only the first failure.

- [x] T9 Rarity, species names and the diversity report
  - Acceptance:
    - `rarityOf(genome)`: score is Σ −log2(frequency) over the expressed rare features, where the frequency of a feature is its exact expressed-phenotype frequency under the genesis distribution (T7), and a feature genesis never produces (extra segments, a module kind outside genesis, a novel allele, a size beyond genesis) counts 12 bits. Features: iridescent, albino, stripes, spots, rings, luminescent, segments > 1, extra modules, novel alleles, size tier ≥ 1. Tiers: common < 4, uncommon 4–8, rare 8–14, exotic ≥ 14 (DESIGN §6). `features` lists the names.
    - Monotone: adding any listed rare feature to a genome never lowers the score; a genome with no rare features scores 0. Over 20,000 genesis genomes: at least 80% are common, between 3% and 20% uncommon or higher, and under 1% exotic. A hand-built iridescent + albino + striped genome is exotic. Goldens for five fixed genomes.
    - `speciesName(genome)`: deterministic from the genome hash and body traits, ASCII, at most 28 characters, a genus built from syllables and an epithet from the dominant trait ("natans" for swimmers, "filtrans" for filter feeders, "armatus" for armoured, "ferox" for jaws, and so on). Among 10,000 genesis genomes fewer than 1% of names collide with another genome's; none contain a word that `src/net/text.ts` filters; identical genomes get identical names.
    - `describeCreature(creature): string[]`: plain-words sentences covering body, movement, feeding, defence, looks and rarity. No sentence contains "allele", "locus", "quant", "haplotype", "gene" or a raw number with more than 2 decimals. Golden sentences for three creatures.
    - Report tool: `npm run report:diversity -- --genesis 2000 --bred 2000 --generations 6` (any runner that handles the extensionless TypeScript imports, such as `vite-node`) prints Markdown: valid-body count (must equal the sample), segment and appendage histograms, tier counts, rarity tiers, distinct appearance keys, vertex estimates (median, p99, max) and development time. A unit test runs it with tiny numbers and checks the sections and the zero-invalid line. Run it once at the full size and paste the numbers in the task note.
  - Notes: `speciesName` and `describeCreature` are the only places where user-facing genetics wording lives; keep it free of jargon (DESIGN: readable before understanding genetics).
  - Done: `rarity.ts` (feature costs come from the genesis allele frequencies through the real dominance rules; ten features, 12 bits for those genesis never makes; `rarityOfTraits` also feeds the Lab), `names.ts` (three syllables, a suffix, an epithet from the strongest trait) and `describe.ts` (six sentences); `npm run report:diversity` loads `tools/diversity-report.ts` through Vite. Full run (2,000 genesis + 2,000 bred over 6 generations): 4,000 of 4,000 valid; 88.4% common, 2.9% uncommon, 5.4% rare, 3.3% exotic (bred); vertices median 288, p99 450, max 582; build time median 0.06 ms, p99 0.33 ms.
  - Gotcha: a texture blend of ridged + smooth equals grainy + grainy, so it is not "novel"; the syllables skip k, p and f because "kanake" came out of the filter test. Size tier 1 starts at a max size of 1,024 (radius 32, ADR 0013).

- [x] T10 Creature mesh: one merged geometry, cached by genome hash, with LODs
  - Acceptance:
    - `buildCreatureGeometry(plan, 'full' | 'low')` returns a single indexed `BufferGeometry` with `position` (body frame, x forward, units of the core radius), `normal`, `uv`, and per-vertex gait attributes (`aSpine` the position along the spine 0–1, `aAttach` the spine position the part hangs from, `aWeight` the 0–1 distance from the part's base, `aPart` an id for beat phase and part kind: body, appendage, plate, mouth).
    - Budget (unit tests in Node, no GL): vertices ≤ 6,000 (full) and ≤ 1,500 (low) and equal to the T5 estimate for 1,500 random genomes and the extreme genomes; the geometry's bounding radius ≤ 2.5 core radii × 1.05; no NaN; every index in range; the output is deterministic (hash of the position array equal across two builds); a single-segment genesis cell with no appendage has the same silhouette extent as the M1 cell (core radius 1).
    - The body is a continuous surface: for each segment boundary the cross-section rings share vertices or match exactly (no gap) and each appendage's base ring lies on the body surface within 0.02 core radii (1,000 genomes).
    - `CreatureCache`: `acquire` of the same genome hash twice builds once; `release` to zero disposes the geometry and material (spy on `dispose`); 200 acquire and release cycles over 50 distinct genomes end with `live() === 0`; `lodFor(screenRadiusPx)` picks `'low'` below 12 px and `'full'` above 16 px (hysteresis between).
    - E2E (Lab hook from T13 may come later; here use a debug page hook `?debug=1`): 24 distinct creatures draw in 24 draw calls and triangles under 150k (`renderer.info`). If the Lab does not exist yet, this check moves to T13 and the unit tests stay here.
  - Notes: the part geometry is a loft of ellipses along the spine (body) and a swept tapered tube along a curved path with up to 4 joints (appendages), plates as thin shells, the mouth as an opening ring. Ring and path samples scale with detail. A thin, flat creature is fine; readable silhouettes matter (render rules).
  - Done: the draw-call and triangle E2E moved to T13. The body is one loft through rings of every segment sorted by x (union of the ellipses), so segments never leave a gap; plates lift the dorsal vertices in z and the mouth marks the front vertices through `aPart` (kind in the low two bits, appendage number above), adding no vertices. Tubes cannot bend tighter than their radius (a short fat curved part otherwise folds inside out). `CreatureCache` uses a plain placeholder material until T11 and T12.

- [x] T11 Shader gait: one attached, living body
  - Acceptance:
    - `creature.vert.glsl` moves the whole mesh from per-genome uniforms (`uAmp`, `uFreq`, `uPhase`, `uBeat`, `uBend`): a wave travels along `aSpine`; an appendage vertex first takes the spine displacement at `aAttach` and then its own beat displacement weighted by `aWeight` (0 at the base). The phase is integrated per frame from speed (reuse `beat.ts`); changing the frequency never jumps the pose (no `uTime * rate`).
    - `gaitOffset` in `gait.ts` is the CPU reference with the same formulas. Unit tests over 500 random genomes, the extreme genomes and 8 phases: (a) the offset of an appendage's base ring equals the spine offset at its attach position within 0.01 core radii (it cannot detach); (b) no vertex moves more than 0.6 core radii from its rest position; (c) at throttle 0 the body only breathes (offset ≤ 15% of the moving amplitude); (d) raising `uFreq` mid-run changes the pose by at most 0.05 core radii per frame step at 60 fps.
    - The starter cell (a `starterGenome` body) looks like a cell with a waving flagellum attached to the body: the existing M1 look E2E (`m1-look.spec.ts`) still passes unchanged once the player uses this mesh (T15), and a Lab screenshot test (T13) shows the flagellum base touching the cell wall.
    - Hurt and dissolve effects (`uHurt`, `uDissolve`) exist in the new shader with the same meaning as `cell.frag.glsl`.
    - Silhouette connectivity (E2E, Lab): 12 sample creatures (the six archetypes and six extreme genomes) at 4 gait phases each; the decoded screenshot's lit mask has one connected component holding at least 98% of the lit pixels.
  - Notes: addresses the owner's Playtest v0.2.0 note (tail and body are one attached mesh). GLSL cannot run in unit tests, so the CPU reference plus the screenshot connectivity check carry it. Keep the vertex shader cheap: no loops over parts, one wave and one beat term.
  - Done: `gait.ts` (CPU reference), `creature.vert/frag.glsl`, `creatureMaterial`, `CreatureView` (clones the cached material per view, since gait uniforms are per creature) and the cache's default material. The shader is a spine sway plus one part beat; at rest only `BREATH` (12%) of the swing remains. The M1 look E2E, the Lab screenshot and the 12-creature connectivity check move to T15 and T13 (no player or Lab uses the mesh yet); a throwaway Chromium render of the six archetypes at 5 beat states showed no shader errors and tails attached.
  - Gotcha: `uFreq` only sets how fast the phase is integrated (`advanceBeatPhase(…, freq)`), never the pose, because a spatial use would jump the pose when it changes; the test raises it by 0.5 after an hour.

- [ ] T12 Materials from genes
  - Acceptance:
    - `materialParams(traits)` (pure, in `src/render/`) maps genes to uniforms: base colour from hue, saturation and value (HSV with fixed lightness rules); translucency and membrane thickness; pattern kind and scale (none, rings, spots, stripes, spots and stripes together); albino (saturation ≤ 0.1, a pale pink body); iridescence (> 0 only when expressed, a thin-film hue shift with view angle); luminescence (an emissive pulse with its own hue; 0 when not expressed); plating opacity; a rim light strength that keeps the silhouette readable. Unit tests per mapping with exact expectations (for example albino → saturation ≤ 0.1; iridescence 0 for the dominant plain allele).
    - One shader program serves every creature: adding 24 distinct creatures to a scene leaves `renderer.info.programs.length` unchanged (E2E in the Lab).
    - Material uniforms are cached with the geometry by genome hash (T10) and never rewritten per frame except `uTime`, `uPhase`, `uBeat`, `uHurt`, `uDissolve`, `uAlpha`.
    - Readability (E2E, Lab, software GL): for 24 creatures on the Lab background, the mean luminance of the creature's silhouette differs from the water background by at least 0.12 (0–1 scale), the silhouette is not blank, and the mean colour distance between any two creatures of different hue bins exceeds 0.08.
    - The hue-tinted remote cell of M2 keeps working as the fallback for peers whose genome has not arrived (T16).
  - Notes: follow the art direction in `render.md`: translucent membranes with internal glints, rim and back light, macro look. Pattern, iridescence and glow are shader terms, not textures.

- [ ] T13 Creature Lab: grid and inspector
  - Acceptance:
    - `lab.html` is a second entry of the Vite build (`vite.config.ts` `build.rollupOptions.input`), so `npm run build` emits `dist/lab.html`. The title screen has a "Creature Lab" link (`data-testid="lab-link"`), and the Lab links back.
    - The Lab shows a grid of 24 creatures from `?seed=` (random when absent); a toggle switches between "genesis" and "wild" (random genome bytes, to show the extremes). Hovering lifts a creature; clicking selects it and fills the inspect panel from `describeCreature` (body, movement, feeding, defence, looks, rarity, species name, tier, vertices, genome hash).
    - `window.__lab` (always available): `ready`, `state()` → `{ seed, mode, creatures: [{ index, hash, species, tier, rarity, vertices }], selected, offspring }`, `select(i)`, `setMode(mode)`, `renderInfo()` → `{ calls, triangles, programs, geometries }`.
    - E2E (`m3-lab.spec.ts`): the Lab loads without console errors; `state().creatures.length === 24` with 24 distinct hashes; draw calls ≤ 40 and triangles ≤ 150k; clicking creature 5 sets `selected` and shows its species name in the panel; switching to wild shows 24 valid bodies (the page asserts `bodyViolations` empty for each); a screenshot is non-blank and the connectivity check of T11 holds on the grid.
    - The task moves the budget and programs checks forward from T10 and T12.
  - Notes: the Lab uses its own small `THREE.WebGLRenderer` (no post-processing), a dark water backdrop and the shared creature view. It makes no network calls (assert no requests beyond the page's own files).

- [ ] T14 Creature Lab: mutate, breed, import and export
  - Acceptance:
    - "Mutate" replaces the selected creature by `mutateGenome(selected, seed, { mutation: 4 })` (a visible step in the grid, a new hash, a valid body); "Undo" restores the previous one.
    - "Breed" with two selected creatures (click, then shift-click) shows exactly 8 offspring: for k = 0..7 the child is `breed(A, B, offspringSeed(labRandomness, 'lab-' + (k >> 1), k & 1))`. All 8 are valid; at least 6 have different hashes from each other and from both parents (fixed seed); the same selection and seed always give the same 8; with mutation off, every child's alleles come from its parents (reuse the T8 check on the Lab's batch function `breedBatch`).
    - Export and import: "Copy genome" puts the base64url genome in a text field; pasting a genome into "Load genome" puts that creature in the selected cell with the same hash; garbage text shows an error line and changes nothing. The same text works in the game as `?genome=` (T15).
    - Inspect for an offspring names which parent each Mendelian trait shows (for example "iridescence: from neither, hidden in both parents") using exact genotype enumeration from the karyotype (unit tests on `explainTrait`: 20 cases). No percentages promised to the player yet (Punnett hints are M5).
    - E2E: select two creatures, press Breed, `state().offspring.length === 8`, each with a hash and species; press Mutate and see the selected hash change; export then import round-trips the hash.
  - Notes: the Lab seed for offspring is a local fake "randomness" (hash of the page seed); real beacons arrive in M5.

- [ ] T15 The game hatches a body
  - Acceptance:
    - Hatching builds `genesisGenome(seed)` from a browser-local random seed (created in `src/game/`, never in `sim` or `genome`), `buildCreature`, and spawns with `phys`. A new hatch after death gives a different genome (hashes differ across 10 hatches). `?genome=<base64url>` (or `?genome=starter`) pins the body for tests and the Lab export; an invalid value falls back to genesis and the console warns once.
    - The player is drawn with `CreatureView` and the creature cache (not the old `Cell`), scaled to the creature's radius, with gait driven by throttle and speed. The old `Cell` stays as the fallback for peers without a genome and if building a mesh throws (caught, logged once).
    - Anatomy changes play (E2E, `?debug=1`, `state().player` gains `genomeHash`, `species`, `rarity`, `tier`, `stats` (the `PhysStats`)): steering east for 4 s from rest, the measured speed of the `flagellate` and the `armoured` archetype (pinned with `?genome=`) are within 15% of the speeds the stats predict, and they differ by at least 20%; a genome with `maxBiomass` 150 stops growing at 150 (`debug.setEnergy` to the maximum, 20 s); a filter-mouth genome eats nearby detritus and ignores a crystal beside it (`debug.teleport` next to one and `nearestFood`).
    - The HUD shows the species name and rarity (`data-testid="hud-species"`), and the death screen shows them too.
    - Death still dissolves the new mesh with the 1.2 s timing from `FX`; eat, dash and damage effects still show.
    - The existing M1 and M2 E2E specs run with `?genome=starter` in their helpers and pass unchanged in value (thresholds untouched); `m1-look` passes with the new mesh. If a threshold cannot hold, the task fixes the cause; it never loosens the check.
    - Camera: the visible half-height follows the creature's radius `√biomass` (DESIGN §3) and a long body does not push parts off the screen at the starter zoom (the bounding radius ≤ 2.5 × the core radius fits the view at tier 0).
  - Notes: keep `src/game/app.ts` from growing: put hatching in `src/game/body.ts`. Tests that need a stable creature use `starter`. Update `tests/e2e/helpers.ts` once.

- [ ] T16 Bodies on the wire
  - Acceptance:
    - Protocol: `PeerEvent` gains `{ t: 'genome', data }` (base64url, ≤ 2 KB, validated by `parsePeerEvent`; anything else returns `null`); the snapshot version byte is 2 and its reserved bytes carry `genomeRef` (the first two bytes of the genome hash). A version 1 snapshot is dropped and counted. Because a creature can now reach 2.4 million biomass, `biomass` in the snapshot is quantised on a log scale (u16 over 1 to 2^24, relative error ≤ 0.03%); energy and health are quantised against the creature's maximum (state the encoding in the codec comment and test the round trip at 100, 900 and 1e6 biomass).
    - Codec tests extend the existing fuzz tests: random bytes never throw; a genome event of 5,000 characters or non-base64url text is rejected.
    - Behaviour (unit, with fake channels): when a `state` link opens, each side sends its genome once; a rehatch sends the new genome to every open link; a receiver ignores more than one genome event per 2 s per peer (counted in `net.dropped`) and ignores genome events from a peer with no link.
    - A remote is drawn with its genome's body when a genome event has arrived and its snapshot `genomeRef` matches the genome's hash prefix. When the snapshot's ref changes the old body stays up to 5 s waiting for the new genome, then the tinted fallback cell is shown. A remote body is scaled to the snapshot's biomass.
    - `state().remotes[i]` gains `genomeHash` and `species` (or `null` for the fallback).
    - Hostile genomes (E2E with `debug.deliver` or `setRemotes`): all-0xFF, all-zero, truncated and a maximum-complexity genome do not throw; `bodyViolations` is empty for the built plan; triangles in `renderer.info` stay under the 300k budget with 23 such remotes at once.
    - E2E (two contexts through the local hub): A and B see each other's `genomeHash` equal to the sender's within 3 s of connecting; B dies and rehatches, and A's view of B updates within 3 s; with the genome event withheld, B shows as the fallback cell.
  - Notes: a joiner receives genomes from the peers it connects to, and the existing in-pond tests keep their timing budgets. `PROTOCOL_VERSION` for the hub stays 1 (the hub only relays); only the snapshot version changes. Peers on an old cached page won't see new ones; accepted before 1.0.

- [ ] T17 Archetype tournament: nobody wins everything
  - Acceptance:
    - `tools/` or `src/genome/tournament.test.ts` runs the six archetypes of T6 through four sim scenarios, each with a simple deterministic bot, 8 seeds each: (1) forage for 3 simulated minutes in the default world (score: biomass gained); (2) a plume gauntlet (a line of `extraPlumes` to cross; score: health left and time); (3) a sprint to a point 2,000 wu away (score: time); (4) a hungry cruise (no food, 40% energy; score: time until starvation). Each scenario has a different winner or at least a different ranking: no archetype wins more than 2 of the 4 scenarios, and every archetype wins at least one scenario or is ranked first or second in two.
    - Determinism: two runs give identical results (a hash of the scores), and the summary hash is a golden under `RULES_VERSION`.
    - If the tournament fails, retune the formula constants in `RULES.genes` and DESIGN §6 (never the test) and note the change; a retune that moves a T6 expectation updates that test's data, not its rules.
    - The report prints a table (archetype × scenario) to the task note.
  - Notes: this is the M3 form of "no build is best at everything" (M7 repeats it for combat). Bots use `step` and the real feeding rule from T2.

- [ ] T18 Render budget with many bodies
  - Acceptance:
    - Worst case: take the genome with the most vertices among 1,500 random and the extreme genomes, and 24 copies with different tints (24 distinct hashes by a one-byte change that leaves the geometry, or 24 maximal genomes): `renderer.info.render.calls ≤ 150` and `triangles ≤ 300,000` (DESIGN §12 medium) in the game scene with water, food and plumes; the 24 creatures take 24 calls. The `low` LOD is used for small ones: each creature under 12 px on screen has ≤ 1,500 vertices.
    - Dispose: 200 creatures added and removed over 50 distinct genomes leave `renderer.info.memory.geometries` and `textures` at their baseline, and `CreatureCache.live()` at 0.
    - Build cost: building the worst-case geometry takes under 100 ms in Chromium (CPU, software GL does not matter); a cache hit builds nothing (spy).
    - Frame cost in software GL is not asserted (CI has no GPU); the test records the draw and triangle counts.
    - No per-frame allocations in `CreatureView.update` and the gait uniforms path (code review plus a loop of 10,000 updates in a unit test that sees no new `THREE.Vector*`, `Color` or `Matrix*` instances through a constructor spy).
  - Notes: any budget overrun is fixed in the builder's sample counts (and the T5 estimate), never by raising a budget. Record the numbers.

## End-to-end check

`tests/e2e/m3-morphology.spec.ts` plus the T6, T11, T13 to T16 specs together cover the scenario below. Anything long goes in `test:e2e:full` (`@slow`), the rest runs in the PR suite.

1. Open the Lab: 24 genesis creatures, all valid and all different; wild mode shows 24 valid extremes. Select two, breed: 8 valid offspring, deterministic. Mutate, undo, export, import: the hash round-trips.
2. Open the game with `?genome=` for two archetypes: each hatches with its own body, swims at the speed its stats predict, grows to its own maximum size and feeds according to its mouth. Each shows its species name and rarity.
3. Two browsers share a pond: each sees the other's exact body (same genome hash), a rehatch updates it, and a missing genome shows the fallback cell.
4. The property suites: 10,000 random, 10,000 mutated and 10,000 bred descendants have zero invalid bodies; the golden hashes for genome, plan, stats and offspring are equal in Node and Chromium.

Exit criteria map: "DNA → bounded development → body, stats and mesh" T3–T6, T10–T12; "zero invalid bodies over 10k random and mutated genomes" T5, T8; "anatomy changes movement, collision and feeding" T1, T2, T15; "Creature Lab page" T13, T14; "unique genesis DNA" T7. Owner notes from Playtest v0.2.0: growth pace and the max-size gene T1, T4; an attached living body T10, T11.

## Rubric

- [ ] The genesis creatures in the Lab look different from each other at a glance: shape, colour, pattern and mouth (evidence: a 24-creature Lab screenshot, `state()` appearance keys, and the T7 distinctness numbers).
- [ ] Silhouettes are readable over the water: body, mouth and appendages are recognisable at default zoom (evidence: Lab and game screenshots, the T12 contrast numbers).
- [ ] Each creature reads as one connected, wriggling body, never as separate sprites (evidence: the T11 connectivity check at 4 phases and a screenshot strip).
- [ ] The Lab inspector explains a creature in plain words with no genetics jargon (evidence: the T9 banned-word test and screenshots).
- [ ] Wild genomes never produce a degenerate body: no zero-size, spiky mess, or hidden mouth (evidence: the 30,000-genome property suites and a wild-mode screenshot).
- [ ] Growth pace feels right and the maximum size matches the genome (owner, with the Playtest v0.4.0 issue).
- [ ] Different bodies feel different to swim and eat with, yet none is clearly the best (owner; evidence: the T17 tournament table).
- [ ] Other players' bodies look right on real networks and appear quickly after a join (owner).

## Risks

- Float determinism across engines for development and stats → arithmetic limited to `sim.md` operations and `math.ts`; Node and Chromium goldens; the T6 cross-engine E2E; Firefox and WebKit are covered in M14.
- The 20,000-genome property suites make `npm run check` slow → measure in T5, make development faster before shrinking the sets, and keep the mesh suites at 1,500 genomes.
- Procedural meshes that look bad (lumpy or spiky) in the Lab → ring and path sampling are bounded and smooth; connectivity and contrast checks; if a part kind reads badly, simplify the loft rather than adding special cases.
- The shader gait detaching an appendage on some design → every appendage vertex adds the spine displacement at its attach point; the CPU reference proves it for random and extreme genomes.
- Balance (one archetype dominating) → T6 formula tests and the T17 tournament; constants live in `RULES.genes` so retuning is cheap.
- The growth retune and genome stats change the feel of M1 and M2 tests → tests pin `?genome=starter`; thresholds are never loosened.
- Hostile genomes from peers → total decoding, caps in development, rate limits on genome events, and the render budget test with 23 hostile remotes.
- Snapshot version change breaks peers on stale cached pages → accepted before 1.0; the version byte makes them drop each other cleanly.
