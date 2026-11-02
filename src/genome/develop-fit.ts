// Development, fit stage: moved verbatim out of develop.ts (ADR 0045).

import { atan2, clamp, cos, length as hypot, PI, sin, TAU } from '../sim/math';
import { type Bend, bendOf, capAndBend, mirrorBend, reachFrom, roughReach } from './develop-parts';
import {
  type Appendage,
  branchFactor,
  D,
  maxAngle,
  onAxis,
  type Part,
  type PlanSegment,
  type Point,
  placeOn,
  rootOf,
  X,
} from './develop-plan';

/** An ellipse of the drawn body, ready for inside tests: its centre, axis and inverse half-axes. */
interface Ellipse {
  x: number;
  y: number;
  c: number;
  s: number;
  irx: number;
  iry: number;
  /** Its longer half-axis and that squared: no point farther from its centre is inside. */
  r: number;
  r2: number;
}

/**
 * The drawn body outline (M6b T7): every segment's ellipse, as the mesh lofts the body. A carapace
 * is a thin glass shell over its segments, and parts leave the body from under it.
 */
export type Outline = Ellipse[];

export function outlineOf(segments: readonly PlanSegment[]): Outline {
  return segments.map((e) => {
    const r = Math.max(e.rx, e.ry);
    return {
      x: e.x,
      y: e.y,
      c: cos(e.angle),
      s: sin(e.angle),
      irx: 1 / e.rx,
      iry: 1 / e.ry,
      r,
      r2: r * r,
    };
  });
}

/** Whether (`x`, `y`) lies inside the ellipse `e`. */
function within(e: Ellipse, x: number, y: number): boolean {
  const dx = x - e.x;
  const dy = y - e.y;
  if (dx * dx + dy * dy >= e.r2) return false;
  const u = (dx * e.c + dy * e.s) * e.irx;
  const v = (dy * e.c - dx * e.s) * e.iry;
  return u * u + v * v < 1;
}

function inside(body: Outline, x: number, y: number): boolean {
  for (const e of body) if (within(e, x, y)) return true;
  return false;
}

/** The ellipses a part can reach from one root, by index: `n` of them in `idx`. */
interface Near {
  idx: Int32Array;
  n: number;
}

/** Only the ellipses within `length` of `root` can hold a point of a part that long. */
function nearTo(body: Outline, root: Point, length: number): Near {
  const near = { idx: new Int32Array(body.length), n: 0 };
  for (let j = 0; j < body.length; j++) {
    const e = body[j] as Ellipse;
    const reach = length + e.r;
    const dx = root.x - e.x;
    const dy = root.y - e.y;
    if (dx * dx + dy * dy < reach * reach) near.idx[near.n++] = j;
  }
  return near;
}

/**
 * The share of a part's centre line (`partCurve` without webbing: its arc, then its tip cap;
 * branches excluded) that lies inside the body, at `keep.samples` even points along its length, on
 * the worse of its two sides.
 */
function buried(
  p: Part,
  s: PlanSegment,
  l: Point,
  r: Point,
  body: Outline,
  nears: readonly [Near, Near],
  limit = 1,
): number {
  const K = D.keep.samples;
  // At its bend without webbing, as the bounds fit it: webbing is detail and never moves a part.
  const { cap, bend } = capAndBend(p, 0);
  const len = p.length - cap;
  const step = p.length / K;
  const straight = Math.abs(bend) < 1e-6;
  // The arc's heading turns by `bend` over `len`, so `dt` per step; the samples sit half a step in.
  const half = len > 0 ? (bend * step) / len / 2 : 0;
  const [ct, st] = straight ? [1, 0] : [cos(bend), sin(bend)];
  const [ch, sh] = straight ? [1, 0] : [cos(half), sin(half)];
  const [cd, sd] = [ch * ch - sh * sh, 2 * ch * sh];
  const most = Math.floor(limit * K);
  let worst = 0;
  const sides = onAxis(s) ? 1 : 2;
  for (let i = 0; i < sides; i++) {
    const side = i === 0 ? 1 : -1;
    const root = i === 0 ? l : r;
    const near = nears[i] as Near;
    const h0 = s.angle + side * p.dir;
    const c0 = cos(h0);
    const s0 = sin(h0);
    // The right side turns the other way: every turn's sine flips.
    const [ce, se] = [c0 * ct - s0 * side * st, s0 * ct + c0 * side * st];
    const rho = straight ? 0 : len / (side * bend);
    let hc = c0 * ch - s0 * side * sh;
    let hs = s0 * ch + c0 * side * sh;
    const sdd = side * sd;
    const ex = straight ? root.x + len * c0 : root.x + rho * (se - s0);
    const ey = straight ? root.y + len * s0 : root.y - rho * (ce - c0);
    let count = 0;
    for (let k = 0; k < K && count <= most; k++) {
      const along = (k + 0.5) * step;
      let x: number;
      let y: number;
      if (along <= len) {
        if (straight) {
          x = root.x + along * c0;
          y = root.y + along * s0;
        } else {
          x = root.x + rho * (hs - s0);
          y = root.y - rho * (hc - c0);
        }
        const nc = hc * cd - hs * sdd;
        hs = hs * cd + hc * sdd;
        hc = nc;
      } else {
        // Past the arc, the tip cap runs straight on along the end heading.
        x = ex + (along - len) * ce;
        y = ey + (along - len) * se;
      }
      for (let j = 0; j < near.n; j++) {
        if (within(body[near.idx[j] as number] as Ellipse, x, y)) {
          count++;
          break;
        }
      }
    }
    worst = Math.max(worst, count / K);
    if (worst > limit) break;
  }
  return worst;
}

/**
 * Whether the body covers the root at `angle` of segment `s` on either side (one on the axis): a
 * point `keep.clear` outside it lies inside the outline.
 */
function covered(s: PlanSegment, angle: number, body: Outline): boolean {
  const ca = cos(angle);
  const sa = sin(angle);
  // The outward normal there, in the segment's frame, scaled to `keep.clear`.
  const nx = s.ry * ca;
  const ny = s.rx * sa;
  const k = D.keep.clear / Math.max(hypot(nx, ny), D.epsilon);
  const u = s.rx * ca + k * nx;
  const v = s.ry * sa + k * ny;
  for (let side = 1; side >= -1; side -= 2) {
    const at = placeOn(s, u, side * v);
    if (inside(body, at.x, at.y)) return true;
    if (onAxis(s)) break;
  }
  return false;
}

/**
 * Moves a v2 part's root out from under the body (M6b T7): a root that a neighbour covers slides
 * round its segment, `keep.slide` at a time, to the nearest attach angle where the body shows on
 * both sides and no other part of the segment sits. A segment the body covers whole keeps its parts
 * where they are. Edits in place.
 */
export function uncover(
  p: Part,
  parts: readonly Part[],
  segments: PlanSegment[],
  body: Outline,
): void {
  const s = segments[p.segment] as PlanSegment;
  if (!covered(s, p.angle, body)) return;
  const step = D.keep.slide;
  // Never onto another part of the segment, which `separate` would then merge it into.
  const taken = (angle: number): boolean =>
    parts.some(
      (q) => q !== p && q.segment === p.segment && Math.abs(q.angle - angle) < D.minAngleGap,
    );
  for (let k = 1; k * step < PI; k++) {
    for (let way = -1; way <= 1; way += 2) {
      const angle = p.angle + way * k * step;
      if (angle < D.angleMargin || angle > maxAngle) continue;
      if (!covered(s, angle, body) && !taken(angle)) {
        p.angle = angle;
        return;
      }
    }
  }
}

/**
 * Keeps a v2 part off the body (M6b T7): a part with more than `keep.share` of its centre line
 * inside the drawn outline turns, `keep.step` at a time either way (the side away from the body
 * first, never ahead of `from`, never past the tail, and a tail part growing rearward no further
 * forward than sideways, and a leg within its sweep, M6c T3), up to `keep.turns` steps: the least
 * turn that clears it whole wins, then
 * the least that clears it shortened to fit the bounds. If none clears, it takes the whole turn
 * that buries least. Edits in place.
 */
function keepOff(p: Part, segments: PlanSegment[], body: Outline, from: number): void {
  const K = D.keep;
  const s = segments[p.segment] as PlanSegment;
  const l = rootOf(s, p.angle, 1);
  const r = onAxis(s) ? { x: l.x, y: -l.y } : rootOf(s, p.angle, -1);
  // The ellipses within the unshortened part's reach: every trial is no longer than that.
  const nears = [nearTo(body, l, p.length), nearTo(body, r, p.length)] as const;
  let best = buried(p, s, l, r, body, nears);
  if (best <= K.share) return;
  const [dir0, length0] = [p.dir, p.length];
  let [bestDir, bestLength] = [dir0, length0];
  const tail = p.segment === segments.length - 1 ? Math.min(dir0, PI / 2) : 0;
  const lo = Math.max(from, tail, p.lo);
  const hi = p.hi;
  // The side away from the body first: toward the root's outward normal.
  const normal = atan2(s.rx * sin(p.angle), s.ry * cos(p.angle));
  const first = normal >= dir0 ? 1 : -1;
  const fits = boundsCheck(p, s, l, r);
  const free = D.caps.bounds - D.boundsSlack - Math.max(hypot(l.x, l.y), hypot(r.x, r.y));
  const cut = Math.min(length0, (free - p.bulb) / branchFactor(p.branches));
  // A turn that clears the body only shortened is kept in reserve: a whole one may follow.
  let short: [number, number] | undefined;
  for (let j = 1; j <= K.turns; j++) {
    for (let w = 0; w < 2; w++) {
      const dir = dir0 + (w === 0 ? first : -first) * j * K.step;
      if (dir < lo || dir > hi) continue;
      p.dir = dir;
      p.length = length0;
      // Whole, a turn that buries no less than the best so far is no better; the bounds come after.
      const share = buried(p, s, l, r, body, nears, best);
      if (share >= best) continue;
      if (fits()) {
        if (share <= K.share) return;
        [best, bestDir, bestLength] = [share, dir, length0];
      } else if (!short && share <= K.share) {
        // The longest length that fits whole at this turn, to 2^−`keep.steps`; the v1 cut always does.
        let [lo2, hi2] = [cut, length0];
        for (let k = 0; k < K.steps; k++) {
          p.length = (lo2 + hi2) / 2;
          if (fits()) lo2 = p.length;
          else hi2 = p.length;
        }
        p.length = lo2;
        if (buried(p, s, l, r, body, nears, K.share) <= K.share) short = [dir, lo2];
      }
    }
  }
  [p.dir, p.length] = short ?? [bestDir, bestLength];
}

/**
 * Sets the growth direction (bent `sweep` of the way toward the tail, but never ahead of `from`)
 * and fits the part inside the bounds. A part keeps its gene length if it can: it sweeps toward the
 * core, along the body, as little as it must and at most `fit.max` (a rear-segment part growing
 * rearward turns no further forward than sideways), and a part that still leaves the bounds is cut
 * so that root plus reach stays inside. It then keeps off the body (`keepOff`, M6b T7).
 * Edits in place.
 */
function fitPart(p: Part, segments: PlanSegment[], sweep: number, body: Outline, from = 0): void {
  fitBounds(p, segments, sweep, from);
  keepOff(p, segments, body, from);
}

function fitBounds(p: Part, segments: PlanSegment[], sweep: number, from: number) {
  const wish = p.length;
  if (!(wish > p.base)) {
    fitAt(p, segments, sweep, from);
    return;
  }
  if (fitLength(p, segments, sweep, from, wish)) return;
  // A long part (look pass 4) keeps as much of its reach past its base length as fits whole,
  // to 2^−`long.steps` of it; if not even that length fits, it is cut as any part is.
  let [lo, hi] = [p.base, wish];
  if (!fitLength(p, segments, sweep, from, lo)) return;
  let kept = true;
  for (let k = 0; k < D.long.steps; k++) {
    const mid = (lo + hi) / 2;
    kept = fitLength(p, segments, sweep, from, mid);
    if (kept) lo = mid;
    else hi = mid;
  }
  if (!kept) fitLength(p, segments, sweep, from, lo);
}

/** `fitPart` at one length: whether the part keeps it whole. */
function fitLength(
  p: Part,
  segments: PlanSegment[],
  sweep: number,
  from: number,
  length: number,
): boolean {
  p.length = length;
  fitAt(p, segments, sweep, from);
  return p.length === length;
}

/**
 * Whether part `p` (at its current direction and length) fits the bounds whole on both sides, from
 * its roots `l` and `r` on segment `s`.
 */
function boundsCheck(p: Part, s: PlanSegment, l: Point, r: Point): () => boolean {
  const mirrored = onAxis(s);
  const room = D.caps.bounds - D.boundsSlack;
  // Webbing straightens the drawn part toward its membrane's rays, so the fit holds the part, at
  // its full bend, half of it and straight, with the rays any sheet may span: webbing is detail
  // and never changes how a part fits. Between those bends the drawn reach stays within the
  // bounds slack. The cap and bend follow the part's length.
  let length = Number.NaN;
  let cap = 0;
  let bend = 0;
  // The exact bends take trigonometry, so they are made only when the rough bound is not enough.
  let exact: [Bend[], Bend[]] | undefined;
  const bends = (): [Bend[], Bend[]] => {
    if (!exact) {
      const left = (bend === 0 ? [0] : [bend, bend / 2, 0]).map((b) => bendOf(b, 1));
      exact = [left, mirrored ? left : left.map(mirrorBend)];
    }
    return exact;
  };
  const side = (root: Point, heading: number, sign: 1 | -1): boolean => {
    const c = cos(heading);
    const n = sin(heading);
    if (roughReach(root, c, n, bend, sign, p) <= room) return true;
    const k = bends()[sign === 1 ? 0 : 1];
    for (let i = 0; i < k.length; i++) {
      if (reachFrom(root, c, n, k[i] as Bend, cap, p, i === 0, room) > room) return false;
    }
    return true;
  };
  return (): boolean => {
    if (p.length !== length) {
      length = p.length;
      ({ cap, bend } = capAndBend(p, 0));
      exact = undefined;
    }
    return side(l, s.angle + p.dir, 1) && (mirrored || side(r, s.angle - p.dir, -1));
  };
}

function fitAt(p: Part, segments: PlanSegment[], sweep: number, from: number): void {
  // On a turned segment the two sides' roots lie at different distances; the farther one counts.
  const s = segments[p.segment] as PlanSegment;
  const mirrored = onAxis(s);
  const l = rootOf(s, p.angle, 1);
  const r = mirrored ? { x: l.x, y: -l.y } : rootOf(s, p.angle, -1);
  const free = D.caps.bounds - D.boundsSlack - Math.max(hypot(l.x, l.y), hypot(r.x, r.y));
  // A bulb takes at most its share of the free reach, and the part shortens to make room for it.
  p.bulb = Math.min(p.bulb, X.bulb.room * Math.max(0, free));
  // A leg keeps to its sweep (M6c T3): every turn below stays inside `lo`-`hi`.
  const lo = p.lo;
  const hi = p.hi;
  const dir = clamp(Math.max(from, p.angle + sweep * (PI - p.angle)), lo, hi);
  p.dir = dir;
  const cut = Math.min(p.length, (free - p.bulb) / branchFactor(p.branches));
  if (cut >= p.length) {
    p.length = cut;
    return;
  }
  const fits = boundsCheck(p, s, l, r);
  if (fits()) return;
  // Sweep along the body toward the core, at most `fit.max`, and never so that a part on the
  // rear segment growing rearward grows forward: a tail stays a tail. If even the farthest sweep
  // leaves the bounds the part is cut; otherwise the least sweep that fits, found by halving.
  const inward = atan2(-l.y, -l.x) - s.angle;
  const toward = inward - TAU * Math.round((inward - dir) / TAU);
  const tail = p.segment === segments.length - 1 ? Math.min(dir, PI / 2) : 0;
  const floor = Math.max(from, dir - D.fit.max, tail, lo);
  const most = clamp(toward, floor, Math.min(hi, dir + D.fit.max));
  p.dir = most;
  if (most !== dir && fits()) {
    let [a, b] = [0, 1];
    for (let k = 0; k < D.fit.sweeps; k++) {
      const t = (a + b) / 2;
      p.dir = dir + t * (most - dir);
      if (fits()) b = t;
      else a = t;
    }
    p.dir = dir + b * (most - dir);
    return;
  }
  // Nothing fits whole: cut it at its own direction.
  p.dir = dir;
  p.length = cut;
}

export function shape(
  parts: Part[],
  segments: PlanSegment[],
  sweep: number,
  body: Outline,
): Part[] {
  for (const p of parts) fitPart(p, segments, sweep, body);
  return parts;
}

/** The even angle of ring slot `k` of `pairs` on the left side: the instances share the circle. */
export const ringAngle = (k: number, pairs: number): number => (PI * (2 * k + 1)) / (2 * pairs);

/**
 * A radial body: the parts, in order, ring the core at even angles, and each grows no further
 * forward than the one before it, so a fitted part never crosses its neighbour. Copies them.
 */
export function ring(parts: Part[], segments: PlanSegment[], sweep: number, body: Outline): Part[] {
  const ringed = parts.map((p, k) => ({ ...p, segment: 0, angle: ringAngle(k, parts.length) }));
  let from = 0;
  for (const p of ringed) {
    fitPart(p, segments, sweep, body, from);
    from = p.dir;
  }
  return ringed;
}

export type Piece = Pick<Appendage, 'length' | 'girth' | 'beat' | 'branches'>;
