// Development, check stage: moved verbatim out of develop.ts (ADR 0045).

import { Hasher } from '../sim/hash';
import { length as hypot, PI } from '../sim/math';
import { RULES } from '../sim/rules';
import { apart, farEdge } from './develop-chain';
import { polygonArea, turnAt } from './develop-detail';
import { ringAngle } from './develop-fit';
import { bristleAt, motileArea } from './develop-organize';
import { isWeaponTip, partReach } from './develop-parts';
import {
  type Appendage,
  type BodyPlan,
  branchFactor,
  D,
  dirOf,
  EYE_SIZE,
  type PlanSegment,
  type Point,
  radiusAlong,
  rootOf,
  X,
} from './develop-plan';

/** The furthest any part of the plan can reach from the core centre. */
export function planBounds(plan: BodyPlan): number {
  let bound = farEdge(plan.segments);
  for (const a of plan.appendages) {
    const s = plan.segments[a.segment];
    if (s === undefined) return Number.POSITIVE_INFINITY;
    // Root plus length bounds the drawn part from above; the exact reach only matters past it.
    const root = rootOf(s, a.angle, a.side);
    if (hypot(root.x, root.y) + a.length * branchFactor(a.branches) + a.bulb > bound) {
      bound = Math.max(bound, partReach(s, a, a.side));
    }
    if (a.setae > 0) {
      const dir = dirOf(s, a);
      for (const t of [bristleAt(0, a.setae), bristleAt(a.setae - 1, a.setae)]) {
        const p = { x: root.x + t * a.length * dir.x, y: root.y + t * a.length * dir.y };
        bound = Math.max(bound, hypot(p.x, p.y) + a.setaeLength);
      }
    }
  }
  for (const m of plan.membranes) {
    for (const p of m.points) bound = Math.max(bound, hypot(p.x, p.y));
  }
  const c = plan.carapace;
  if (c.count > 0) bound = Math.max(bound, hypot(c.x, c.y) + Math.max(c.rx, c.ry));
  const e = plan.eyes;
  if (e.count > 0) bound = Math.max(bound, hypot(e.x, e.y) + e.size);
  return bound;
}

/** The v2 checks: curved neighbours overlap and the rest keep apart, the carapace, the eyes and a radial ring. */
function shapeViolations(plan: BodyPlan): string[] {
  const bad: string[] = [];
  const n = plan.segments.length;
  for (const s of plan.segments) {
    if (!(s.rx > 0) || !(s.ry > 0)) bad.push('segment with no length or width');
  }
  for (let i = 1; i < n; i++) {
    const [p, s] = [plan.segments[i - 1], plan.segments[i]] as [PlanSegment, PlanSegment];
    const d = hypot(s.x - p.x, s.y - p.y);
    if (d === 0) continue;
    const [dx, dy] = [(s.x - p.x) / d, (s.y - p.y) / d];
    if (d >= radiusAlong(p, dx, dy) + radiusAlong(s, -dx, -dy)) {
      bad.push(`segments ${i - 1} and ${i} do not overlap`);
    }
  }
  // No self-overlap (M6b T6): a curled chain keeps clear of itself. A radial body's chain lies
  // folded inside its round core, and a straight one never folds (the v1 layout nests its
  // segments behind the big head), so curled bilateral chains are checked.
  if (plan.form.radial === 0 && plan.form.turn !== 0) {
    for (let i = 0; i < n; i++) {
      for (let j = i + 2; j < n; j++) {
        if (!apart(plan.segments[i] as PlanSegment, plan.segments[j] as PlanSegment)) {
          bad.push(`segments ${i} and ${j} overlap`);
        }
      }
    }
  }
  const c = plan.carapace;
  if (c.count < 0 || c.count > n || c.count !== Math.floor(c.count)) {
    bad.push(`carapace: ${c.count} fused segments of ${n}`);
  } else if (c.count > 0 && (!(c.rx > 0) || !(c.ry > 0) || !(c.thickness > 0))) {
    bad.push('carapace with no size or thickness');
  }
  for (const p of plan.plates) {
    if (p.segment < c.count) bad.push(`plate under the carapace on segment ${p.segment}`);
  }
  const e = plan.eyes;
  if (e.count !== 0 && e.count !== 2) bad.push(`eyes: ${e.count} is not 0 or 2`);
  if (e.count > 0 && !(e.size >= EYE_SIZE[0] && e.size <= EYE_SIZE[1] && e.stalk >= 0)) {
    bad.push(`eyes: radius ${e.size} or stalk ${e.stalk} is outside the limits`);
  }
  if (plan.form.radial !== 0 && plan.form.radial !== 1) bad.push('form: radial is not 0 or 1');
  if (!(plan.form.slim > 0 && plan.form.slim <= 1)) bad.push('form: slim is outside (0, 1]');
  if (plan.form.radial === 1) {
    const left = plan.appendages.filter((a) => a.side === 1);
    if (left.length > D.radial.maxPairs) bad.push(`radial ring: ${left.length} pairs`);
    left.forEach((a, k) => {
      if (a.segment !== 0 || Math.abs(a.angle - ringAngle(k, left.length)) > D.epsilon) {
        bad.push('radial ring: parts are not evenly spaced round the core');
      }
    });
    if (plan.mouth.offset !== 0) bad.push('radial body: the mouth is not central');
  }
  bad.push(...detailViolations(plan));
  return bad.length < 2 ? bad : [...new Set(bad)];
}

const inUnit = (v: number): boolean => v >= 0 && v <= 1;

/** The fine-part checks (M6 T8): detail ranges, setae counts, chelae on weapon tips, sound membranes. */
function detailViolations(plan: BodyPlan): string[] {
  const bad: string[] = [];
  const S = X.setae;
  let setae = 0;
  for (const a of plan.appendages) {
    setae += a.setae;
    if (!inUnit(a.webbing) || !inUnit(a.beads) || !(a.bulb >= 0) || !(a.setaeLength >= 0)) {
      bad.push('appendage detail out of range');
    }
    if (a.setae < 0 || a.setae > S.perPart || a.setae !== Math.floor(a.setae)) {
      bad.push(`setae: ${a.setae} on a part is outside 0-${S.perPart}`);
    }
    if (a.setae > 0 && !(a.setaeLength > 0)) bad.push('setae with no length');
    if (a.chela !== 0 && !(a.chela > X.chela.min && a.chela <= 1 && isWeaponTip(a.tip))) {
      bad.push('chela on a tip that is not pointed or hooked');
    }
  }
  if (setae > S.perBody) bad.push(`setae: ${setae} on the body is more than ${S.perBody}`);
  const n = plan.appendages.length;
  const owns = (k: number): boolean => k >= 0 && k < n && k === Math.floor(k);
  plan.membranes.forEach((m, i) => {
    if (!owns(m.part) || !owns(m.to) || !((plan.appendages[m.part] as Appendage).webbing > 0)) {
      bad.push(`membrane ${i}: no webbed part ${m.part} or ${m.to}`);
    }
    const ps = m.points;
    if (ps.length < 3 || !(polygonArea(ps) >= X.minArea)) bad.push(`membrane ${i} is degenerate`);
    else if (
      ps.some(
        (p, k) =>
          turnAt(p, ps[(k + 1) % ps.length] as Point, ps[(k + 2) % ps.length] as Point) < -1e-12,
      )
    ) {
      bad.push(`membrane ${i} is not convex`);
    }
  });
  return bad;
}

/** Every ADR 0006 and ADR 0025 cap and guarantee a plan must hold; an empty list means the plan is valid. */
export function bodyViolations(plan: BodyPlan): string[] {
  const bad: string[] = [];
  try {
    hashPlan(plan); // throws on a non-finite number or a missing field
  } catch {
    return ['malformed plan: a number is missing or not finite'];
  }
  const { caps } = D;
  const n = plan.segments.length;
  if (n < 1 || n > caps.segments) bad.push(`segments: ${n} is outside 1-${caps.segments}`);
  const core = plan.colliders[0] ?? { x: NaN, y: NaN, r: NaN };
  if (core.x !== 0 || core.y !== 0 || core.r !== 1) bad.push('colliders: the core must come first');
  if (plan.colliders.length < 1 || plan.colliders.length > caps.colliders) {
    bad.push(`colliders: ${plan.colliders.length} is outside 1-${caps.colliders}`);
  }
  if (plan.appendages.length > caps.appendages) {
    bad.push(`appendages: ${plan.appendages.length} is more than ${caps.appendages}`);
  }
  const seen = new Map<string, number[]>();
  for (const a of plan.appendages) {
    if (a.segment < 0 || a.segment >= n) bad.push(`appendage on missing segment ${a.segment}`);
    if (a.joints < 1 || a.joints > caps.joints)
      bad.push(`appendage joints: ${a.joints} is outside 1-${caps.joints}`);
    if (a.branches < 0 || a.branches > caps.branches) {
      bad.push(`appendage branches: ${a.branches} is outside 0-${caps.branches}`);
    }
    const key = `${a.segment}/${a.side}`;
    seen.set(key, [...(seen.get(key) ?? []), a.angle]);
  }
  for (const [key, angles] of seen) {
    angles.sort((p, q) => p - q);
    for (let i = 1; i < angles.length; i++) {
      if ((angles[i] as number) - (angles[i - 1] as number) < D.minAngleGap - D.epsilon) {
        bad.push(`appendages overlap on segment/side ${key}`);
        break;
      }
    }
  }
  for (const c of plan.colliders) {
    if (hypot(c.x, c.y) + c.r > RULES.body.maxReach)
      bad.push('colliders: a circle reaches past the body limit');
  }
  for (const c of plan.colliders) {
    if (c.r < RULES.body.minColliderRadius || c.r > RULES.body.maxColliderRadius) {
      bad.push(`colliders: radius ${c.r} is outside the body limits`);
    }
  }
  for (const a of plan.appendages) {
    if (!(a.length > 0) || !(a.width > 0)) bad.push('appendage with no length or width');
    if (!(a.girth >= a.width)) bad.push('appendage drawn broader than its girth');
    if (a.angle < 0 || a.angle > PI) bad.push(`appendage angle ${a.angle} is outside 0-π`);
  }
  for (let i = 0; i + 1 < plan.appendages.length; i += 2) {
    const [l, r] = [plan.appendages[i], plan.appendages[i + 1]] as [Appendage, Appendage];
    if (l.side !== 1 || r.side !== -1 || l.segment !== r.segment || l.angle !== r.angle) {
      bad.push('appendages are not mirrored in pairs');
      break;
    }
  }
  if (plan.appendages.length % 2 === 1) bad.push('appendages are not mirrored in pairs');
  const m = plan.mouth;
  const b = RULES.body;
  if (
    !m ||
    !(m.offset >= 0 && m.offset <= b.maxReach) ||
    !(m.radius >= b.minMouthRadius && m.radius <= b.maxMouthRadius) ||
    !(m.arc >= b.minMouthArc && m.arc <= PI) ||
    !(m.digestion >= b.digestionMin && m.digestion <= b.digestionMax)
  ) {
    bad.push('no usable mouth at the front');
  }
  if (motileArea(plan.appendages) < D.minThrustArea) bad.push('no propulsion source');
  const bound = planBounds(plan);
  if (bound > caps.bounds) bad.push(`bounds: ${bound} is beyond ${caps.bounds} core radii`);
  bad.push(...shapeViolations(plan));
  return bad;
}

/** A 64-bit hash of every number in the plan, in a fixed order. */
export function hashPlan(plan: BodyPlan): string {
  const h = new Hasher();
  const f = (...values: number[]): void => {
    for (const v of values) h.f64(v);
  };
  f(plan.segments.length, plan.flexibility);
  for (const s of plan.segments) f(s.x, s.y, s.rx, s.ry, s.angle);
  f(plan.appendages.length);
  for (const a of plan.appendages) {
    f(a.module, a.side, a.segment, a.angle, a.dir, a.length, a.width, a.girth, a.taper);
    f(a.curvature);
    f(a.joints, a.branches, a.tip, a.stiffness, a.beat, a.phase);
    f(a.webbing, a.setae, a.setaeLength, a.bulb, a.chela, a.beads, a.fringe ? 1 : 0);
  }
  f(plan.plates.length);
  for (const p of plan.plates) f(p.segment, p.coverage, p.thickness);
  const m = plan.mouth;
  f(m.offset, m.radius, m.arc, m.type, m.digestion);
  f(plan.colliders.length);
  for (const c of plan.colliders) f(c.x, c.y, c.r);
  const { form: o, carapace: c, eyes: e } = plan;
  f(o.turn, o.mode, o.radial, o.slim);
  f(c.count, c.x, c.y, c.rx, c.ry, c.angle, c.thickness);
  f(e.count, e.size, e.stalk, e.angle, e.x, e.y);
  f(plan.membranes.length);
  for (const m of plan.membranes) {
    f(m.part, m.to, m.points.length);
    for (const p of m.points) f(p.x, p.y);
  }
  return h.digest();
}
