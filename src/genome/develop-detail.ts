// Development, detail stage: moved verbatim out of develop.ts (ADR 0045).

import type { Collider } from '../sim/body';
import { atan2, clamp, cos, length as hypot, lerp, PI, sin } from '../sim/math';
import { RULES } from '../sim/rules';
import * as fromChain from './develop-chain';
import * as fromParts from './develop-parts';
import type {
  Appendage,
  Carapace,
  Membrane,
  PlanEyes,
  PlanMouth,
  PlanSegment,
  Point,
} from './develop-plan';
import * as fromPlan from './develop-plan';
import type { Traits } from './express';

// Bound once: the test runner reads an import through a getter on every use, which costs a fifth of the
// 0.15 ms development budget (stats.test.ts) in these hot loops.
const {
  X,
  onAxis,
  rootOf,
  dirOf,
  D,
  placeOn,
  PLATE_THICKNESS,
  turnTo,
  EYE_SIZE,
  EYE_STALK,
  branchFanOf,
} = fromPlan;
const { fusedCount } = fromChain;
const { partCurve, curveAt } = fromParts;

/** The signed area of a polygon: positive when it runs counter-clockwise. */
export function polygonArea(points: readonly Point[]): number {
  let twice = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i] as Point;
    const b = points[(i + 1) % points.length] as Point;
    twice += a.x * b.y - b.x * a.y;
  }
  return twice / 2;
}

/** The turn at `b` on the way from `a` to `c`: positive to the left. */
export const turnAt = (a: Point, b: Point, c: Point): number =>
  (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);

/** Where segments `ab` and `cd` cross, strictly inside both, or null. */
function crossing(a: Point, b: Point, c: Point, d: Point): Point | null {
  const den = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x);
  if (den === 0) return null;
  const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / den;
  const u = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / den;
  if (!(t > 0 && t < 1 && u > 0 && u < 1)) return null;
  return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
}

/** A sheet as convex, counter-clockwise pieces of real area: whole, or split at a crossing or a reflex corner. */
function pieces(q: Point[]): Point[][] {
  let out: Point[][] = [q];
  if (q.length === 4) {
    const [a, b, c, d] = q as [Point, Point, Point, Point];
    const x = crossing(a, b, c, d);
    const y = x ? null : crossing(b, c, d, a);
    if (x)
      out = [
        [a, x, d],
        [x, b, c],
      ];
    else if (y)
      out = [
        [a, b, y],
        [y, c, d],
      ];
    else {
      const sign = polygonArea(q) >= 0 ? 1 : -1;
      const k = [0, 1, 2, 3].findIndex(
        (i) => sign * turnAt(q[i] as Point, q[(i + 1) % 4] as Point, q[(i + 2) % 4] as Point) < 0,
      );
      if (k >= 0) {
        const r = (k + 1) % 4;
        const at = (i: number): Point => q[(r + i) % 4] as Point;
        out = [
          [at(0), at(1), at(2)],
          [at(0), at(2), at(3)],
        ];
      }
    }
  }
  const kept: Point[][] = [];
  for (const p of out) {
    const area = polygonArea(p);
    // A reversed piece's area is summed again in its own order, as the check reads it.
    const ccw = area < 0 ? [...p].reverse() : p;
    if ((area < 0 ? polygonArea(ccw) : area) >= X.minArea) kept.push(ccw);
  }
  return kept;
}

/**
 * The membranes of webbed parts, side by side: each spans `webbing` of the way along its own rays
 * to its branches, and to the next part rearward on its side when their roots lie within `webSpan`.
 * The rearmost left part spans to its own mirror instead: a tail fan.
 */
export function buildMembranes(segments: PlanSegment[], appendages: Appendage[]): Membrane[] {
  if (!appendages.some((a) => a.webbing > 0)) return [];
  const out: Membrane[] = [];
  const at = (p: Point, d: Point, t: number): Point => ({ x: p.x + t * d.x, y: p.y + t * d.y });
  type Ray = { a: Appendage; s: PlanSegment; root: Point; dir: Point };
  const rays: (Ray | undefined)[] = [];
  const ray = (i: number): Ray => {
    const known = rays[i];
    if (known) return known;
    const a = appendages[i] as Appendage;
    const s = segments[a.segment] as PlanSegment;
    // Pairs are left then right: on the axis the right instance mirrors the left exactly, unless
    // its growth direction differs by the pair's jitter (M6c T4).
    const left = i % 2 === 1 && onAxis(s) ? ray(i - 1) : undefined;
    const twin = left && left.a.dir === a.dir ? left : undefined;
    const made = twin
      ? {
          a,
          s,
          root: { x: twin.root.x, y: -twin.root.y },
          dir: { x: twin.dir.x, y: -twin.dir.y },
        }
      : { a, s, root: rootOf(s, a.angle, a.side), dir: dirOf(s, a) };
    rays[i] = made;
    return made;
  };
  const add = (part: number, to: number, points: Point[]): void => {
    for (const p of pieces(points)) out.push({ part, to, points: p });
  };
  for (const side of [1, -1] as const) {
    const order = appendages
      .map((a, i) => ({ a, i }))
      .filter(({ a }) => a.side === side)
      .sort((p, q) => p.a.segment - q.a.segment || p.a.angle - q.a.angle)
      .map(({ i }) => i);
    order.forEach((i, j) => {
      const { a, s, root, dir } = ray(i);
      const w = a.webbing;
      if (!(w > 0)) return;
      const reach = w * a.length;
      if (a.branches > 0) {
        const fork = at(root, dir, D.branchAt * a.length);
        const tip = at(fork, dir, (1 - D.branchAt) * reach);
        for (let b = 0; b < a.branches; b++) {
          const branch = dirOf(s, { dir: a.dir + branchFanOf(b, a.branches), side });
          add(i, i, [fork, tip, at(fork, branch, D.branchScale * reach)]);
        }
      }
      const next = order[j + 1] ?? (side === 1 ? i + 1 : undefined);
      if (next === undefined) return;
      const q = ray(next);
      if (hypot(q.root.x - root.x, q.root.y - root.y) > X.webSpan) return;
      add(i, next, [root, at(root, dir, reach), at(q.root, q.dir, w * q.a.length), q.root]);
    });
  }
  return out;
}

export function buildMouth(m: Traits['mouth'], radial: number): PlanMouth {
  const jaw = Math.max(0, m.type - D.jawStart);
  return {
    // A radial body's mouth is central.
    offset: radial ? 0 : D.mouthReach * jaw,
    radius: m.size * (D.mouthRadiusBase - m.type),
    arc: PI * (1 - D.mouthNarrow * jaw),
    type: m.type,
    digestion: m.digestion,
  };
}

/** Unit-circle points that a carapace hull must contain, per fused segment. */
const HULL_SAMPLES: readonly Point[] = Array.from({ length: D.fusion.samples }, (_, j) => {
  const a = (2 * PI * j) / D.fusion.samples;
  return { x: cos(a), y: sin(a) };
});

/** A turn by `angle` with its cosine and sine taken once: `turnTo`'s arithmetic, for many points. */
function turner(angle: number): (dx: number, dy: number) => Point {
  if (angle === 0) return (dx, dy) => ({ x: dx, y: dy });
  const c = cos(angle);
  const n = sin(angle);
  return (dx, dy) => ({ x: dx * c - dy * n, y: dx * n + dy * c });
}

/** The outline points of segment `s` in body coordinates. */
const outline = (s: PlanSegment): Point[] => {
  const turn = turner(s.angle);
  return HULL_SAMPLES.map((p) => {
    const d = turn(s.rx * p.x, s.ry * p.y);
    return { x: s.x + d.x, y: s.y + d.y };
  });
};

const NO_CARAPACE: Carapace = { count: 0, x: 0, y: 0, rx: 0, ry: 0, angle: 0, thickness: 0 };

/** One ellipse over the front `count` segments: along the axis from the rearmost fused centre to the core. */
export function buildCarapace(segments: PlanSegment[], fusion: number, plating: number): Carapace {
  const count = fusedCount(fusion, segments.length);
  if (count < 1) return { ...NO_CARAPACE };
  const last = segments[count - 1] as PlanSegment;
  const angle = count > 1 && (last.y !== 0 || last.angle !== 0) ? atan2(-last.y, -last.x) : 0;
  const axis: PlanSegment = { x: 0, y: 0, rx: 1, ry: 1, angle };
  // The points in the hull's frame: u along its axis, v across.
  const pts = segments.slice(0, count).flatMap(outline);
  const back = turner(-angle);
  const local = pts.map((p) => back(p.x, p.y));
  let [u0, u1, v0, v1] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const p of local) {
    u0 = Math.min(u0, p.x);
    u1 = Math.max(u1, p.x);
    v0 = Math.min(v0, p.y);
    v1 = Math.max(v1, p.y);
  }
  const cu = (u1 + u0) / 2;
  const cv = (v1 + v0) / 2;
  let rx = (u1 - u0) / 2;
  let ry = (v1 - v0) / 2;
  // Grow the box's ellipse until it holds every outline point, then keep it inside the bounds.
  let grow = 1;
  for (const p of local) grow = Math.max(grow, hypot((p.x - cu) / rx, (p.y - cv) / ry));
  rx *= grow;
  ry *= grow;
  // The shell overhangs its segments (M6c T3), so the legs on it root under it.
  let widest = 0;
  for (let i = 0; i < count; i++) widest = Math.max(widest, (segments[i] as PlanSegment).ry);
  rx += D.fusion.overhang * widest;
  ry += D.fusion.overhang * widest;
  const centre = placeOn(axis, cu, cv);
  const room = D.caps.bounds - D.boundsSlack - hypot(centre.x, centre.y);
  const fit = clamp(room / Math.max(rx, ry), D.epsilon, 1);
  return {
    count,
    x: centre.x,
    y: centre.y,
    rx: rx * fit,
    ry: ry * fit,
    angle,
    thickness: lerp(D.fusion.thickness, PLATE_THICKNESS[1], plating),
  };
}

/** The hull's half-width at the point of its axis nearest to `p`, and that point. */
function hullAt(c: Carapace, p: Point): Point & { r: number } {
  const frame: PlanSegment = { x: c.x, y: c.y, rx: 1, ry: 1, angle: c.angle };
  const u = turnTo({ ...frame, angle: -c.angle }, p.x - c.x, p.y - c.y).x;
  const along = clamp(u, -c.rx, c.rx);
  const q = placeOn(frame, along, 0);
  return { ...q, r: c.ry * Math.sqrt(Math.max(0, 1 - (along / c.rx) * (along / c.rx))) };
}

export function buildEyes(shape: Traits['shape'], head: PlanSegment): PlanEyes {
  const E = D.eyes;
  if (!(shape.eyeSize > E.min)) return { count: 0, size: 0, stalk: 0, angle: 0, x: 0, y: 0 };
  const gene = lerp(EYE_SIZE[0], EYE_SIZE[1], (shape.eyeSize - E.min) / (1 - E.min));
  const root = rootOf(head, E.angle);
  const room = D.caps.bounds - D.boundsSlack - hypot(root.x, root.y) - 2 * gene;
  const stalk = clamp(lerp(EYE_STALK[0], EYE_STALK[1], shape.eyeStalk), 0, Math.max(0, room));
  const out = turnTo(head, cos(E.angle), sin(E.angle));
  // A short stalk sinks the eye into the head (look pass 5): `set` of its diameter inside at no stalk.
  const sink = E.set * (1 - stalk / EYE_STALK[1]);
  // The pair never overlaps (ADR 0037): an eye's centre, `root.y + (stalk + size·(1 − 2·sink))·out.y`
  // from the midline, stays at least its radius out, so a small trunk head carries smaller eyes.
  // Only the smallest eye, at the gene range's floor, may still touch its twin.
  const lean = (1 - 2 * sink) * out.y;
  const fits = lean < 1 ? (root.y + stalk * out.y) / (1 - lean) : gene;
  const size = clamp(fits, EYE_SIZE[0], gene);
  const from = stalk + size * (1 - 2 * sink);
  return {
    count: 2,
    size,
    stalk,
    angle: E.angle,
    x: root.x + from * out.x,
    y: root.y + from * out.y,
  };
}

const colliderRadius = (r: number): number =>
  clamp(r, RULES.body.minColliderRadius, RULES.body.maxColliderRadius);

export function buildColliders(
  segments: PlanSegment[],
  appendages: Appendage[],
  carapace: Carapace,
): Collider[] {
  const out: Collider[] = [{ x: 0, y: 0, r: 1 }];
  for (let i = 1; i < segments.length; i++) {
    const s = segments[i] as PlanSegment;
    if (i < carapace.count) {
      // A fused segment's circle sits on the shell's axis and fills its width there.
      const h = hullAt(carapace, s);
      const room = RULES.body.maxReach - D.epsilon - hypot(h.x, h.y);
      out.push({ x: h.x, y: h.y, r: colliderRadius(Math.min(h.r, room)) });
    } else {
      out.push({ x: s.x, y: s.y, r: colliderRadius(s.ry) });
    }
  }
  // The biggest pairs get what circles are left, both sides or neither; ties keep instance order.
  const ranked = appendages
    .map((a, i) => ({ i, score: a.length * a.width }))
    .filter(
      ({ i }) =>
        i % 2 === 0 &&
        (appendages[i] as Appendage).width * D.colliderWidth >= RULES.body.minColliderRadius,
    )
    .sort((p, q) => q.score - p.score || p.i - q.i);
  for (const { i } of ranked) {
    if (out.length + 2 > D.caps.colliders) break;
    for (const a of [appendages[i], appendages[i + 1]] as Appendage[]) {
      const s = segments[a.segment] as PlanSegment;
      const r = colliderRadius(a.width * D.colliderWidth);
      const along = a.length * D.colliderAlong;
      // On the drawn centre line, pulled in if a part swept to the bounds would push it past them.
      const c = partCurve(s, a);
      const at = curveAt(c, Math.min(1, along / Math.max(c.len, D.epsilon)));
      const far = hypot(at.x, at.y);
      const room = RULES.body.maxReach - D.epsilon - r;
      const pull = far > room ? room / far : 1;
      out.push({ x: at.x * pull, y: at.y * pull, r });
    }
  }
  return out;
}
