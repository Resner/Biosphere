// The parts (M6 T10): tapered tubes with joint beads, bulb tips and chela fingers, thin ribbons for
// setae, double-sided sheets for the membranes and lens spheres for the eyes; then the inner anatomy
// (M6 T12) and the rare glints (M6 T13).

import {
  type Appendage,
  type BodyPlan,
  dirOf,
  type Membrane,
  type PlanSegment,
  partCurve,
  peak,
  rootOf,
} from '../genome/develop';
import { clamp } from '../sim/math';
import { createRng, seedFromString } from '../sim/prng';
import { RULES } from '../sim/rules';
import type { Anatomy, OrganKind } from './anatomy';
import type { MeshDetail, OrganDetail } from './creature-detail';
import { bodyMotion, inside, nearestStation, type Spine } from './creature-loft';
import {
  METACHRONAL,
  type Mesh,
  MOTION_ANTENNA,
  MOTION_BEAT,
  MOTION_TENTACLE,
  MOTION_WING,
  type Motion,
  NO_MOTION,
  PART_APPENDAGE,
  PART_CHAMBER,
  PART_DROPLET,
  PART_EYE,
  PART_GLINT,
  PART_GUT,
  PART_HEART,
  PART_KINDS,
  PART_MEMBRANE,
  PART_PIGMENT,
  PART_SETA,
  PART_SETULE,
  PART_STALK,
} from './mesh-buffer';

const { cos, sin, sqrt, atan2, hypot, abs, min, max, PI } = Math;
const TAU = 2 * PI;

const BRANCH = RULES.develop.branchScale;
const BOUNDS = RULES.develop.caps.bounds;

/** Glints sit at least this far apart (core radii), so each reads as its own star. */
export const GLINT_GAP = 0.18;
/** An organ ball is this flat; the gut this flat. */
const ORGAN_DEPTH = 0.5;

const TUBE_DEPTH = 0.8;
/** Where on its parent a branch grows, and how far it fans out (radians): development's, so membranes meet the tubes. */
const BRANCH_AT = RULES.develop.branchAt;
const BRANCH_FAN = RULES.develop.branchFan;

/** The tip cap is this many end radii long for a blunt tip, plus this many more for a sharp one: development's (`partCurve`). */
const CAP_BLUNT = RULES.develop.part.capBlunt;
const CAP_SHARP = RULES.develop.part.capSharp;
const CAP_SHARE = RULES.develop.part.capShare;
/** Every inner joint swells by at least this share, so jointed parts read as jointed. */
const JOINT_BEAD = 0.3;
/**
 * A paddle tip (its share of the paddle peak, as stats price it) widens toward its blade, up to
 * 1 + this times its base radius at the tip, and does not taper (M6b T7): a thin leg still ends in
 * a broad paddle.
 */
const BLADE = 1.5;

/** A part's tube radius at share `t` along it: tapered, or widening into a paddle's blade. */
export function partRadius(r0: number, taper: number, tip: number, t: number): number {
  const blade = peak(tip, RULES.stats.paddleTip, RULES.stats.paddleSpread);
  return r0 * (1 - taper * (1 - blade) * t) * (1 + BLADE * blade * t * t);
}
/**
 * A chela's palm swells by up to this share; its movable finger opens this far (radians) and is this
 * long and wide. Look pass 2 enlarged the claw (palm 0.8, finger 0.9 long and 0.55 wide), which was
 * lost in the setae at default zoom (M6 T21).
 */
const PALM = 1.3;
const FINGER_OPEN = 0.5;
const FINGER_LENGTH = 1.1;
const FINGER_WIDTH = 0.8;
const FINGER_TAPER = 0.8;
/**
 * A bulb tip is drawn at this share of its plan radius, as a small solid pearl (look pass 2): at its
 * full size it read as a large glass bubble and bulbs clumped into bubble clusters.
 */
const PEARL = 0.55;
/** `uv.x` tags (`addBall`): a pearl tip; an organ's number is `ORGAN_TAG` × (its index + 1). */
const PEARL_TAG = 2;
export const ORGAN_TAG = 2;
/** An accent organ's `uv.y` runs from this, not 0 (M6b T3): the shader gives it the accent hue. */
const ACCENT_V = 2;

/**
 * A bristle's base half-width, and its angle off its part's chord: near square at the base, swept
 * toward the tip along the part, so the bristles fan apart (on a curved part's inner side too).
 */
const SETA_WIDTH = 0.022;
const SETA_BASE = 1.5;
const SETA_SWEEP = 0.9;
/**
 * Plumose setae (look pass 5): pairs of setules at these shares along each bristle (drawn on the
 * 5-vertex rungs only), each `SETULE_LENGTH` of the bristle long near its root, shorter toward its
 * tip, angled `SETULE_ANGLE` off it toward the tip, its root `SETULE_BASE` of the bristle wide.
 */
const SETULES_AT = [0.3, 0.55, 0.8] as const;
const SETULE_LENGTH = 0.35;
const SETULE_ANGLE = 0.7;
const SETULE_COS = Math.cos(SETULE_ANGLE);
const SETULE_SIN = Math.sin(SETULE_ANGLE);
const SETULE_BASE = 0.06;
const SETULE_WIDTH = 0.5;
/** An eye is this flat; its stalk this share of its radius wide. */
const EYE_DEPTH = 0.8;
const STALK_WIDTH = 0.3;
/** An eye takes this many more sides than a bulb above the lowest level (look pass 3); the low level keeps its budget. */
const EYE_SIDES = 4;

/** A part pointing within this angle of forward is an antenna. */
const ANTENNA_CONE = PI / 3;

// ---------------------------------------------------------------------------------------------
// Parts

/** A path in the xy plane whose heading turns evenly: start, heading, total turn and length. */
interface Path {
  x0: number;
  y0: number;
  heading: number;
  turn: number;
  len: number;
}

function pathAt(p: Path, t: number): { x: number; y: number; heading: number } {
  const heading = p.heading + p.turn * t;
  if (abs(p.turn) < 1e-6) {
    return { x: p.x0 + p.len * t * cos(p.heading), y: p.y0 + p.len * t * sin(p.heading), heading };
  }
  return {
    x: p.x0 + (p.len * (sin(heading) - sin(p.heading))) / p.turn,
    y: p.y0 - (p.len * (cos(heading) - cos(p.heading))) / p.turn,
    heading,
  };
}

interface Tube {
  path: Path;
  /** The radius at path share `t` of ring `i`. */
  radius: (t: number, i: number) => number;
  /** Length of the tip cap beyond the path's end. */
  cap: number;
  /** The spine share the part hangs from, its own `aPart`, and the weight at its base (null: rigid, 0 throughout). */
  attach: number;
  part: number;
  base: number | null;
}

/** A closed tube: `rings` rings along its path, then the tip vertex. */
function addTube(m: Mesh, tube: Tube, rings: number, ring: number): void {
  const { path } = tube;
  const first = m.count;
  for (let i = 0; i < rings; i++) {
    const t = i / (rings - 1);
    const at = pathAt(path, t);
    // A swelling never pushes a part past the bounds, where the plan keeps it.
    const r = min(tube.radius(t, i), max(tube.radius(t, -1), BOUNDS - hypot(at.x, at.y)));
    const weight = tube.base === null ? 0 : tube.base + (1 - tube.base) * t;
    for (let j = 0; j < ring; j++) {
      const phi = (TAU * j) / ring;
      const across = r * cos(phi);
      m.vertex(
        at.x - across * sin(at.heading),
        at.y + across * cos(at.heading),
        r * TUBE_DEPTH * sin(phi),
        j / ring,
        t,
        tube.attach,
        tube.attach,
        weight,
        tube.part,
      );
    }
  }
  const tip = pathAt(path, 1);
  const tipVertex = m.vertex(
    tip.x + tube.cap * cos(tip.heading),
    tip.y + tube.cap * sin(tip.heading),
    0,
    0.5,
    1,
    tube.attach,
    tube.attach,
    tube.base === null ? 0 : 1,
    tube.part,
  );
  m.stitch(first, rings, ring);
  const last = first + (rings - 1) * ring;
  for (let j = 0; j < ring; j++) m.tri(last + j, last + ((j + 1) % ring), tipVertex);
}

/**
 * A sphere of `lon` vertices round its equator (`lon` ÷ 2 bands), squashed to `depth` in z, along
 * `heading`. `u0` (a whole even number) is added to every `uv.x`: the shader reads it as a tag (a
 * pearl tip, an organ's number) and the markings, which repeat a whole number of times, ignore it.
 */
function addBall(
  m: Mesh,
  x: number,
  y: number,
  radius: number,
  heading: number,
  depth: number,
  lon: number,
  gait: { spine: number; attach: number; weight: number; part: number },
  u0 = 0,
  v0 = 0,
): void {
  const lat = max(2, lon >> 1);
  const [fx, fy] = [cos(heading), sin(heading)];
  const vertex = (a: number, across: number, z: number, u: number, v: number): number =>
    m.vertex(
      x + fx * a - fy * across,
      y + fy * a + fx * across,
      z,
      u,
      v,
      gait.spine,
      gait.attach,
      gait.weight,
      gait.part,
    );
  const rear = vertex(-radius, 0, 0, u0 + 0.5, v0);
  const first = m.count;
  for (let i = 1; i < lat; i++) {
    const theta = (PI * i) / lat;
    const a = -radius * cos(theta);
    const half = radius * sin(theta);
    for (let j = 0; j < lon; j++) {
      const phi = (TAU * j) / lon;
      vertex(a, half * cos(phi), half * depth * sin(phi), u0 + j / lon, v0 + i / lat);
    }
  }
  const front = vertex(radius, 0, 0, u0 + 0.5, v0 + 1);
  m.stitch(first, lat - 1, lon);
  const last = first + (lat - 2) * lon;
  for (let j = 0; j < lon; j++) {
    const k = (j + 1) % lon;
    m.tri(first + j, rear, first + k);
    m.tri(last + j, last + k, front);
  }
}

/**
 * Where part `a` leaves its segment, the way it grows, the spine share it hangs from, and how it
 * moves: a radial body's parts are tentacles, a webbed part (or one a membrane spans to) a wing, a
 * part pointing forward an antenna, and any other part beats, rowing as far as it stands out to
 * the side and whipping as far as it lies along the spine. Legs of one module beat `METACHRONAL`
 * apart per segment. The gain is the part's beat; `fitReach` lowers it for long parts.
 */
export function rootFrame(plan: BodyPlan, spine: Spine, a: Appendage, webbed: boolean) {
  const s = plan.segments[a.segment] as PlanSegment;
  const root = rootOf(s, a.angle, a.side);
  const dir = dirOf(s, a);
  const st = nearestStation(spine, root.x, root.y);
  // The spine's forward at the root is its left normal turned back a right angle.
  const [fx, fy] = [st.ny, -st.nx];
  const rel = atan2(fx * dir.y - fy * dir.x, fx * dir.x + fy * dir.y);
  const motion = plan.form.radial
    ? MOTION_TENTACLE
    : webbed
      ? MOTION_WING
      : abs(rel) < ANTENNA_CONE
        ? MOTION_ANTENNA
        : MOTION_BEAT;
  const offset =
    motion === MOTION_BEAT
      ? TAU * a.phase - METACHRONAL * a.segment
      : motion === MOTION_ANTENNA
        ? TAU * a.phase
        : 0;
  const gait: Motion = {
    spineX: st.nx,
    spineY: st.ny,
    rootX: root.x,
    rootY: root.y,
    motion,
    offset,
    gain: a.side * (0.2 + 0.8 * clamp(a.beat, 0, 1)),
    row: motion === MOTION_BEAT ? abs(sin(rel)) : 0,
  };
  return { attach: st.s, gait };
}

/**
 * A part's main tube: development's centre line (`partCurve`: an arc from the root, then the tip cap
 * beyond it, which counts toward the part's length), its radius and cap.
 */
function partPath(plan: BodyPlan, a: Appendage) {
  const c = partCurve(plan.segments[a.segment] as PlanSegment, a);
  const path: Path = c;
  return { path, radius: a.width / 2, cap: c.cap, length: c.len };
}

/** The point at share `t` (0 root, 1 the end of the tube before its cap) along part `a`'s main tube. */
export function partPoint(plan: BodyPlan, a: Appendage, t: number): { x: number; y: number } {
  const at = pathAt(partPath(plan, a).path, t);
  return { x: at.x, y: at.y };
}

export function addAppendage(
  m: Mesh,
  plan: BodyPlan,
  spine: Spine,
  a: Appendage,
  frame: ReturnType<typeof rootFrame>,
  id: number,
  d: MeshDetail,
): void {
  const { attach } = frame;
  m.gait = frame.gait;
  const part = id * PART_KINDS + PART_APPENDAGE;
  const { path, radius, cap, length } = partPath(plan, a);
  const rings = d.jointRings > 0 ? a.joints * d.jointRings + 1 : 2;
  const bead = 1 + max(JOINT_BEAD, a.beads);
  const joint = (i: number): boolean =>
    d.jointRings > 0 && i > 0 && i < rings - 1 && i % d.jointRings === 0;
  // A chela: the last joint is the fixed finger, its palm swells, and a movable finger opposes it.
  const palmAt = a.joints > 1 ? (a.joints - 1) / a.joints : 0.5;
  const palm = (t: number): number =>
    a.chela > 0 ? 1 + PALM * a.chela * max(0, 1 - abs(t - palmAt) / 0.3) : 1;
  // A part thinned to fit its segment carries its bulb thinned alike (M6b T7): the plan's bulb is
  // the gene's, which the stats price.
  const bulbRadius = a.girth > 0 ? (a.bulb * a.width) / a.girth : a.bulb;
  const flatBulb = bulbRadius > 0 && d.ball === 0;
  const profile =
    (r0: number, taper: number, bulb: number) =>
    (t: number, i: number): number => {
      const r = partRadius(r0, taper, a.tip, t);
      if (i < 0) return r;
      if (flatBulb && i === rings - 1) return max(r, bulb * PEARL);
      return r * (joint(i) ? bead : 1) * palm(t);
    };
  const main: Tube = {
    path,
    radius: profile(radius, a.taper, bulbRadius),
    cap: flatBulb ? 0 : cap,
    attach,
    part,
    base: 0,
  };
  addTube(m, main, rings, d.partRing);
  const gait = { spine: attach, attach, weight: 1, part };
  if (bulbRadius > 0 && !flatBulb) {
    const end = pathAt(path, 1);
    addBall(m, end.x, end.y, bulbRadius * PEARL, end.heading, 1, d.ball, gait, PEARL_TAG);
  }
  if (a.chela > 0) {
    const from = pathAt(path, palmAt);
    const side = path.turn >= 0 ? 1 : -1;
    const fingerLength = FINGER_LENGTH * (1 - palmAt) * length;
    const fingerRadius = FINGER_WIDTH * radius * (1 - a.taper * palmAt);
    addTube(
      m,
      {
        path: {
          x0: from.x,
          y0: from.y,
          heading: from.heading - side * FINGER_OPEN * a.chela,
          turn: side * 2 * FINGER_OPEN * a.chela,
          len: fingerLength,
        },
        radius: (t) => fingerRadius * (1 - FINGER_TAPER * t),
        cap: min(
          fingerRadius * (1 - FINGER_TAPER) * (CAP_BLUNT + CAP_SHARP),
          CAP_SHARE * fingerLength,
        ),
        attach,
        part,
        base: palmAt,
      },
      max(2, d.jointRings + 1),
      d.partRing,
    );
  }
  const from = pathAt(path, BRANCH_AT);
  for (let b = 0; b < a.branches; b++) {
    const fan = a.side * (b === 0 ? BRANCH_FAN : -BRANCH_FAN);
    const branchPath: Path = {
      x0: from.x,
      y0: from.y,
      heading: from.heading + fan,
      turn: path.turn,
      len: length * BRANCH,
    };
    const branchBulb = bulbRadius * BRANCH;
    addTube(
      m,
      {
        path: branchPath,
        radius: profile(
          partRadius(radius, a.taper, a.tip, BRANCH_AT) * BRANCH,
          a.taper,
          branchBulb,
        ),
        cap: flatBulb ? 0 : cap * BRANCH,
        attach,
        part,
        base: BRANCH_AT,
      },
      rings,
      d.partRing,
    );
    if (branchBulb > 0 && !flatBulb) {
      const end = pathAt(branchPath, 1);
      addBall(m, end.x, end.y, branchBulb * PEARL, end.heading, 1, d.ball, gait, PEARL_TAG);
    }
  }
  addSetae(m, plan, a, path, length, attach, id, d);
}

/** Which of `count` bristles a share draws: evenly spread, all of them at 1. */
const drawn = (k: number, share: number): boolean =>
  Math.ceil((k + 1) * share) > Math.ceil(k * share);

/** The part's bristles: thin tapered ribbons, alternating sides (away from the body), fanned toward the tip. */
function addSetae(
  m: Mesh,
  plan: BodyPlan,
  a: Appendage,
  path: Path,
  length: number,
  attach: number,
  id: number,
  d: MeshDetail,
): void {
  if (a.setae < 1 || d.setae <= 0) return;
  const part = id * PART_KINDS + PART_SETA;
  const end = pathAt(path, 1);
  const chord = atan2(end.y - path.y0, end.x - path.x0);
  for (let k = 0; k < a.setae; k++) {
    if (!drawn(k, d.setae)) continue;
    const share = (k + 0.5) / a.setae;
    const t = min(1, (share * a.length) / length);
    const at = pathAt(path, t);
    const off = SETA_BASE - SETA_SWEEP * share;
    // Sides alternate, but a bristle that would grow into the body grows from the other side, and
    // one that would grow into it either way (a part in the eye of a coil) is not drawn: seen
    // through the clear shell, such bristles piled into a white cloud inside the body.
    const into = (side: number): boolean => {
      const angle = chord + side * off;
      const [x, y] = [at.x + a.setaeLength * cos(angle), at.y + a.setaeLength * sin(angle)];
      return plan.segments.some((seg) => inside(seg, x, y));
    };
    const side = k % 2 === 0 ? 1 : -1;
    if (into(side) && into(-side)) continue;
    const angle = chord + (into(side) ? -side : side) * off;
    const [dx, dy] = [cos(angle), sin(angle)];
    const [nx, ny] = [-dy, dx];
    // A bristle stops at the bounds, where development keeps every part.
    const ahead = at.x * dx + at.y * dy;
    const room =
      -ahead + sqrt(max(0, ahead * ahead - (at.x * at.x + at.y * at.y - BOUNDS * BOUNDS)));
    const len = max(0, min(a.setaeLength, room));
    const point = (share: number, half: number, v: number, kind = part): number => {
      m.flutterAt = len * share;
      const i = m.vertex(
        at.x + dx * len * share + nx * half,
        at.y + dy * len * share + ny * half,
        0,
        0.5 + 0.5 * Math.sign(half),
        v,
        attach,
        attach,
        t,
        kind,
      );
      m.normal(i, nx, ny, 0);
      return i;
    };
    const l0 = point(0, SETA_WIDTH, 0);
    const r0 = point(0, -SETA_WIDTH, 0);
    if (d.setaVertices >= 5) {
      const l1 = point(0.5, SETA_WIDTH * 0.5, 0.5);
      const r1 = point(0.5, -SETA_WIDTH * 0.5, 0.5);
      const tip = point(1, 0, 1);
      m.sheet(l0, r0, r1);
      m.sheet(l0, r1, l1);
      m.sheet(l1, r1, tip);
      // Plumose setae (look pass 5): fine setules leave each bristle in pairs, angled toward its
      // tip, so a bristled leg reads as a feathered comb (reference 04) and not as a few spokes.
      const setule = id * PART_KINDS + PART_SETULE;
      for (const along of SETULES_AT) {
        const reach = len * SETULE_LENGTH * (1 - 0.5 * along);
        const [cx, cy] = [at.x + dx * len * along, at.y + dy * len * along];
        for (const side of [1, -1] as const) {
          const [sx, sy] = [SETULE_COS, side * SETULE_SIN];
          const [ex, ey] = [cx + (dx * sx - dy * sy) * reach, cy + (dy * sx + dx * sy) * reach];
          // Like its bristle, a setule stays within the bounds.
          if (hypot(ex, ey) > BOUNDS) continue;
          const b0 = point(along, SETA_WIDTH * SETULE_WIDTH, along, setule);
          const b1 = point(along + SETULE_BASE, -SETA_WIDTH * SETULE_WIDTH, along, setule);
          m.flutterAt = len * along;
          const end = m.vertex(ex, ey, 0, 0.5, along, attach, attach, t, setule);
          m.normal(end, nx, ny, 0);
          m.sheet(b0, b1, end);
        }
      }
    } else {
      const tip = point(1, 0, 1);
      m.sheet(l0, r0, tip);
    }
  }
  m.flutterAt = 0;
}

/**
 * A membrane: a fan of rows from its first corner (the root of its part) out to its far edge, so
 * `uv` runs 0..1 across the sheet and 0..1 out from the root (veins follow both).
 */
export function addMembrane(
  m: Mesh,
  plan: BodyPlan,
  sheet: Membrane,
  frame: ReturnType<typeof rootFrame>,
  d: MeshDetail,
): void {
  const { attach } = frame;
  m.gait = frame.gait;
  const owner = plan.appendages[sheet.part] as Appendage;
  const part = (sheet.part + 1) * PART_KINDS + PART_MEMBRANE;
  const pts = sheet.points;
  const p0 = pts[0] as { x: number; y: number };
  const edges = pts.length - 2;
  const rows = d.web;
  const cols = edges * rows;
  const reach = min(1, owner.webbing);
  const outer = (c: number): { x: number; y: number } => {
    const e = min(edges - 1, Math.floor(c / rows));
    const w = c / rows - e;
    const [a, b] = [pts[e + 1], pts[e + 2]] as [{ x: number; y: number }, { x: number; y: number }];
    return { x: a.x + (b.x - a.x) * w, y: a.y + (b.y - a.y) * w };
  };
  const vertex = (x: number, y: number, u: number, v: number): number => {
    const i = m.vertex(x, y, 0, u, v, attach, attach, v * reach, part);
    m.normal(i, 0, 0, 1);
    return i;
  };
  const root = vertex(p0.x, p0.y, 0, 0);
  const first = m.count;
  for (let r = 1; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const o = outer(c);
      const f = r / rows;
      vertex(p0.x + (o.x - p0.x) * f, p0.y + (o.y - p0.y) * f, c / cols, f);
    }
  }
  const row = cols + 1;
  for (let c = 0; c < cols; c++) m.sheet(root, first + c, first + c + 1);
  for (let r = 0; r + 1 < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = first + r * row + c;
      m.sheet(a, a + row, a + row + 1);
      m.sheet(a, a + row + 1, a + 1);
    }
  }
}

/** Two lens spheres on the head, each on its stalk. */
export function addEyes(m: Mesh, plan: BodyPlan, spine: Spine, d: MeshDetail): void {
  const e = plan.eyes;
  if (e.count < 2) return;
  const head = plan.segments[0] as PlanSegment;
  const st = nearestStation(spine, e.x, e.y);
  const attach = st.s;
  m.gait = bodyMotion(plan, st);
  const gait = { spine: attach, attach, weight: 0, part: PART_EYE };
  for (const side of [1, -1] as const) {
    const [x, y] = [e.x, side * e.y];
    const root = rootOf(head, e.angle, side);
    const len = hypot(x - root.x, y - root.y);
    // An eye set into the head (look pass 5) hides what stalk it has: one shows only past the eye.
    if (len > e.size + 0.02) {
      const r = e.size * STALK_WIDTH;
      addTube(
        m,
        {
          path: { x0: root.x, y0: root.y, heading: atan2(y - root.y, x - root.x), turn: 0, len },
          radius: () => r,
          cap: 0,
          attach,
          part: PART_STALK,
          base: null,
        },
        2,
        min(d.partRing, 6),
      );
    }
    // Rounder than a bulb (look pass 3): a big dark eye with too few sides reads as a polygon.
    addBall(
      m,
      x,
      y,
      e.size,
      0,
      EYE_DEPTH,
      max(EYE_SIDES, d.ball > EYE_SIDES ? d.ball + EYE_SIDES : d.ball),
      gait,
    );
  }
}

const ORGAN_PART: Readonly<Record<OrganKind, number>> = {
  chamber: PART_CHAMBER,
  droplet: PART_DROPLET,
  heart: PART_HEART,
  ganglion: PART_HEART,
  pigment: PART_PIGMENT,
};

/**
 * The inner anatomy (M6 T12): the gut as a thin tube along its line, then each organ as a flat
 * ball. They ride the body (its wave or a bell's pulse) where they lie, like the body's own rings.
 */
export function addOrgans(
  m: Mesh,
  plan: BodyPlan,
  spine: Spine,
  anatomy: Anatomy,
  o: OrganDetail,
): void {
  const { gut } = anatomy;
  if (gut.length >= 2) {
    const first = m.count;
    for (let k = 0; k < o.gutRings; k++) {
      const at = (k / (o.gutRings - 1)) * (gut.length - 1);
      const i = min(gut.length - 2, Math.floor(at));
      const w = at - i;
      const [p, q] = [gut[i], gut[i + 1]] as [Anatomy['gut'][0], Anatomy['gut'][0]];
      const [x, y, r] = [p.x + (q.x - p.x) * w, p.y + (q.y - p.y) * w, p.r + (q.r - p.r) * w];
      const d = hypot(q.x - p.x, q.y - p.y) || 1;
      const [nx, ny] = [(p.y - q.y) / d, (q.x - p.x) / d];
      const st = nearestStation(spine, x, y);
      m.gait = bodyMotion(plan, st);
      for (let j = 0; j < o.gutRing; j++) {
        const phi = (TAU * j) / o.gutRing;
        const across = r * cos(phi);
        m.vertex(
          x + nx * across,
          y + ny * across,
          r * ORGAN_DEPTH * sin(phi),
          j / o.gutRing,
          k / (o.gutRings - 1),
          st.s,
          st.s,
          0,
          PART_GUT,
        );
      }
    }
    m.stitch(first, o.gutRings, o.gutRing);
  }
  anatomy.organs.forEach((organ, k) => {
    const st = nearestStation(spine, organ.x, organ.y);
    m.gait = bodyMotion(plan, st);
    addBall(
      m,
      organ.x,
      organ.y,
      organ.r,
      0,
      ORGAN_DEPTH,
      o.ball,
      { spine: st.s, attach: st.s, weight: 0, part: ORGAN_PART[organ.kind] },
      ORGAN_TAG * (k + 1),
      organ.accent ? ACCENT_V : 0,
    );
  });
}

/** How many rare glints a body carries (`glintsFor`), how large (core radii), and the genome hash that places them. */
export interface GlintPlan {
  count: number;
  size: number;
  seed: string;
}

export const NO_GLINT_PLAN: GlintPlan = { count: 0, size: 0, seed: '' };

/** Where a glint sits: on part `part` (-1: an organ) at share `t` of its main tube (its `aWeight`). */
export interface GlintSpot {
  x: number;
  y: number;
  part: number;
  t: number;
}

/**
 * Up to `count` glints of a body (M6 T13), seeded by `seed`: on its organs (not the eye pigment) and
 * on the joints of its parts' main tubes, in a shuffled order, each at least `GLINT_GAP` from those
 * before it. Fewer glints are the first of more, so a rarer tier only adds to them.
 */
export function glintSpots(
  plan: BodyPlan,
  anatomy: Anatomy,
  count: number,
  seed: string,
): GlintSpot[] {
  if (count <= 0) return [];
  const candidates: GlintSpot[] = anatomy.organs
    .filter((o) => o.kind !== 'pigment')
    .map((o) => ({ x: o.x, y: o.y, part: -1, t: 0 }));
  plan.appendages.forEach((a, part) => {
    const { path } = partPath(plan, a);
    for (let i = 1; i <= a.joints; i++) {
      const t = i / a.joints;
      const at = pathAt(path, t);
      candidates.push({ x: at.x, y: at.y, part, t });
    }
  });
  const rng = createRng(seedFromString(seed), 'glints');
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [candidates[i], candidates[j]] = [candidates[j] as GlintSpot, candidates[i] as GlintSpot];
  }
  const spots: GlintSpot[] = [];
  for (const c of candidates) {
    if (spots.length >= count) break;
    if (spots.every((s) => hypot(s.x - c.x, s.y - c.y) >= GLINT_GAP)) spots.push(c);
  }
  return spots;
}

/**
 * The glints as flat quads `size` core radii from their centre to each side. Each rides what it sits
 * on: an organ's glint the body where it lies, a joint's glint its part at the joint's weight. The
 * quad's uv runs 0..1 across it, plus 2 per glint in v, so the shader can tell them apart.
 */
export function addGlints(
  m: Mesh,
  plan: BodyPlan,
  spine: Spine,
  spots: readonly GlintSpot[],
  size: number,
  frames: readonly ReturnType<typeof rootFrame>[],
): void {
  spots.forEach((s, k) => {
    const frame = s.part >= 0 ? frames[s.part] : undefined;
    let attach: number;
    if (frame) {
      m.gait = frame.gait;
      attach = frame.attach;
    } else {
      const st = nearestStation(spine, s.x, s.y);
      m.gait = bodyMotion(plan, st);
      attach = st.s;
    }
    const part = (s.part + 1) * PART_KINDS + PART_GLINT;
    const corner = (u: number, v: number): number => {
      const i = m.vertex(
        s.x + (2 * u - 1) * size,
        s.y + (2 * v - 1) * size,
        0,
        u,
        v + 2 * k,
        attach,
        attach,
        s.t,
        part,
      );
      m.normal(i, 0, 0, 1);
      return i;
    };
    const [a, b, c, d] = [corner(0, 0), corner(1, 0), corner(1, 1), corner(0, 1)];
    m.glint(a, b, c);
    m.glint(a, c, d);
  });
  m.gait = NO_MOTION;
}
