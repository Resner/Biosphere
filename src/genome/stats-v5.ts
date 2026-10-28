// Stats from form under rules versions 3 to 5 (M3 T6, ADR 0006, DESIGN §6). Frozen (ADR 0025): the
// v1 body's numbers as rules v5 measured them, the stats numbers included (copied from rules v5
// below), kept to verify history and to pin the v1 equivalence of development v2 (M6 T7).
// Multipliers are relative to the reference cell (`starterGenome`).

import type { Collider } from '../sim/body';
import { Hasher } from '../sim/hash';
import { clamp, cos, length as hypot, PI, pow, sin } from '../sim/math';
import {
  type BodyPlan,
  branchWeight,
  type PlanMouth,
  type PlanSegment,
  rootOf,
} from './develop-v5';
import type { Traits } from './express';

/** `RULES.stats` as rules v5 had it. */
const S = {
  efficiency: { base: 0.25, cross: 16384, exponent: 0.25 },
  paddleTip: 0.75,
  paddleSpread: 0.25,
  weaponTip: 0.375,
  weaponSpread: 0.25,
  ampFloor: 0.7,
  plateDensity: 4,
  spineMass: 0.1,
  finenessDrag: 0.6,
  taperRelief: 0.2,
  appendageDrag: 0.25,
  plateDrag: 0.3,
  spineDrag: 0.1,
  baseSteer: 1,
  flexSteer: 0.5,
  basal: { segment: 0.1, appendage: 0.04, plating: 0.2, glow: 0.1 },
  glow: { off: 0, pulse: 0.5, on: 1 },
  bite: 0.5,
  senseGain: 0.5,
} as const;

/** The `RULES.develop` numbers the v5 stats read. */
const D = {
  branchScale: 0.6,
  minBeat: 0.1,
  width: [0.04, 0.4],
  jawStart: 0.5,
  plateThickness: [0.03, 0.2],
} as const;

export interface Stats {
  maxBiomass: number;
  /** Multipliers relative to the reference cell. */
  thrust: number;
  drag: number;
  turn: number;
  basal: number;
  growth: number;
  /** Mass relative to the reference cell. */
  mass: number;
  mouth: PlanMouth;
  colliders: Collider[];
  combat: {
    /** Core radii from the centre; 1 (the core) without a weapon. */
    reach: number;
    /** Half-angle round the heading that the weapons cover; 0 without one. */
    arc: number;
    power: number;
    /** 0-1: plate coverage × thickness against the thickest plate. */
    armour: number;
    spines: number;
  };
  /** The detection ring in core radii; 1 is the cell itself. */
  sense: number;
  /** 0 dark, 1 full glow. */
  glow: number;
  /** Membrane strength 0-1, after a membrane load. */
  integrity: number;
  /** Kept for lifespan (M4) and depth zones (M6). */
  physiology: { lifespan: number; uvTolerance: number; pressureTolerance: number };
}

/** 1 at `centre`, falling linearly to 0 at `spread` either side. */
const peak = (x: number, centre: number, spread: number): number =>
  clamp(1 - Math.abs(x - centre) / spread, 0, 1);

const segmentArea = (s: PlanSegment): number => PI * s.rx * s.ry;

/** Thrust efficiency of each tip at one body size: whips fall with size, paddles rise. */
function efficiencyAt(biomass: number): (tip: number) => number {
  const e = S.efficiency;
  const scale = biomass / e.cross;
  const down = pow(scale, -e.exponent);
  const up = pow(scale, e.exponent);
  return (tip) => {
    const whip = clamp((tip - S.paddleTip) / (1 - S.paddleTip), 0, 1);
    return e.base + whip * down + peak(tip, S.paddleTip, S.paddleSpread) * up;
  };
}

const weaponShare = (tip: number): number => peak(tip, S.weaponTip, S.weaponSpread);

interface Raw {
  force: number;
  mass: number;
  drag: number;
  inertia: number;
  steer: number;
  basal: number;
  growth: number;
}

const glowOf = (traits: Traits): number =>
  (S.glow as Record<string, number | undefined>)[traits.colour.luminescence] ?? 0;

/** The unnormalised numbers; `statsAt` divides them by the reference cell's. */
function raw(plan: BodyPlan, traits: Traits, biomass: number): Raw {
  const efficiency = efficiencyAt(biomass);
  const amp = S.ampFloor + (1 - S.ampFloor) * traits.behaviour.gaitAmp;
  let force = 0;
  let steer = S.baseSteer + S.flexSteer * plan.flexibility;
  let appendageArea = 0;
  let appendageDrag = 0;
  let appendageInertia = 0;
  for (const a of plan.appendages) {
    const area = a.length * a.width * branchWeight(a);
    const root = rootOf(plan.segments[a.segment] as PlanSegment, a.angle);
    const arm = hypot(root.x, root.y);
    if (a.beat >= D.minBeat) {
      const f = area * a.beat * efficiency(a.tip) * traits.defects.beatStrength * amp;
      force += f;
      steer += f * arm;
    }
    appendageArea += area;
    appendageDrag += a.width * (1 + a.length) * (1 + a.branches * D.branchScale);
    appendageInertia += area * (arm * arm + (a.length * a.length) / 3);
  }

  let bodyArea = 0;
  let inertia = 0;
  let width = 0;
  let front = 0;
  let rear = 0;
  for (const s of plan.segments) {
    const m = segmentArea(s);
    bodyArea += m;
    inertia += m * (s.x * s.x + (s.rx * s.rx + s.ry * s.ry) / 4);
    width = Math.max(width, s.ry);
    front = Math.max(front, s.x + s.rx);
    rear = Math.min(rear, s.x - s.rx);
  }
  let plateArea = 0;
  for (const p of plan.plates) {
    const s = plan.segments[p.segment] as PlanSegment;
    const m = p.coverage * p.thickness * PI * (s.rx + s.ry);
    plateArea += m;
    inertia += S.plateDensity * m * (s.x * s.x + (s.rx * s.rx + s.ry * s.ry) / 2);
  }
  const spines = traits.skin.spines;
  const mass = bodyArea * (1 + S.spineMass * spines) + appendageArea + S.plateDensity * plateArea;
  inertia += appendageInertia;

  const last = plan.segments[plan.segments.length - 1] as PlanSegment;
  const taper = width > 0 ? 1 - last.ry / width : 0;
  const fineness = (front - rear) / (2 * width);
  const drag =
    2 * width * (1 + S.finenessDrag / fineness) * (1 - S.taperRelief * taper) +
    S.appendageDrag * appendageDrag +
    S.plateDrag * plateArea +
    S.spineDrag * spines * 2 * width;

  const b = S.basal;
  const basal =
    (1 +
      b.segment * (plan.segments.length - 1) +
      b.appendage * plan.appendages.length +
      b.plating * traits.skin.plating +
      b.glow * glowOf(traits)) *
    traits.physiology.metabolism *
    traits.defects.metabolismCost;
  return { force, mass, drag, inertia, steer, basal, growth: traits.physiology.growth };
}

/** The reference cell's numbers under rules v5 (`starterGenome`), which every multiplier is divided by. */
const REFERENCE: Raw = {
  force: 0.15801398210971665,
  mass: 3.2513097326106717,
  drag: 3.257658583820313,
  inertia: 1.7007225094230176,
  steer: 1.15826061853791,
  basal: 0.756,
  growth: 0.7,
};

/** The weapon numbers: pointed and hooked tips × stiffness × length, plus the bite of a jaw. */
function combatOf(plan: BodyPlan, traits: Traits): Stats['combat'] {
  let power = 0;
  let reach = 1;
  let arc = 0;
  for (const a of plan.appendages) {
    const w = weaponShare(a.tip);
    if (w <= 0) continue;
    const root = rootOf(plan.segments[a.segment] as PlanSegment, a.angle);
    power += w * a.stiffness * a.length;
    reach = Math.max(reach, hypot(root.x + a.length * cos(a.dir), root.y + a.length * sin(a.dir)));
    arc = Math.max(arc, a.dir);
  }
  const jaw = Math.max(0, (traits.mouth.type - D.jawStart) / (1 - D.jawStart));
  if (jaw > 0) {
    power += S.bite * jaw * traits.mouth.size;
    reach = Math.max(reach, plan.mouth.offset + plan.mouth.radius);
    arc = Math.max(arc, plan.mouth.arc);
  }

  let area = 0;
  for (const s of plan.segments) area += segmentArea(s);
  let covered = 0;
  for (const p of plan.plates) {
    covered += segmentArea(plan.segments[p.segment] as PlanSegment) * p.coverage * p.thickness;
  }
  return {
    reach,
    arc,
    power,
    armour: area > 0 ? covered / area / (D.plateThickness[1] as number) : 0,
    spines: traits.skin.spines,
  };
}

/** Slender, still, forward-pointing stalks extend the detection ring. */
function senseOf(plan: BodyPlan): number {
  let reach = 0;
  for (const a of plan.appendages) {
    const forward = Math.max(0, 1 - a.angle / (PI / 2));
    const slender = clamp(1 - a.width / (D.width[1] as number), 0, 1);
    reach += a.length * forward * slender * (1 - a.beat);
  }
  return 1 + S.senseGain * reach;
}

/** The stats of a body at a given biomass (thrust efficiency depends on size). */
export function statsAt(plan: BodyPlan, traits: Traits, biomass: number): Stats {
  const r = raw(plan, traits, biomass);
  const ref = REFERENCE;
  const mass = r.mass / ref.mass;
  return {
    maxBiomass: traits.body.maxBiomass,
    thrust: r.force / ref.force / mass,
    drag: r.drag / ref.drag,
    turn: r.steer / r.inertia / (ref.steer / ref.inertia),
    basal: r.basal / ref.basal,
    growth: r.growth / ref.growth,
    mass,
    mouth: plan.mouth,
    colliders: plan.colliders,
    combat: combatOf(plan, traits),
    sense: senseOf(plan),
    glow: glowOf(traits),
    integrity: traits.skin.membrane * traits.defects.membraneIntegrity,
    physiology: {
      lifespan: traits.physiology.lifespan,
      uvTolerance: traits.physiology.uvTolerance,
      pressureTolerance: traits.physiology.pressureTolerance,
    },
  };
}

/** The adult stats: at the genome's maximum biomass. */
export function computeStats(plan: BodyPlan, traits: Traits): Stats {
  return statsAt(plan, traits, traits.body.maxBiomass);
}

/** A 64-bit hash of every number in the stats, in a fixed order. */
export function hashStats(s: Stats): string {
  const h = new Hasher();
  const f = (...values: number[]): void => {
    for (const v of values) h.f64(v);
  };
  f(s.maxBiomass, s.thrust, s.drag, s.turn, s.basal, s.growth, s.mass);
  f(s.mouth.offset, s.mouth.radius, s.mouth.arc, s.mouth.type, s.mouth.digestion);
  f(s.colliders.length);
  for (const c of s.colliders) f(c.x, c.y, c.r);
  const c = s.combat;
  f(c.reach, c.arc, c.power, c.armour, c.spines, s.sense, s.glow, s.integrity);
  f(s.physiology.lifespan, s.physiology.uvTolerance, s.physiology.pressureTolerance);
  return h.digest();
}
