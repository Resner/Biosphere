// Stats from form (ADR 0006, DESIGN §6): a body plan and its traits become the numbers the rules
// use. Every number follows from geometry and material parameters through the formulas below;
// nothing reads a part's label or hard-codes a bonus for a named part. Multipliers are relative to
// the reference cell (`starterGenome`), so the reference reproduces `STARTER_PHYS`.

import type { Collider, PhysStats } from '../sim/body';
import { Hasher } from '../sim/hash';
import { atan2, clamp, length as hypot, PI, pow } from '../sim/math';
import { RULES } from '../sim/rules';
import type { Genome } from './codec';
import { genomeHash } from './codec';
import {
  type Appendage,
  type BodyPlan,
  branchWeight,
  develop,
  dirOf,
  extentOf,
  onAxis,
  type PlanMouth,
  type PlanSegment,
  peak,
  polygonArea,
  rootOf,
  weaponShare,
} from './develop';
import { express, type Traits } from './express';
import { starterGenome } from './starter';

const S = RULES.stats;
const D = RULES.develop;
const V2 = S.v2;

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

export interface Creature {
  hash: string;
  traits: Traits;
  plan: BodyPlan;
  stats: Stats;
  phys: PhysStats;
}

const segmentArea = (s: PlanSegment): number => PI * s.rx * s.ry;

/**
 * A segment as the water meets it: a chain slimmed to read long is laterally compressed (look pass
 * 4, ADR 0031), as deep as it was wide, so it weighs, drags and tapers as its girth does.
 */
const girthOf = (s: PlanSegment, slim: number): PlanSegment =>
  slim === 1 ? s : { ...s, ry: s.ry / slim };

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

interface Raw {
  force: number;
  mass: number;
  drag: number;
  inertia: number;
  steer: number;
  basal: number;
  growth: number;
}

/** Total bristle length over the body: what setae drag and sense with. */
const fringeOf = (plan: BodyPlan): number =>
  plan.appendages.reduce((sum, a) => sum + a.setae * a.setaeLength, 0);

/** The share of the setae effects a fringe gets: linear up to `full`, then whole. */
const setaeShare = (plan: BodyPlan): number => Math.min(1, fringeOf(plan) / V2.setae.full);

/** The opposable finger of a chela: its last joint's length. */
const fingerOf = (a: Appendage): number => (a.chela > 0 ? a.length / a.joints : 0);

/** The fine-part terms of the basal multiplier (M6 T8): each feature costs upkeep. */
function detailBasal(plan: BodyPlan, webArea: number): number {
  let parts = 0;
  for (const a of plan.appendages) {
    parts +=
      V2.setae.basal * a.setae +
      V2.bulb.basal * (a.bulb > 0 ? 1 : 0) +
      V2.chela.basal * a.chela +
      V2.beads.basal * a.beads;
  }
  return V2.web.basal * webArea + parts;
}

const glowOf = (traits: Traits): number =>
  (S.glow as Record<string, number | undefined>)[traits.colour.luminescence] ?? 0;

/** The unnormalised numbers; `statsAt` divides them by the reference cell's. */
function raw(plan: BodyPlan, traits: Traits, biomass: number): Raw {
  const efficiency = efficiencyAt(biomass);
  const amp = S.ampFloor + (1 - S.ampFloor) * traits.behaviour.gaitAmp;
  const radial = plan.form.radial === 1;
  let force = 0;
  let steer = S.baseSteer + S.flexSteer * plan.flexibility;
  let appendageArea = 0;
  let appendageDrag = 0;
  let appendageInertia = 0;
  let detailMass = 0;
  // Each instance's distance from the core; a mirror pair on an unturned axis segment shares it.
  const arms: number[] = [];
  plan.appendages.forEach((a, i) => {
    const s = plan.segments[a.segment] as PlanSegment;
    const twin = i % 2 === 1 && onAxis(s) ? arms[i - 1] : undefined;
    if (twin !== undefined) arms.push(twin);
    else {
      const root = rootOf(s, a.angle, a.side);
      arms.push(hypot(root.x, root.y));
    }
  });
  plan.appendages.forEach((a, i) => {
    // A part thinned to fit its segment is drawn edge-on: the water meets its girth (M6b T7).
    const area = a.length * a.girth * branchWeight(a);
    const arm = arms[i] as number;
    if (a.beat >= D.minBeat) {
      const f = area * a.beat * efficiency(a.tip) * traits.defects.beatStrength * amp;
      if (radial) {
        // A ring pushes along its parts: only the rearward share drives it forward, the rest turns it.
        const share = (1 - dirOf(plan.segments[a.segment] as PlanSegment, a).x) / 2;
        force += f * V2.radialThrust * share;
      } else {
        force += f;
      }
      steer += f * arm;
    }
    appendageArea += area;
    appendageDrag += a.girth * (1 + a.length) * (1 + a.branches * D.branchScale);
    appendageInertia += area * (arm * arm + (a.length * a.length) / 3);
    // A bulb and a chela's finger weigh at the part's reach.
    const extra = V2.bulb.mass * PI * a.bulb * a.bulb + V2.chela.mass * fingerOf(a) * a.girth;
    detailMass += extra;
    appendageInertia += extra * (arm + a.length) * (arm + a.length);
  });

  // Membranes row on a beating part, more and more as the body grows, and weigh and drag.
  const sheet = V2.web.thrust * pow(biomass / S.efficiency.cross, V2.web.exponent);
  let webArea = 0;
  for (const m of plan.membranes) {
    const a = plan.appendages[m.part] as Appendage;
    const s = plan.segments[a.segment] as PlanSegment;
    const area = polygonArea(m.points);
    const centre = m.points.reduce((c, p) => ({ x: c.x + p.x, y: c.y + p.y }), { x: 0, y: 0 });
    const [cx, cy] = [centre.x / m.points.length, centre.y / m.points.length];
    webArea += area;
    appendageInertia += V2.web.mass * area * (cx * cx + cy * cy);
    if (a.beat < D.minBeat) continue;
    const f = area * a.beat * sheet * traits.defects.beatStrength * amp;
    force += radial ? f * V2.radialThrust * ((1 - dirOf(s, a).x) / 2) : f;
    steer += f * (arms[m.part] as number);
  }

  let bodyArea = 0;
  let inertia = 0;
  // The core collider is the unit body: a head drawn narrower than it in front of a chain
  // (ADR 0028) still meets the water at the core's width.
  let width = 1;
  let front = 0;
  let rear = 0;
  type Ellipse = { rx: number; ry: number; angle: number };
  /** Widens the body to `across` (its girth, when slimmed) and lengthens it to `along` (as drawn). */
  const outline = (x: number, y: number, across: Ellipse, along = across): void => {
    width = Math.max(width, Math.abs(y) + extentOf(across).y);
    const ext = extentOf(along).x;
    front = Math.max(front, x + ext);
    rear = Math.min(rear, x - ext);
  };
  for (const drawn of plan.segments) {
    const s = girthOf(drawn, plan.form.slim);
    const m = segmentArea(s);
    bodyArea += m;
    inertia += m * (s.x * s.x + s.y * s.y + (s.rx * s.rx + s.ry * s.ry) / 4);
    // A compressed segment is deep across the flow; turned along it, it is as long as drawn.
    outline(s.x, s.y, s, drawn);
  }
  let plateArea = 0;
  for (const p of plan.plates) {
    const s = girthOf(plan.segments[p.segment] as PlanSegment, plan.form.slim);
    const m = p.coverage * p.thickness * PI * (s.rx + s.ry);
    plateArea += m;
    inertia += S.plateDensity * m * (s.x * s.x + s.y * s.y + (s.rx * s.rx + s.ry * s.ry) / 2);
  }
  const c = plan.carapace;
  if (c.count > 0) {
    // The shell weighs like a plate over its outline and widens the body to its own.
    const m = c.thickness * PI * (c.rx + c.ry);
    plateArea += m;
    inertia += S.plateDensity * m * (c.x * c.x + c.y * c.y + (c.rx * c.rx + c.ry * c.ry) / 2);
    outline(c.x, c.y, c);
  }
  const e = plan.eyes;
  const eyeArea = e.count * PI * e.size * e.size;
  inertia += eyeArea * (e.x * e.x + e.y * e.y);
  const spines = traits.skin.spines;
  const mass =
    bodyArea * (1 + S.spineMass * spines) +
    appendageArea +
    S.plateDensity * plateArea +
    eyeArea +
    V2.web.mass * webArea +
    detailMass;
  inertia += appendageInertia;

  const last = plan.segments[plan.segments.length - 1] as PlanSegment;
  const taper = width > 0 ? Math.max(0, 1 - girthOf(last, plan.form.slim).ry / width) : 0;
  const fineness = (front - rear) / (2 * width);
  const drag =
    2 * width * (1 + S.finenessDrag / fineness) * (1 - S.taperRelief * taper) +
    S.appendageDrag * appendageDrag +
    S.plateDrag * plateArea +
    S.spineDrag * spines * 2 * width +
    V2.web.drag * webArea +
    V2.setae.drag * fringeOf(plan);

  // A ring rows in any direction, so all of its steering is stronger.
  if (radial) steer *= 1 + V2.radialSteer;

  const b = S.basal;
  const basal =
    (1 +
      b.segment * (plan.segments.length - 1) +
      b.appendage * plan.appendages.length +
      b.plating * traits.skin.plating +
      b.glow * glowOf(traits) +
      V2.eyeBasal * e.count * e.size +
      detailBasal(plan, webArea)) *
    traits.physiology.metabolism *
    traits.defects.metabolismCost;
  return { force, mass, drag, inertia, steer, basal, growth: traits.physiology.growth };
}

/** The reference cell's numbers, which every multiplier is divided by. */
const REFERENCE: Raw = (() => {
  const traits = express(starterGenome());
  return raw(develop(traits), traits, traits.body.maxBiomass);
})();

/**
 * A strictly increasing soft clamp of a top-speed multiplier (thrust ÷ drag) into [`min`, `max`] (ADR 0036): the middle
 * (`softLow`–`softHigh`) passes unchanged, and beyond it the ratio eases toward the limit like
 * d·w ÷ (d + w), so a faster form stays faster, only by less. Rational, so no transcendentals.
 */
export function bandSpeed(ratio: number): number {
  const B = S.speedBand;
  // d·w ÷ (d + w): d is the distance past the middle, w the room left before the limit.
  const soft = (d: number, w: number): number => (d * w) / (d + w);
  if (!(ratio > B.softLow)) {
    // NaN and anything below zero count as 0.
    return B.softLow - soft(B.softLow - (ratio > 0 ? ratio : 0), B.softLow - B.min);
  }
  if (ratio === Number.POSITIVE_INFINITY) return B.max;
  return ratio > B.softHigh ? B.softHigh + soft(ratio - B.softHigh, B.max - B.softHigh) : ratio;
}

/** The top-speed multiplier (thrust ÷ drag, the reference cell is 1) that form alone gives, before the band. */
export function formSpeed(plan: BodyPlan, traits: Traits, biomass: number): number {
  return speedRatio(raw(plan, traits, biomass));
}

const speedRatio = (r: Raw): number =>
  r.force / REFERENCE.force / (r.mass / REFERENCE.mass) / (r.drag / REFERENCE.drag);

/** The weapon numbers: pointed and hooked tips × stiffness × length, a chela's grip, the bite of a jaw, and bulbs as spines. */
function combatOf(plan: BodyPlan, traits: Traits): Stats['combat'] {
  let power = 0;
  let reach = 1;
  let arc = 0;
  for (const a of plan.appendages) {
    const w = weaponShare(a.tip);
    if (w <= 0) continue;
    const s = plan.segments[a.segment] as PlanSegment;
    const root = rootOf(s, a.angle, a.side);
    const dir = dirOf(s, a);
    power += w * a.stiffness * a.length + V2.chela.power * a.chela * a.stiffness * fingerOf(a);
    reach = Math.max(reach, hypot(root.x + a.length * dir.x, root.y + a.length * dir.y));
    arc = Math.max(arc, s.angle === 0 ? a.dir : Math.abs(atan2(dir.y, dir.x)));
  }
  const jaw = Math.max(0, (traits.mouth.type - D.jawStart) / (1 - D.jawStart));
  if (jaw > 0) {
    power += S.bite * jaw * traits.mouth.size;
    reach = Math.max(reach, plan.mouth.offset + plan.mouth.radius);
    arc = Math.max(arc, plan.mouth.arc);
  }

  let bulbs = 0;
  for (const a of plan.appendages) bulbs += a.bulb;

  let area = 0;
  for (const s of plan.segments) area += segmentArea(s);
  let covered = 0;
  for (const p of plan.plates) {
    covered += segmentArea(plan.segments[p.segment] as PlanSegment) * p.coverage * p.thickness;
  }
  // The carapace covers its fused segments whole.
  const c = plan.carapace;
  for (let i = 0; i < c.count; i++) {
    covered += segmentArea(plan.segments[i] as PlanSegment) * c.thickness;
  }
  return {
    reach,
    arc,
    power,
    armour: area > 0 ? covered / area / (D.plateThickness[1] as number) : 0,
    spines:
      bulbs > 0 ? Math.min(1, traits.skin.spines + V2.bulb.spines * bulbs) : traits.skin.spines,
  };
}

/** Setae widen a filter mouth (the filter share of its type) by up to `RULES.stats.v2.setae.mouth`. */
function mouthOf(plan: BodyPlan): PlanMouth {
  const m = plan.mouth;
  const filter = Math.max(0, 1 - m.type / D.jawStart);
  const share = setaeShare(plan);
  if (!(share > 0 && filter > 0)) return m;
  const radius = m.radius * (1 + V2.setae.mouth * share * filter);
  return { ...m, radius: Math.min(radius, RULES.body.maxMouthRadius) };
}

/** Slender, still, forward-pointing stalks, eyes and setae extend the detection ring. */
function senseOf(plan: BodyPlan): number {
  let reach = 0;
  for (const a of plan.appendages) {
    const forward = Math.max(0, 1 - a.angle / (PI / 2));
    const slender = clamp(1 - a.girth / (D.width[1] as number), 0, 1);
    reach += a.length * forward * slender * (1 - a.beat);
  }
  const e = plan.eyes;
  return (
    1 +
    S.senseGain * reach +
    V2.eyeSense * e.count * e.size * (1 + e.stalk) +
    V2.setae.sense * setaeShare(plan)
  );
}

/** The stats of a body at a given biomass (thrust efficiency depends on size). */
export function statsAt(plan: BodyPlan, traits: Traits, biomass: number): Stats {
  const r = raw(plan, traits, biomass);
  const ref = REFERENCE;
  const mass = r.mass / ref.mass;
  const drag = r.drag / ref.drag;
  // Rules 7 (ADR 0036): form sets the top speed only within a band around the reference cell's.
  const thrust = drag * bandSpeed(speedRatio(r));
  return {
    maxBiomass: traits.body.maxBiomass,
    thrust,
    drag,
    turn: r.steer / r.inertia / (ref.steer / ref.inertia),
    basal: r.basal / ref.basal,
    growth: r.growth / ref.growth,
    mass,
    mouth: mouthOf(plan),
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

/** What the sim sees (ADR 0018): multipliers clamped to the body limits, and the mouth and colliders as built. */
export function physOf(stats: Stats): PhysStats {
  const b = RULES.body;
  const mult = (v: number): number => clamp(v, b.multiplierMin, b.multiplierMax);
  return {
    maxBiomass: clamp(stats.maxBiomass, b.maxBiomassFloor, b.maxBiomassCeiling),
    thrust: mult(stats.thrust),
    drag: mult(stats.drag),
    turn: mult(stats.turn),
    basal: mult(stats.basal),
    growth: mult(stats.growth),
    uvTolerance: clamp(stats.physiology.uvTolerance, 0, 1),
    pressureTolerance: clamp(stats.physiology.pressureTolerance, 0, 1),
    mouth: { ...stats.mouth },
    colliders: stats.colliders.map((c) => ({ ...c })),
  };
}

export function buildCreature(g: Genome): Creature {
  const traits = express(g);
  const plan = develop(traits);
  const stats = computeStats(plan, traits);
  return { hash: genomeHash(g), traits, plan, stats, phys: physOf(stats) };
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
