// Rules v1 (ADR 0005): every simulation number, with initial values from docs/DESIGN.md §2-§4.
// Changing a value that alters outcomes bumps RULES_VERSION and regenerates the goldens.

export const RULES_VERSION = 1;
export const TICK_HZ = 30;
export const DT = 1 / TICK_HZ;

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
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
    maxRate: 0.005,
    maxBiomass: 400,
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
    /** Bobbing drift stays within this many wu of the slot anchor. */
    driftRadius: 12,
    kinds: {
      detritus: { value: 8, radius: 1.5, weight: 70 },
      globule: { value: 25, radius: 3, weight: 25 },
      crystal: { value: 60, radius: 2.5, weight: 5 },
    },
  },
  hazards: {
    plumeMinRadius: 60,
    plumeMaxRadius: 160,
    /** About one plume per this many food cells. */
    cellsPerPlume: 9,
  },
  currents: {
    /** Maximum speed in wu/s. */
    maxSpeed: 12,
    /** Spatial period in wu. */
    spatialPeriod: 2048,
    /** Slow temporal change, in ticks (about 120 s). */
    timePeriodTicks: 3600,
  },
  camera: {
    /** Visible half-height = heightCoeff * r^heightExp wu. */
    heightCoeff: 9,
    heightExp: 0.9,
    /** Zoom smoothing time in seconds. */
    smoothSeconds: 1,
  },
});
