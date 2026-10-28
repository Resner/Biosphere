// One merged geometry per creature (M3 T10, ADR 0018): a loft along the spine for the body and a
// swept tube for each appendage and branch. The vertex counts equal `estimateVertices`, so the
// development caps are the render budget. Plates and the mouth add no vertices: they mark body
// vertices through `aPart` and lift them. Positions are in the body frame, x forward, in core radii.

import * as THREE from 'three';
import type { Appendage, BodyPlan, Detail, PlanSegment } from '../genome/develop';
import { clamp } from '../sim/math';
import { RULES } from '../sim/rules';

const { cos, sin, sqrt, PI } = Math;
const TAU = 2 * PI;
const V = RULES.develop.vertices;
const BRANCH = RULES.develop.branchScale;

/** The body is this much thinner than wide, so the creature reads as a flat swimmer from above. */
export const BODY_DEPTH = 0.85;
const TUBE_DEPTH = 0.8;
/** Total turn of a tube with curvature ±1, in radians. */
const CURVE = 1.2;
/** Share of the bend radius a tube may fill. */
const FOLD = 0.8;
/** Where on its parent a branch grows, and how far it fans out (radians): development's, so membranes meet the tubes. */
const BRANCH_AT = RULES.develop.branchAt;
const BRANCH_FAN = RULES.develop.branchFan;
/** The tip cap is this many end radii long for a blunt tip, plus this many more for a sharp one. */
const CAP_BLUNT = 0.3;
const CAP_SHARP = 2.2;
const CAP_SHARE = 0.3;

/** What a vertex belongs to, the low two bits of `aPart`; the rest is the appendage number (0 for the body). */
export const PART_BODY = 0;
export const PART_APPENDAGE = 1;
export const PART_PLATE = 2;
export const PART_MOUTH = 3;
export const partKind = (aPart: number): number => aPart % 4;
export const partId = (aPart: number): number => Math.floor(aPart / 4);

/** Half the body's width at `x`: the union of the segment ellipses. */
export function bodyHalfWidth(segments: readonly PlanSegment[], x: number): number {
  let w = 0;
  for (const s of segments) {
    const u = (x - s.x) / s.rx;
    if (u > -1 && u < 1) w = Math.max(w, s.ry * sqrt(1 - u * u));
  }
  return w;
}

class Mesh {
  readonly position: number[] = [];
  readonly uv: number[] = [];
  readonly spine: number[] = [];
  readonly attach: number[] = [];
  readonly weight: number[] = [];
  readonly part: number[] = [];
  readonly index: number[] = [];

  get count(): number {
    return this.part.length;
  }

  vertex(
    p: readonly [number, number, number],
    uv: readonly [number, number],
    gait: { spine: number; attach: number; weight: number },
    part: number,
  ): void {
    this.position.push(p[0], p[1], p[2]);
    this.uv.push(uv[0], uv[1]);
    this.spine.push(gait.spine);
    this.attach.push(gait.attach);
    this.weight.push(gait.weight);
    this.part.push(part);
  }
}

interface Spine {
  front: number;
  rear: number;
}

const spineAt = (s: Spine, x: number): number => clamp((s.front - x) / (s.front - s.rear), 0, 1);

function addBody(m: Mesh, plan: BodyPlan, spine: Spine, detail: Detail): void {
  const { bodyRings, bodyRing } = V[detail];
  const rings: { x: number; seg: number }[] = [];
  plan.segments.forEach((s, seg) => {
    for (let k = 0; k < bodyRings; k++)
      rings.push({ x: s.x + s.rx * cos((PI * k) / (bodyRings - 1)), seg });
  });
  // Rear to front; segments overlap, so rings from neighbours interleave into one continuous loft.
  rings.sort((a, b) => a.x - b.x || a.seg - b.seg);
  const mouthReach = plan.mouth.radius * 0.5;
  const first = m.count;
  for (const ring of rings) {
    const w = bodyHalfWidth(plan.segments, ring.x);
    const plate = plan.plates.find((p) => p.segment === ring.seg);
    const mouth = ring.x >= spine.front - mouthReach;
    const spineHere = spineAt(spine, ring.x);
    for (let j = 0; j < bodyRing; j++) {
      const phi = (TAU * j) / bodyRing;
      const fromTop = Math.abs(((phi - PI / 2 + 3 * PI) % TAU) - PI);
      const plated = plate !== undefined && fromTop <= plate.coverage * PI;
      const kind = mouth ? PART_MOUTH : plated ? PART_PLATE : PART_BODY;
      const lift = kind === PART_PLATE && plate ? 1 + plate.thickness : 1;
      m.vertex(
        [ring.x, w * cos(phi), w * BODY_DEPTH * lift * sin(phi)],
        [j / bodyRing, spineHere],
        { spine: spineHere, attach: spineHere, weight: 0 },
        kind,
      );
    }
  }
  for (let r = 0; r + 1 < rings.length; r++) {
    for (let j = 0; j < bodyRing; j++) {
      const a = first + r * bodyRing + j;
      const b = first + r * bodyRing + ((j + 1) % bodyRing);
      m.index.push(a, b, a + bodyRing, b, b + bodyRing, a + bodyRing);
    }
  }
}

/** A path in the xy plane whose heading turns evenly: `x`, `y`, heading at `t` (0..1), length `len`. */
interface Path {
  x0: number;
  y0: number;
  heading: number;
  turn: number;
  len: number;
}

function pathAt(p: Path, t: number): { x: number; y: number; heading: number } {
  const heading = p.heading + p.turn * t;
  if (Math.abs(p.turn) < 1e-6) {
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
  /** Base radius; it falls linearly by `taper` along the tube. */
  radius: number;
  taper: number;
  /** Length of the tip cap beyond the path's end. */
  cap: number;
  /** The spine position the part hangs from, its own `aPart`, and the weight at its base. */
  attach: number;
  part: number;
  base: number;
  side: 1 | -1;
}

function addTube(m: Mesh, spine: Spine, tube: Tube, rings: number, ring: number): void {
  const { path, side } = tube;
  const first = m.count;
  for (let i = 0; i < rings; i++) {
    const t = i / (rings - 1);
    const at = pathAt(path, t);
    const r = tube.radius * (1 - tube.taper * t);
    for (let j = 0; j < ring; j++) {
      const phi = (TAU * j) / ring;
      const across = r * cos(phi);
      m.vertex(
        [
          at.x - across * sin(at.heading),
          side * (at.y + across * cos(at.heading)),
          r * TUBE_DEPTH * sin(phi),
        ],
        [j / ring, t],
        {
          spine: spineAt(spine, at.x),
          attach: tube.attach,
          weight: tube.base + (1 - tube.base) * t,
        },
        tube.part,
      );
    }
  }
  const tipAt = pathAt(path, 1);
  const { cap } = tube;
  m.vertex(
    [tipAt.x + cap * cos(tipAt.heading), side * (tipAt.y + cap * sin(tipAt.heading)), 0],
    [0.5, 1],
    { spine: spineAt(spine, tipAt.x), attach: tube.attach, weight: 1 },
    tube.part,
  );
  // Left-side tubes wind outward as built; the mirror image flips the winding.
  const wind = (a: number, b: number, c: number): void => {
    if (side === 1) m.index.push(a, b, c);
    else m.index.push(a, c, b);
  };
  for (let i = 0; i + 1 < rings; i++) {
    for (let j = 0; j < ring; j++) {
      const a = first + i * ring + j;
      const b = first + i * ring + ((j + 1) % ring);
      wind(a, b, a + ring);
      wind(b, b + ring, a + ring);
    }
  }
  const last = first + (rings - 1) * ring;
  const tipVertex = last + ring;
  for (let j = 0; j < ring; j++) wind(last + j, last + ((j + 1) % ring), tipVertex);
}

function addAppendage(
  m: Mesh,
  plan: BodyPlan,
  spine: Spine,
  a: Appendage,
  id: number,
  detail: Detail,
): void {
  const { jointRings, partRing } = V[detail];
  const rings = a.joints * jointRings + 1;
  const seg = plan.segments[a.segment] as PlanSegment;
  const x = seg.x + seg.rx * cos(a.angle);
  const radius = a.width / 2;
  // The tip cap counts toward the part's length, so no part reaches past what development allowed.
  const cap = Math.min(
    radius * (1 - a.taper) * (CAP_BLUNT + CAP_SHARP * a.tip),
    CAP_SHARE * a.length,
  );
  const length = a.length - cap;
  // A tube cannot bend tighter than its own radius, or its inside folds over itself.
  const fold = (FOLD * length) / radius;
  const parent: Tube = {
    // The base ring sits on the body surface, so a part never floats off the loft.
    path: {
      x0: x,
      y0: bodyHalfWidth(plan.segments, x),
      heading: a.dir,
      turn: clamp(a.curvature * CURVE, -fold, fold),
      len: length,
    },
    radius,
    taper: a.taper,
    cap,
    attach: spineAt(spine, x),
    part: id * 4 + PART_APPENDAGE,
    base: 0,
    side: a.side,
  };
  addTube(m, spine, parent, rings, partRing);
  const from = pathAt(parent.path, BRANCH_AT);
  for (let b = 0; b < a.branches; b++) {
    const fan = b === 0 ? BRANCH_FAN : -BRANCH_FAN;
    addTube(
      m,
      spine,
      {
        ...parent,
        path: {
          x0: from.x,
          y0: from.y,
          heading: from.heading + fan,
          turn: parent.path.turn,
          len: length * BRANCH,
        },
        radius: radius * (1 - a.taper * BRANCH_AT) * BRANCH,
        cap: cap * BRANCH,
        base: BRANCH_AT,
      },
      rings,
      partRing,
    );
  }
}

/** One indexed geometry for the whole creature. Attributes: position, normal, uv, aSpine, aAttach, aWeight, aPart. */
export function buildCreatureGeometry(plan: BodyPlan, detail: Detail): THREE.BufferGeometry {
  const spine: Spine = {
    front: Math.max(...plan.segments.map((s) => s.x + s.rx)),
    rear: Math.min(...plan.segments.map((s) => s.x - s.rx)),
  };
  const m = new Mesh();
  addBody(m, plan, spine, detail);
  plan.appendages.forEach((a, i) => {
    addAppendage(m, plan, spine, a, i + 1, detail);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(m.position, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(m.uv, 2));
  g.setAttribute('aSpine', new THREE.Float32BufferAttribute(m.spine, 1));
  g.setAttribute('aAttach', new THREE.Float32BufferAttribute(m.attach, 1));
  g.setAttribute('aWeight', new THREE.Float32BufferAttribute(m.weight, 1));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(m.part, 1));
  g.setIndex(m.index);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}
