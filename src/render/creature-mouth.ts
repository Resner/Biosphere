// The mouth's feature (M6c T6, ADR 0043): the mouth's disc on the body's front is glass like the
// rest of the body, and a small feature at the front tells what kind of mouth it is, sized by the
// mouth genes and never wider than `MOUTH_SPAN` of the body: a filter mouth is a narrow funnel
// ringed by fine cilia, a jaw a pair of short mandibles curving toward each other. The parts are
// drawn as the body's glass (a limb's tube, setae's ribbons) under their own part number, so they
// ride the body's motion at its front and the gallery can mask them apart from the limbs.

import type { BodyPlan } from '../genome/develop';
import { clamp } from '../sim/math';
import { RULES } from '../sim/rules';
import type { MeshDetail } from './creature-detail';
import { bodyMotion, type Spine, type Station } from './creature-loft';
import { addTube } from './creature-parts';
import { type Mesh, PART_APPENDAGE, PART_KINDS, PART_SETA } from './mesh-buffer';

const { cos, sin, hypot, max, min, round, PI } = Math;
const D = RULES.develop;
const BOUNDS = D.caps.bounds;

/** The feature's part number: above every appendage's (development caps them at 24). */
export const MOUTH_PART_ID = 31;
/** The feature spans at most this share of the body's widest width (the spec's 35%). */
export const MOUTH_SPAN = 0.35;
/** The smallest mouth (size 0.2) spans this share of the largest's. */
const SMALL = 0.55;

/**
 * A filter mouth: the funnel's length and radius (shares of the span; it narrows to `FUNNEL_TIP` of
 * its radius going into the body), and the cilia round its opening: how many (by mouth size), how
 * far round from forward they fan (radians), how long, the ring they root on and their half-width
 * (core radii, a fine seta's).
 */
const FUNNEL = { length: 0.45, radius: 0.13, tip: 0.45 } as const;
const CILIA = { min: 5, max: 9, fan: PI / 3, length: 0.34, ring: 0.13, width: 0.014 } as const;
/**
 * A jaw: each mandible roots this far either side of the midline and this far behind the front tip
 * (shares of the span), leaves turned outward, curves inward by `turn` (radians) over its length
 * (a share of the span, longer with a stronger jaw) and tapers from its root radius to a point.
 */
const MANDIBLE = {
  side: 0.3,
  behind: 0.12,
  out: 0.35,
  turn: 1.3,
  length: [0.42, 0.6],
  radius: 0.085,
  taper: 0.85,
} as const;

export interface MouthFeature {
  kind: 'filter' | 'jaw';
  /** The front tip of the body, where the feature sits, and the body's forward heading there. */
  x: number;
  y: number;
  heading: number;
  /** The widest the feature may reach across (core radii): `MOUTH_SPAN` of the body, by mouth size. */
  span: number;
  /** The body's widest width (core radii). */
  width: number;
  /** 0..1: the mouth size's share of its range and the jaw's strength (0 for a filter mouth). */
  size: number;
  jaw: number;
}

/** The loft ring at the body's front tip. */
const frontOf = (spine: Spine): Station =>
  spine.reduce((a, b) => (b.from < a.from ? b : a), spine[0] as Station);

/** Where the mouth's feature sits on `plan`'s body and how large it is. */
export function mouthFeature(plan: BodyPlan, spine: Spine): MouthFeature {
  const front = frontOf(spine);
  const width = spine.reduce((w, st) => max(w, st.left + st.right), 0);
  const { radius, type } = plan.mouth;
  const range = D.mouthRadiusBase - type;
  const size = clamp((radius / max(range, 1e-6) - 0.2) / 0.8, 0, 1);
  const jaw = clamp((type - D.jawStart) / (1 - D.jawStart), 0, 1);
  return {
    kind: type >= D.jawStart ? 'jaw' : 'filter',
    x: front.x,
    y: front.y,
    // The spine's forward is its left normal turned back a right angle.
    heading: Math.atan2(-front.nx, front.ny),
    span: MOUTH_SPAN * width * (SMALL + (1 - SMALL) * size),
    width,
    size,
    jaw,
  };
}

/** How far from (`x`, `y`) along `heading` stays inside the bounds, up to `len`. */
function within(x: number, y: number, heading: number, len: number): number {
  const [ux, uy] = [cos(heading), sin(heading)];
  const b = x * ux + y * uy;
  const room = -b + Math.sqrt(max(0, b * b - (x * x + y * y - BOUNDS * BOUNDS)));
  return max(0, min(len, room));
}

/** Draws the mouth's feature over the body's front (after the body, before the organs). */
export function addMouth(m: Mesh, plan: BodyPlan, spine: Spine, d: MeshDetail): void {
  const f = mouthFeature(plan, spine);
  const front = frontOf(spine);
  m.gait = bodyMotion(plan, front);
  const attach = front.s;
  const tube = PART_APPENDAGE + MOUTH_PART_ID * PART_KINDS;
  const ring = max(3, min(d.partRing, 6));
  const [fx, fy] = [cos(f.heading), sin(f.heading)];
  const [nx, ny] = [-fy, fx];
  if (f.kind === 'jaw') {
    const len = f.span * (MANDIBLE.length[0] + (MANDIBLE.length[1] - MANDIBLE.length[0]) * f.jaw);
    const r0 = f.span * MANDIBLE.radius;
    for (const side of [1, -1] as const) {
      const x0 = f.x - fx * f.span * MANDIBLE.behind + nx * side * f.span * MANDIBLE.side;
      const y0 = f.y - fy * f.span * MANDIBLE.behind + ny * side * f.span * MANDIBLE.side;
      const heading = f.heading + side * MANDIBLE.out;
      addTube(
        m,
        {
          path: {
            x0,
            y0,
            heading,
            turn: -side * MANDIBLE.turn,
            len: within(x0, y0, heading, len),
          },
          radius: (t) => r0 * (1 - MANDIBLE.taper * t),
          cap: 0,
          attach,
          part: tube,
          base: null,
        },
        4,
        ring,
      );
    }
    return;
  }
  // A filter mouth: the funnel leads back into the body from the front tip.
  const r0 = f.span * FUNNEL.radius;
  addTube(
    m,
    {
      path: { x0: f.x, y0: f.y, heading: f.heading + PI, turn: 0, len: f.span * FUNNEL.length },
      radius: (t) => r0 * (1 - (1 - FUNNEL.tip) * t),
      cap: 0,
      attach,
      part: tube,
      base: null,
    },
    3,
    ring,
  );
  const seta = PART_SETA + MOUTH_PART_ID * PART_KINDS;
  const count = round(CILIA.min + (CILIA.max - CILIA.min) * f.size);
  for (let k = 0; k < count; k++) {
    const a = -CILIA.fan + (2 * CILIA.fan * k) / (count - 1);
    const h = f.heading + a;
    const [ux, uy] = [cos(h), sin(h)];
    const x0 = f.x + ux * f.span * CILIA.ring;
    const y0 = f.y + uy * f.span * CILIA.ring;
    const len = within(x0, y0, h, f.span * CILIA.length);
    if (len <= 0 || hypot(x0, y0) > BOUNDS) continue;
    const point = (s: number, half: number): number => {
      const i = m.vertex(
        x0 + ux * len * s - uy * half,
        y0 + uy * len * s + ux * half,
        0,
        0.5 + 0.5 * Math.sign(half),
        s,
        attach,
        attach,
        0,
        seta,
      );
      m.normal(i, -uy, ux, 0);
      return i;
    };
    m.sheet(point(0, CILIA.width), point(0, -CILIA.width), point(1, 0));
  }
}
