// Rules v6 (ADR 0005): every simulation number, with initial values from docs/DESIGN.md §2-§4.
// Changing a value that alters outcomes bumps RULES_VERSION and regenerates the goldens.

export const RULES_VERSION = 6;
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
      detritus: { value: 8, radius: 1.5, weight: 70 },
      globule: { value: 25, radius: 3, weight: 25 },
      crystal: { value: 60, radius: 2.5, weight: 5 },
    },
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
      /** The curve amount 0-1 turns the spine by amount × π; a mode at or above `sMode` splits it into two opposite arcs (S). */
      sMode: 0.5,
      /** Above this amount the spine coils: the turn grows to `coilTurn` × π at 1, bunches toward the tail (t^(1 + `coilBunch` × k)) and its links shrink by up to `coilShrink`. */
      coilStart: 0.8,
      coilTurn: 2.4,
      coilBunch: 1.5,
      coilShrink: 0.4,
      /** Curved neighbours stay at most this share of their summed radii along the link apart. */
      overlap: 0.9,
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
    },
    eyes: {
      /** Eye size above `min` gives a pair on the head at ±`angle`; radius and stalk length in core radii. */
      min: 0.15,
      size: [0.08, 0.3],
      stalk: [0, 0.6],
      angle: 0.6,
    },
    /** Mesh vertices per body ring and part ring, and rings per segment or joint, by detail. */
    vertices: {
      full: { cap: 6000, bodyRings: 9, bodyRing: 12, jointRings: 3, partRing: 8 },
      low: { cap: 1500, bodyRings: 5, bodyRing: 6, jointRings: 1, partRing: 4 },
    },
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
    /** Combat: the bite of a full jaw (a weapon part's power is its tip share × stiffness × length). */
    bite: 0.5,
    /** Detection ring: each unit of slender, still, forward length adds this. */
    senseGain: 0.5,
    /** Development v2 (M6 T7, ADR 0025). */
    v2: {
      /** A radial ring thrusts forward at this × its rearward share ((1 − cos dir) ÷ 2), and its base steer is × (1 + `radialSteer`). */
      radialThrust: 0.7,
      radialSteer: 0.6,
      /** Each eye adds this × radius × (1 + stalk) to the detection ring and `eyeBasal` × radius to the basal multiplier. */
      eyeSense: 1.5,
      eyeBasal: 0.3,
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
    matureMinMs: 720_000,
    matureMinShare: 0.2,
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
  hazards: {
    plumeMinRadius: 60,
    plumeMaxRadius: 160,
    /** About one plume per this many food cells. */
    cellsPerPlume: 9,
    /** A plume drifts at this fraction of the local current. */
    driftFactor: 0.5,
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
    /** Visible half-height = heightCoeff * r^heightExp wu. */
    heightCoeff: 9,
    heightExp: 0.9,
    /** Zoom smoothing time in seconds. */
    smoothSeconds: 1,
  },
});
