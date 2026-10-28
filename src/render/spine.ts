// The body's centre line (M6 T10): a centripetal Catmull-Rom curve along the plan's segments,
// shared by the mesh's loft and the inner anatomy (M6 T12).

import type { PlanSegment } from '../genome/develop';
import { clamp } from '../sim/math';

const { cos, sin, sqrt, hypot, max } = Math;
/** Samples per span of the spine's Catmull-Rom centre line. */
const SPAN_SAMPLES = 24;

/** The body's centre line: a dense polyline from the front tip (s = 0) to the rear tip (s = 1). */
export interface Line {
  x: number[];
  y: number[];
  /** Arc length from the front at each point. */
  at: number[];
  length: number;
}

const forwardOf = (s: PlanSegment): { x: number; y: number } => ({
  x: cos(s.angle),
  y: sin(s.angle),
});

/** A centripetal Catmull-Rom curve through the front tip, every segment centre and the rear tip. */
export function centreLine(segments: readonly PlanSegment[]): Line {
  const head = segments[0] as PlanSegment;
  const tail = segments[segments.length - 1] as PlanSegment;
  const hf = forwardOf(head);
  const tf = forwardOf(tail);
  const pts = [
    { x: head.x + hf.x * head.rx, y: head.y + hf.y * head.rx },
    ...segments.map((s) => ({ x: s.x, y: s.y })),
    { x: tail.x - tf.x * tail.rx, y: tail.y - tf.y * tail.rx },
  ];
  const n = pts.length;
  const p = (i: number) => {
    if (i < 0) {
      const [a, b] = [pts[0], pts[1]] as [(typeof pts)[0], (typeof pts)[0]];
      return { x: 2 * a.x - b.x, y: 2 * a.y - b.y };
    }
    if (i >= n) {
      const [a, b] = [pts[n - 1], pts[n - 2]] as [(typeof pts)[0], (typeof pts)[0]];
      return { x: 2 * a.x - b.x, y: 2 * a.y - b.y };
    }
    return pts[i] as (typeof pts)[0];
  };
  const line: Line = { x: [], y: [], at: [], length: 0 };
  const push = (x: number, y: number) => {
    const k = line.x.length;
    if (k > 0) line.length += hypot(x - (line.x[k - 1] as number), y - (line.y[k - 1] as number));
    line.x.push(x);
    line.y.push(y);
    line.at.push(line.length);
  };
  push(p(0).x, p(0).y);
  for (let i = 0; i + 1 < n; i++) {
    const [p0, p1, p2, p3] = [p(i - 1), p(i), p(i + 1), p(i + 2)];
    const knot = (a: { x: number; y: number }, b: { x: number; y: number }) =>
      max(sqrt(hypot(b.x - a.x, b.y - a.y)), 1e-6);
    const t1 = knot(p0, p1);
    const t2 = t1 + knot(p1, p2);
    const t3 = t2 + knot(p2, p3);
    const lerp = (
      a: { x: number; y: number },
      b: { x: number; y: number },
      ta: number,
      tb: number,
      t: number,
    ) => {
      const w = (t - ta) / (tb - ta);
      return { x: a.x + (b.x - a.x) * w, y: a.y + (b.y - a.y) * w };
    };
    for (let k = 1; k <= SPAN_SAMPLES; k++) {
      const t = t1 + ((t2 - t1) * k) / SPAN_SAMPLES;
      const a1 = lerp(p0, p1, 0, t1, t);
      const a2 = lerp(p1, p2, t1, t2, t);
      const a3 = lerp(p2, p3, t2, t3, t);
      const b1 = lerp(a1, a2, 0, t2, t);
      const b2 = lerp(a2, a3, t1, t3, t);
      const c = lerp(b1, b2, t1, t2, t);
      push(c.x, c.y);
    }
  }
  return line;
}

/** The point at arc share `s` (0 front, 1 rear) and the unit forward direction there. */
export function along(line: Line, s: number): { x: number; y: number; fx: number; fy: number } {
  const target = clamp(s, 0, 1) * line.length;
  let lo = 0;
  let hi = line.at.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((line.at[mid] as number) <= target) lo = mid;
    else hi = mid;
  }
  const span = (line.at[hi] as number) - (line.at[lo] as number);
  const w = span > 0 ? (target - (line.at[lo] as number)) / span : 0;
  const [x0, y0] = [line.x[lo] as number, line.y[lo] as number];
  const [x1, y1] = [line.x[hi] as number, line.y[hi] as number];
  const d = hypot(x1 - x0, y1 - y0) || 1;
  // The line runs rearward, so forward is its reverse.
  return { x: x0 + (x1 - x0) * w, y: y0 + (y1 - y0) * w, fx: (x0 - x1) / d, fy: (y0 - y1) / d };
}
