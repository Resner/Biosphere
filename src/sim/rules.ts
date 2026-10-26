// Rules v3 (ADR 0005): every simulation number, with initial values from docs/DESIGN.md §2-§4.
// Changing a value that alters outcomes bumps RULES_VERSION and regenerates the goldens.

export const RULES_VERSION = 3;
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
    },
    /** A homozygous loss of function (L1-L4) sets its defect factor to this; heterozygotes are unaffected. */
    lof: { membraneIntegrity: 0.6, partScale: 0.6, beatStrength: 0.7, metabolismCost: 1.3 },
  },
  /** Development (M3, DESIGN §6): how traits become a body plan, and the repairs that keep every plan valid. All lengths are in core radii. */
  develop: {
    caps: { segments: 8, appendages: 24, joints: 4, branches: 2, colliders: 12, bounds: 2.5 },
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
    colliderMaxRadius: 0.5,
    /** The mouth: radius = size × (this − type); the jaw half (type > 0.5) moves forward and narrows. */
    mouthRadiusBase: 1.5,
    mouthReach: 1.2,
    mouthNarrow: 1.6,
    /** Mesh vertices per body ring and part ring, and rings per segment or joint, by detail. */
    vertices: {
      full: { cap: 6000, bodyRings: 9, bodyRing: 12, jointRings: 3, partRing: 8 },
      low: { cap: 1500, bodyRings: 5, bodyRing: 6, jointRings: 1, partRing: 4 },
    },
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
