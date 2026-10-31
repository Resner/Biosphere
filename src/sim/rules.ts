// Rules v6 (ADR 0005): every simulation number, with initial values from docs/DESIGN.md §2-§4.
// Changing a value that alters outcomes bumps RULES_VERSION and regenerates the goldens.

export const RULES_VERSION = 7;
export const TICK_HZ = 30;
export const DT = 1 / TICK_HZ;

type DeepReadonly<T> = { readonly [K in keyof T]: DeepReadonly<T[K]> };

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

export const RULES = deepFreeze({
  world: {
    /** Square world edge in wu (M1 single pond). */
    size: 8192,
    /** Soft wall width in wu. */
    wallMargin: 64,
    /** Food grid cell edge in wu. */
    cellSize: 256,
  },
  starter: {
    biomass: 100,
    /** Starting energy as a fraction of maxEnergy. */
    energyFraction: 0.6,
  },
  creature: {
    /** maxEnergy = energyPerBiomass * biomass. */
    energyPerBiomass: 2,
    /** maxHealth = healthPerRadius * radius. */
    healthPerRadius: 10,
  },
  movement: {
    /** wu/s^2 at full throttle for biomass 100. */
    thrust: 140,
    /** Thrust scales with (b/100)^thrustExp. */
    thrustExp: -0.1,
    /** Linear drag, 1/s. */
    drag: 2.2,
    /** rad/s for biomass 100. */
    turn: 5,
    turnExp: -0.15,
    /** Dash speed in wu/s for biomass 100, scaled by (b/100)^dashExp. */
    dashSpeed: 120,
    dashExp: -0.1,
    /** Dash energy cost per biomass. */
    dashEnergyPerBiomass: 0.06,
    dashCooldownTicks: 75,
    maxThrottle: 15,
    /** Inward acceleration at the very edge of the world, wu/s^2 (beats full thrust). */
    wallPush: 300,
  },
  metabolism: {
    /** Basal energy/s = basal * b^basalExp. */
    basal: 0.0253,
    basalExp: 0.75,
    /** Movement energy/s = move * b * (throttle/15)^2. */
    move: 0.006,
  },
  growth: {
    /** Growth runs while energy exceeds this fraction of maxEnergy. */
    energyThreshold: 0.75,
    energyPerBiomass: 3,
    /** Biomass/s as a fraction of current biomass. */
    maxRate: 0.012,
  },
  /** Caps on what a body may hand to the rules (ADR 0006); `sanitizePhys` enforces them. */
  body: {
    /** Range of the thrust, drag, turn, basal and growth multipliers. */
    multiplierMin: 0.1,
    multiplierMax: 4,
    maxBiomassFloor: 100,
    /** 300 * 2^13: the top of the max-size gene (DESIGN §6). */
    maxBiomassCeiling: 2457600,
    maxColliders: 12,
    minColliderRadius: 0.05,
    maxColliderRadius: 1.5,
    /** Farthest edge of any collider from the core centre, in core radii. */
    maxReach: 2.5,
    minMouthRadius: 0.05,
    maxMouthRadius: 3,
    minMouthArc: 0.05,
    digestionMin: 0.1,
    digestionMax: 1.5,
  },
  damage: {
    /** hp/s */
    starvation: 8,
    toxin: 15,
    /** hp/s at full exposure, times (1 − tolerance) (M6 T15). */
    uv: 2,
    pressure: 3,
  },
  food: {
    slotsPerCell: 10,
    /** Respawn delay after being eaten, 20-60 s. */
    respawnMinTicks: 600,
    respawnMaxTicks: 1800,
    /** A remote claim or consumed entry may differ from the local tick by this much (30 s, M2). */
    claimTickWindow: 900,
    /** Bobbing drift stays within this many wu of the slot anchor. */
    driftRadius: 12,
    /** Bob amplitude per axis as a fraction of driftRadius (0.7 keeps the diagonal inside it). */
    bobFraction: 0.7,
    bobPeriodMinTicks: 120,
    bobPeriodMaxTicks: 240,
    kinds: {
      detritus: { value: 8, radius: 1.5 },
      globule: { value: 25, radius: 3 },
      crystal: { value: 60, radius: 2.5 },
    },
    /**
     * Relative weights of a slot's food kind by the zone at its anchor (M6 T15). Vent crystals
     * grow in the deep and the abyss, and richest within `ventRange` wu of a vent (a plume anchor).
     */
    zoneWeights: {
      shallows: { detritus: 55, globule: 45, crystal: 0 },
      twilight: { detritus: 62, globule: 38, crystal: 0 },
      deep: { detritus: 90, globule: 0, crystal: 10 },
      abyss: { detritus: 40, globule: 0, crystal: 60 },
    },
    nearVentWeights: {
      deep: { detritus: 60, globule: 0, crystal: 40 },
      abyss: { detritus: 20, globule: 0, crystal: 80 },
    },
    ventRange: 300,
  },
  /** Food efficiency by mouth type, at the anchors type 0 (filter), 0.5 (middle) and 1 (jaw); linear between. */
  feeding: {
    efficiency: {
      detritus: { filter: 1, middle: 0.8, jaw: 0.4 },
      globule: { filter: 0.6, middle: 1, jaw: 0.8 },
      crystal: { filter: 0, middle: 0.6, jaw: 1 },
    },
  },
  /** Gene expression (M3, DESIGN §6): trait ranges for the quantitative loci and the loss-of-function amounts. */
  genes: {
    /** Maximum segments; the segmentation drive 0-1 maps onto 1..max in equal steps. */
    segments: 8,
    /** maxBiomass = base × 2^(octaves × t), with t the mean of the size loci scaled to 0-1. */
    size: { base: 300, octaves: 13 },
    /** [low, high] for each quantitative trait, by trait group. */
    range: {
      body: { aspect: [0.8, 2.4], taper: [0, 0.8], flexibility: [0, 1] },
      skin: { membrane: [0, 1], translucency: [0, 1], plating: [0, 1], spines: [0, 1] },
      mouth: { size: [0.2, 1], type: [0, 1], digestion: [0.7, 1.2] },
      behaviour: {
        gaitAmp: [0, 1],
        gaitFreq: [0.5, 2],
        aggression: [0, 1],
        caution: [0, 1],
        curiosity: [0, 1],
        reflex: [0, 1],
      },
      colour: {
        hue: [0, 1],
        saturation: [0.3, 1],
        value: [0.35, 1],
        patternScale: [0, 1],
        lumHue: [0, 1],
      },
      physiology: {
        lifespan: [0.6, 1.6],
        metabolism: [0.7, 1.4],
        growth: [0.7, 1.4],
        uvTolerance: [0, 1],
        pressureTolerance: [0, 1],
      },
      /** Karyotype v2 body shape (ADR 0025): 0 is off, the v1 body; development reads them from M6 T7. */
      shape: {
        curve: [0, 1],
        curveMode: [0, 1],
        headScale: [0, 1],
        trunkSwell: [0, 1],
        tailLength: [0, 1],
        tailTaper: [0, 1],
        fusion: [0, 1],
        symmetry: [0, 1],
        drape: [0, 1],
        eyeSize: [0, 1],
        eyeStalk: [0, 1],
      },
      /** Karyotype v2 module-slot extension (ADR 0025): 0 is off; development reads them from M6 T8. */
      part: {
        webbing: [0, 1],
        setaeDensity: [0, 1],
        setaeLength: [0, 1],
        bulb: [0, 1],
        chela: [0, 1],
        beads: [0, 1],
      },
    },
    /** A homozygous loss of function (L1-L4) sets its defect factor to this; heterozygotes are unaffected. */
    lof: { membraneIntegrity: 0.6, partScale: 0.6, beatStrength: 0.7, metabolismCost: 1.3 },
  },
  /** Inheritance (M3, DESIGN §6): meiosis and mutation. Frozen per rules version. */
  genetics: {
    /** Chance of 0, 1 and 2 crossovers on a chromosome in one meiosis; each lands on a uniform locus boundary. */
    crossovers: [0.4, 0.4, 0.2],
    /** A gamete gets up to `maxEvents` mutation trials, each firing with `eventChance` × the mutation factor (capped at 1). */
    maxEvents: 3,
    eventChance: 0.15,
    /** Relative weights of the mutation kinds, in `MUTATION_KINDS` order. */
    kinds: {
      quantStep: 30,
      alleleChange: 14,
      loadFlip: 10,
      paramDrift: 20,
      moduleDuplicate: 8,
      moduleDelete: 8,
      novelAllele: 10,
    },
    /** A quant step or parameter drift moves a byte by 1..this. */
    maxStep: 24,
  },
  /** Development (M3, DESIGN §6): how traits become a body plan, and the repairs that keep every plan valid. All lengths are in core radii. */
  develop: {
    caps: {
      segments: 8,
      appendages: 24,
      joints: 4,
      branches: 2,
      colliders: 12,
      bounds: 2.5,
      pairs: 3,
    },
    /** Segments stay within this reach of the core; appendages within `caps.bounds` less `boundsSlack`. */
    segmentReach: 1.8,
    boundsSlack: 0.05,
    /** Each segment starts this share of its neighbours' radii from the previous one. */
    segmentSpacing: 0.8,
    /** The rearmost segment's radius is `1 - taper × this` of the core's. */
    taperDrop: 0.6,
    /** A segment's half-length is its radius × aspect ÷ this, within `stretch`. */
    aspectNeutral: 1.6,
    stretch: [0.6, 1.2],
    /** Appendage length, base width, taper and curvature at byte 0 and byte 255. */
    length: [0.1, 1.5],
    width: [0.04, 0.4],
    taper: [0, 0.9],
    curvature: [-1, 1],
    /** A branch is this fraction of its parent's length and width. */
    branchScale: 0.6,
    /** Attach angles stay this far from the heading and the tail (radians). */
    angleMargin: 0.2,
    /** Appendages on one segment and side keep at least this angle apart (radians). */
    minAngleGap: 0.3,
    /** The growth direction bends from the attach angle toward the tail by this share of the way. */
    sweep: 0.3,
    /** A part with a beat below this does not count as motile. */
    minBeat: 0.1,
    /** Motile area below this gets the default ciliary band. */
    minThrustArea: 0.06,
    band: {
      length: 0.4,
      width: 0.12,
      beat: 0.8,
      pairs: 2,
      tip: 0.9,
      taper: 0.3,
      joints: 2,
      stiffness: 0.3,
    },
    /** Slack for comparing angles and distances. */
    epsilon: 1e-9,
    /** A segment carrying plating below this has no plates; the plate thickness runs over this range with the plating. */
    plateMin: 0.05,
    plateThickness: [0.03, 0.2],
    /** Collider radius is the part's base width times this. */
    colliderWidth: 0.5,
    colliderAlong: 0.65,
    /** The mouth: radius = size × (this − type); the jaw half (type > 0.5) moves forward and narrows. */
    mouthRadiusBase: 1.5,
    /** Mouth types above this move the mouth forward and narrow it. */
    jawStart: 0.5,
    mouthReach: 1.2,
    mouthNarrow: 1.6,
    /** Development v2 (M6 T7, ADR 0025): the karyotype v2 shape loci. Each at 0 leaves the v1 body. */
    curve: {
      /**
       * The curve amount 0-1 turns the spine by amount × π (a C). A mode at or above `sMode` makes
       * an S instead: two opposite arcs that each turn `sArc` × amount × π, at most `sMax` × π, on
       * a chain of `sFrom` segments or more (M6b T6); a shorter chain's arcs turn amount × π ÷ 2.
       */
      sMode: 0.5,
      sArc: 1.25,
      sMax: 0.8,
      sFrom: 5,
      /**
       * Above `coilStart` the spine coils. A chain of `chain.slimFrom` segments or more turns from
       * `coilTurn[0]` × π just past the start to `coilTurn[1]` × π at 1, laid out as a chambered
       * spiral of `caps.segments` segments whatever its segment genes say (M6b T6, ADR 0038): each
       * link turns alike and is `whorl` ^ (its turn ÷ 2π) as long as the one before, so each whorl
       * is `whorl` the size of the one outside it; a chamber is `chamber` of its links long, and as
       * wide as the whorl inside it leaves room for. The coil reaches as far as a trunk, but is at
       * most `coiled` times as long as its straight trunk, so it still out-turns it (ADR 0038). A
       * shorter chain only curls by amount × π.
       */
      coilStart: 0.8,
      coilTurn: [2.5, 2.7],
      whorl: 0.38,
      chamber: 0.85,
      coiled: 1.4,
      /** Curved neighbours stay at most this share of their summed radii along the link apart. */
      overlap: 0.9,
      /** Segments that are not neighbours stay at least `gap` of their summed radii apart (M6b T6). */
      gap: 0.1,
      /**
       * A curled C or S chain fits the bounds along its curve (M6b T6): its links and segment
       * lengths grow by up to `longer` until its curled pose reaches as far as the straight chain
       * did, found to 2^−`steps` of the growth.
       */
      longer: 1.6,
      steps: 6,
    },
    tagmata: {
      /** The head is the unit, so head scale 1 shrinks every segment behind it by 1 ÷ (1 + this). */
      head: 0.8,
      /** Trunk swell 1 widens the chain by this share at `trunkAt` along it, falling to 0 at `trunkSpread` either side. */
      trunk: 0.6,
      trunkAt: 0.4,
      trunkSpread: 0.6,
      /** The tail is the rear `tailShare` of the chain: tail length 1 stretches its tip by `tailLength`, tail taper 1 narrows it by `tailTaper`. */
      tailShare: 0.5,
      tailLength: 0.8,
      tailTaper: 0.7,
    },
    fusion: {
      /** The carapace's thickness at plating 0 (it reaches the thickest plate at plating 1), and the flexibility lost by a fully fused body. */
      thickness: 0.08,
      stiffen: 0.8,
      /** Outline points per fused segment that the hull must contain. */
      samples: 16,
    },
    radial: {
      /** Symmetry at or above this rings the parts round the core at even angles; the body rounds with symmetry all along. */
      at: 0.5,
      maxPairs: 8,
      /** Drape 1 bends growth this share of the way to the tail (bilateral parts start from `sweep`, radial ones from 0). */
      drapeSweep: 0.9,
      /** A ring drapes only this share as far, so it trails as a ring: the front parts turn sideways, the rear ones back (M6 T14b). */
      ringDrape: 0.5,
    },
    eyes: {
      /** Eye size above `min` gives a pair on the head at ±`angle`; radius and stalk length in core radii. */
      min: 0.15,
      size: [0.08, 0.3],
      stalk: [0, 0.6],
      angle: 0.6,
      /**
       * A stalkless eye is set into the head (look pass 5, reference 05): this share of its
       * diameter lies inside the outline, less as the stalk grows, and a full stalk holds it out.
       * At 1 a stalkless eye lies wholly inside, so the head's rim runs round it (ADR 0037).
       */
      set: 1,
    },
    /**
     * The karyotype v2 chain (M6 T14b, ADR 0028). In front of a chain the head is `head` of the v1
     * head's size (v1's at head scale 1, and as symmetry rounds it); the core collider stays the
     * unit. The segments behind it are `width` core radii wide along the tagma profile, and the
     * chain fits `reach` by shortening its segments to as little as `squash` of their width before
     * it narrows, then narrows by 1 ÷ (1 + `tagmata.head` × head scale). A radial body's reach falls
     * over the radial range to the head's own half-length.
     */
    chain: {
      head: 0.65,
      width: 0.8,
      reach: 2.1,
      squash: 0.25,
      /**
       * Body proportions v3 (look pass 4, ADR 0031): a bilateral chain of `slimFrom` segments or
       * more is at least `aspect` times as long along its spine as its widest segment is wide. A
       * wider one narrows, every segment by one factor, so the head and trunk keep their profile.
       * The chain is measured laid straight: a curl is a pose and never changes the width.
       */
      aspect: 2.5,
      slimFrom: 3,
      /**
       * One body, widest at the trunk (M6b T5, ADR 0037), for a bilateral chain of `slimFrom`
       * segments or more. Along the chain behind the head (t from 0 at the head to 1 at the tail)
       * the profile rises by `rise` to its peak at `at`, where trunk swell adds to it, then drops
       * by `drop` plus the taper gene's share to the tail, and the tail loci narrow its rear. The
       * trunk is `width` core radii wide along it (head scale still narrows it) and fits a reach of
       * `reach`, and the segments shorten only by the square root of their narrowing, so a tail
       * stays long. The head
       * is `head` of the widest trunk segment's half-width and `headLength` of its stretch as long
       * (head scale and symmetry raise it). Behind a carapace of 2 or more segments the free tail
       * is at most `freeTail` of the widest fused segment. A worm (`worm.from` segments or more, no
       * carapace, a curve of `worm.curl` or more short of a coil) keeps only `even` of the profile's
       * swing and is `worm.aspect` times as long as wide.
       */
      trunk: {
        width: 0.88,
        reach: 2.2,
        at: 0.35,
        rise: 0.25,
        drop: 0.15,
        head: [0.6, 0.86],
        headLength: 0.7,
        freeTail: 0.45,
        even: 0.3,
        worm: { from: 5, curl: 0.35, aspect: 4.2 },
      },
    },
    /**
     * Long parts under karyotype v2 (look pass 4): the length gene keeps the v1 range up to `knee`
     * of its span, then reaches `max` core radii at its top, (share past the knee)² of the way. A
     * part keeps what of that reach fits the bounds whole, found to 2^−`steps` of it.
     */
    long: { knee: 0.8, max: 2.4, steps: 3 },
    /**
     * How parts fit the bounds under karyotype v2 (M6 T14b): a part that would leave them sweeps
     * toward the core, along the body, by at most `max` radians (the least sweep that fits, to
     * 2^−`sweeps` of it); a part that still leaves them is cut by the v1 rule.
     */
    fit: { max: 1.6, sweeps: 2 },
    /**
     * How a part is drawn, which the bounds follow (M6 T14b): its centre line is an arc that turns
     * `turn` × curvature (less with webbing, and never tighter than `fold` of its own half-width),
     * then a straight tip cap of (`capBlunt` + `capSharp` × tip) × its end half-width, at most
     * `capShare` of its length, which the length includes.
     */
    part: { turn: 1.2, fold: 0.8, capBlunt: 0.3, capSharp: 2.2, capShare: 0.3 },
    /**
     * Thin legs that keep off the body (M6b T7, ADR 0039), under karyotype v2. A part's base width
     * scales with its root segment: the width gene's range is narrowed so its top is `width` of
     * that segment's drawn half-width (the head's for a radial ring, its straight twin's for a
     * coil), but never below `floor` (or the gene, or that top): thin genes stay as they were,
     * and a hair-thin part would break into specks on screen. The ciliary band keeps its own. A
     * thinned paddle tip widens back toward its gene width
     * by its paddle share, from `blade[0]` of its length to `blade[1]` and on to the tip, at most
     * to `bladeMax` of its root's half-width. A bilateral part rooted inside a neighbouring segment
     * slides round its own segment, in steps of `slide` radians, to the nearest free angle, and a
     * radial ring spreads over the core's free arc in front of a trailing chain (found at
     * `arcSamples` angles, refined `arcSteps` halvings). A fitted part with more than `over` of its
     * centre line (sampled at `samples` points) inside the segments' outline turns outward
     * instead, in steps of `step` radians either way up to straight back, nearest first, and
     * shortens where the bounds then need it.
     */
    legs: {
      width: 0.5,
      floor: 0.08,
      over: 0.2,
      samples: 16,
      step: 0.2,
      slide: 0.05,
      arcSamples: 32,
      arcSteps: 4,
      blade: [0.3, 0.7],
      bladeMax: 2,
    },
    /** Fine parts (M6 T8, ADR 0025): detail on parts, never parts. Each at 0 leaves the v1 body. */
    detail: {
      /** A webbed part spans a sheet `webbing` of the way along its rays: to its branches, and to the next part rearward on its side (or, the rearmost, to its own mirror: a tail fan) when their roots lie at most `webSpan` apart. Pieces under `minArea` are dropped. */
      webSpan: 1.6,
      minArea: 1e-4,
      /** Density 0-1 gives 0-`perPart` bristles along a part, each setae length × width × `length` long; the body keeps at most `perBody`. */
      setae: { perPart: 24, perBody: 240, length: 6 },
      /** Bulb above `min` tips a part with a bead of radius bulb × width × `scale`, at most `room` of the free reach past the root. */
      bulb: { min: 0.3, scale: 2, room: 0.5 },
      /** Chela above `min` on a pointed or hooked tip (a weapon share above 0) makes the last joint opposable. */
      chela: { min: 0.5 },
    },
    /** Branches leave their part at `branchAt` of its length, fanned `branchFan` radians either way. */
    branchAt: 0.7,
    branchFan: 0.5,
  },
  /** Stats from form (M3, DESIGN §6): how a body plan becomes thrust, drag, turning, costs and combat numbers. */
  stats: {
    /**
     * Thrust efficiency of one motile part: `base` plus the whip share × (size ÷ `cross`)^−`exponent`
     * plus the paddle share × (size ÷ `cross`)^`exponent`. Whips win below `cross`, paddles above.
     */
    efficiency: { base: 0.25, cross: 16384, exponent: 0.25 },
    /** Tip shape (0 blunt, point, hook, paddle, 1 whip): the paddle peak, and how far the paddle and weapon shares reach either side. */
    paddleTip: 0.75,
    paddleSpread: 0.25,
    /** Pointed to hooked tips (peak between point and hook) make weapons. */
    weaponTip: 0.375,
    weaponSpread: 0.25,
    /** Thrust is × (floor + (1 − floor) × gait amplitude). */
    ampFloor: 0.7,
    /** Mass: plates (density per unit area) and spines (fraction of the body). */
    plateDensity: 4,
    spineMass: 0.1,
    /** Drag: body fineness term, rear taper relief, appendages, plates and spines. */
    finenessDrag: 0.6,
    taperRelief: 0.2,
    appendageDrag: 0.25,
    plateDrag: 0.3,
    spineDrag: 0.1,
    /** Turning: a rudder term and a flexibility term next to the differential thrust of the parts. */
    baseSteer: 1,
    flexSteer: 0.5,
    /** Basal multiplier terms (DESIGN §6). */
    basal: { segment: 0.1, appendage: 0.04, plating: 0.2, glow: 0.1 },
    /** Luminescence alleles to glow. */
    glow: { off: 0, pulse: 0.5, on: 1 },
    /**
     * The top-speed band (rules 7, ADR 0036): thrust ÷ drag, relative to the reference cell (1),
     * is eased into `min`–`max`, and the middle (`softLow`–`softHigh`) is left alone.
     */
    speedBand: { min: 0.6, max: 1.6, softLow: 1, softHigh: 1.1 },
    /** Combat: the bite of a full jaw (a weapon part's power is its tip share × stiffness × length). */
    bite: 0.5,
    /** Detection ring: each unit of slender, still, forward length adds this. */
    senseGain: 0.5,
    /** Development v2 (M6 T7, ADR 0025). */
    v2: {
      /** A radial ring thrusts forward at this × its rearward share ((1 − cos dir) ÷ 2), and its base steer is × (1 + `radialSteer`). */
      radialThrust: 0.4,
      radialSteer: 1.2,
      /** Each eye adds this × radius × (1 + stalk) to the detection ring and `eyeBasal` × radius to the basal multiplier. */
      eyeSense: 1.5,
      eyeBasal: 0.3,
      /**
       * Fine parts (M6 T8). A web on a beating part rows like a paddle, but a flapping sheet only
       * pushes at high Reynolds numbers: per unit of area it pushes `thrust` × (size ÷
       * `efficiency.cross`)^`exponent`, steeper than a paddle, and adds `drag`, `mass` and `basal`.
       */
      web: { thrust: 1, exponent: 0.5, drag: 0.5, mass: 0.5, basal: 0.2 },
      /**
       * Setae, by fringe (bristles × length, summed): `drag` each; up to `sense` on the detection
       * ring and up to `mouth` wider filter mouth at a fringe of `full`; `basal` per bristle.
       */
      setae: { drag: 0.004, sense: 1.15, mouth: 0.25, full: 30, basal: 0.002 },
      /** A bulb adds `spines` × radius to the spine share (capped at 1), its disc × `mass`, and `basal`. */
      bulb: { spines: 1.5, mass: 1, basal: 0.02 },
      /** A chela grips with `power` × chela × stiffness × its last joint's length, weighs `mass` × its area, costs `basal`. */
      chela: { power: 1.5, mass: 1, basal: 0.03 },
      /** Joint beads cost `basal` × beads per part. */
      beads: { basal: 0.01 },
    },
  },
  /** Life (M4, DESIGN §5, ADR 0019): lifespan, old age and maturity, on active time. */
  life: {
    /** Lifespan in ms of active time at lifespan trait 1 (75 min). */
    lifespanBaseMs: 4_500_000,
    /** Old age starts at this share of the lifespan. */
    elderAt: 0.85,
    /** An elder's thrust multiplier (top speed follows it) and basal metabolism multiplier. */
    elderThrust: 0.8,
    elderBasal: 1.2,
    /** Maturity needs active time of at least max(this, `matureMinShare` of the lifespan)... */
    matureMinMs: 420_000,
    matureMinShare: 0.1,
    /** ...and this share of the creature's maximum biomass. */
    matureBiomassShare: 0.6,
    /** Active time credited per report is at most the wall time plus this. */
    accrueSlackMs: 2000,
  },
  /** Mating (M5, DESIGN §5, ADR 0021). */
  mating: {
    /** Shares of current energy and biomass, paid at commitment. */
    costEnergy: 0.3,
    costBiomass: 0.15,
    /** Energy needed to mate, as a share of the maximum. */
    minEnergyShare: 0.5,
    /** Cooldown in active ms (9 min); doubles per earlier mating of the same pair in the window. */
    cooldownMs: 540_000,
    repeatWindowMs: 86_400_000,
    repeatMaxDoublings: 5,
    /** The accept is shown for 15 s; the authority takes it up to 20 s after the court. */
    acceptShownMs: 15_000,
    signWindowMs: 20_000,
    /** Size tiers apart, and body lengths apart (checked by clients only). */
    tierSpread: 1,
    reachBodies: 3,
    /** A hatchling has max(80, 10% of its maximum) biomass and 60% of its maximum energy. */
    hatchlingMinBiomass: 80,
    hatchlingShare: 0.1,
    hatchlingEnergyShare: 0.6,
    /** A checkpoint with less life left than this (2 min) is exhausted. */
    restoreMinMs: 120_000,
  },
  spawn: {
    /** Hatching looks for a plume-free spot on rings this far apart (wu). */
    searchStep: 50,
    /** A hatching cell keeps at least this far from any plume (wu). */
    plumeClearance: 120,
    /** Plumes drift, so a spot must stay clear for this long (10 s)... */
    lookaheadTicks: 300,
    /** ...checked this often (1 s; a plume moves a few wu per second). */
    lookaheadStride: 30,
  },
  /** Depth zones (M6 T15, DESIGN §2): the bathymetry field, the zone edges and what each zone does. */
  bathymetry: {
    /** Depth with no slope or noise: the middle of twilight. */
    base: 0.4,
    /** Octaves of value noise: wavelength in wu and weight. The first is the feature size. */
    octaves: [
      { wavelength: 2048, weight: 1 },
      { wavelength: 1024, weight: 0.5 },
      { wavelength: 512, weight: 0.25 },
    ],
    /** Depth swing of the noise, before the centre cap. */
    noiseAmplitude: 0.5,
    /** The share of the pond each zone gets before the centre cap: shallows, twilight, deep (abyss is the rest). */
    shares: { shallows: 0.27, twilight: 0.3, deep: 0.29 },
    /** The raw field is sampled on this many points per side to find those quantiles. */
    calibrationSamples: 48,
    /** Raw slope per wu towards the deep side of the pond. */
    tilt: 0.0001,
    /** Within this many wu of the centre the depth stays within `centreCap` of `base`: all twilight. */
    centreRadius: 1400,
    centreCap: 0.14,
    /** The cap opens by this much depth per wu beyond `centreRadius`. */
    capGrowth: 0.002,
    /** A zone ends where the depth reaches this value. */
    zones: { shallows: 0.25, twilight: 0.55, deep: 0.8 },
  },
  hazards: {
    plumeMinRadius: 60,
    plumeMaxRadius: 160,
    /** About one plume per this many food cells. */
    cellsPerPlume: 9,
    /** A plume drifts at this fraction of the local current. */
    driftFactor: 0.5,
    /** Vents, and so plumes, sit in the deep and the abyss at least this far (wu) from the spawn centre. */
    ventMinDistance: 1800,
    /** UV ramps in over this much depth below the shallows' edge (about 64 wu at the typical slope). */
    uvBand: 0.02,
    /** Pressure ramps in from this depth to the abyss' edge. */
    pressureStart: 0.7,
  },
  currents: {
    /** Maximum speed in wu/s. */
    maxSpeed: 12,
    /** Spatial period in wu. */
    spatialPeriod: 2048,
    /** Slow temporal change, in ticks (about 120 s). */
    timePeriodTicks: 3600,
  },
  controls: {
    /** Cursor within this many radii of the creature means coast. */
    deadZoneRadii: 0.5,
    /** Full throttle once the cursor is this many radii out; the ramp is linear in between. */
    fullThrottleRadii: 3,
  },
  camera: {
    /** Visible half-height = heightCoeff * R^heightExp * (r / R)^growExp wu, R the adult radius (DESIGN §3). */
    heightCoeff: 9,
    heightExp: 0.9,
    growExp: 0.6,
    /** Zoom smoothing time in seconds. */
    smoothSeconds: 1,
  },
});
