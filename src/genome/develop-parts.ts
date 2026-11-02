// Development, parts stage: moved verbatim out of develop.ts (ADR 0045).

import { clamp, cos, length as hypot, lerp, PI, sin } from '../sim/math';
import { RULES } from '../sim/rules';
import { drawnWidth } from './develop-chain';
import {
  type Appendage,
  CURVATURE,
  D,
  LENGTH,
  maxAngle,
  type Part,
  type PlanSegment,
  type Point,
  peak,
  rootOf,
  TAPER,
  unit,
  WIDTH,
  X,
} from './develop-plan';
import type { Traits } from './express';

/** Parts root along the front `rooms` segments (a coil's outer whorl, M6b T7; else all of them). */
export function buildParts(traits: Traits, scales: readonly number[], rooms: number): Part[] {
  const n = rooms;
  const parts: Part[] = [];
  let malformed = traits.defects.partScale;
  traits.modules.forEach((mod, slot) => {
    if (!mod.present) return;
    const p = mod.params;
    const x = mod.ext;
    const scale = malformed;
    malformed = 1; // only the first present module is the malformed part
    const pairs = 1 + Math.floor((p.pairs * D.caps.pairs) / 256);
    const t0 = unit(p.attachStart);
    const reach = unit(p.attachSpan) * (1 - t0);
    const gene = lerp(WIDTH[0], WIDTH[1], unit(p.thickness)) * scale;
    const tip = unit(p.tipShape);
    const base = baseLength(p.length) * scale;
    for (let k = 0; k < pairs; k++) {
      const t = pairs > 1 ? t0 + (reach * k) / (pairs - 1) : t0;
      const segment = Math.min(n - 1, Math.floor(t * n));
      const width = drawnWidth(gene, scales[segment] as number);
      parts.push({
        module: slot,
        segment,
        angle: D.angleMargin + (PI - 2 * D.angleMargin) * unit(p.angle),
        dir: 0,
        length: partLength(p.length) * scale,
        base,
        width,
        girth: gene,
        taper: lerp(TAPER[0], TAPER[1], unit(p.taper)),
        curvature: lerp(CURVATURE[0], CURVATURE[1], unit(p.curvature)),
        joints: 1 + Math.floor((p.joints * D.caps.joints) / 256),
        branches: Math.floor((p.branching * (D.caps.branches + 1)) / 256),
        tip,
        stiffness: unit(p.stiffness),
        beat: unit(p.beat),
        phase: unit(p.phase),
        webbing: x.webbing,
        setae: x.setaeLength > 0 ? Math.round(x.setaeDensity * X.setae.perPart) : 0,
        // The gene for now: `dress` turns it into a length once the part's reach is known.
        setaeLength: x.setaeLength,
        bulb: x.bulb > X.bulb.min ? x.bulb * gene * X.bulb.scale : 0,
        chela: x.chela > X.chela.min && isWeaponTip(tip) ? x.chela : 0,
        beads: x.beads,
        fringe: false,
        ...LAYOUT,
      });
    }
  });
  return parts;
}

/** A part's base length in core radii: the gene's plain range, which a part always keeps if it fits. */
export function baseLength(byte: number): number {
  return lerp(LENGTH[0], LENGTH[1], unit(byte));
}

/**
 * A part's gene length in core radii: `baseLength`, with a long end that reaches `long.max` at the
 * top of the gene (look pass 4), so antennae and tentacles can sweep round the body. Below
 * `long.knee` both agree.
 */
export function partLength(byte: number): number {
  const u = unit(byte);
  const past = Math.max(0, (u - D.long.knee) / (1 - D.long.knee));
  return baseLength(byte) + (D.long.max - LENGTH[1]) * past * past;
}

/** How much of a weapon a tip is (pointed to hooked tips); stats prices it, chela needs it above 0. */
export const weaponShare = (tip: number): number =>
  peak(tip, RULES.stats.weaponTip, RULES.stats.weaponSpread);

export const isWeaponTip = (tip: number): boolean => weaponShare(tip) > 0;

/** Layout state every part starts with, so all parts share one object shape (hot loops stay monomorphic). */
export const LAYOUT = { role: undefined, lo: 0, hi: PI, inner: false } as const;

/** No fine detail: a v1 part. */
export const PLAIN = { webbing: 0, setae: 0, setaeLength: 0, bulb: 0, chela: 0, beads: 0 } as const;

/**
 * Parts on one segment keep `minAngleGap` apart: later ones are pushed round, and one with no room
 * merges into its neighbour. Edits the parts in place; the stable sort keeps module and pair order
 * among equal angles.
 */
export function separate(parts: Part[], count: number, scales: readonly number[]): Part[] {
  const dropped = new Set<Part>();
  for (let s = 0; s < count; s++) {
    let prev: Part | undefined;
    for (const p of parts.filter((q) => q.segment === s).sort((x, y) => x.angle - y.angle)) {
      if (prev === undefined) {
        prev = p;
        continue;
      }
      const angle = Math.max(p.angle, prev.angle + D.minAngleGap);
      if (angle <= maxAngle + D.epsilon) {
        p.angle = angle;
        prev = p;
      } else {
        // The merged part is as broad as both genes, drawn as thin as its segment allows.
        prev.girth = Math.min(WIDTH[1], hypot(prev.girth, p.girth));
        prev.width = drawnWidth(prev.girth, scales[s] as number);
        prev.beat = Math.max(prev.beat, p.beat);
        dropped.add(p);
      }
    }
  }
  return parts.filter((p) => !dropped.has(p));
}

/** What a part's drawn centre line depends on. */
type Curved = Pick<
  Appendage,
  'angle' | 'dir' | 'side' | 'length' | 'width' | 'taper' | 'tip' | 'curvature' | 'webbing'
>;

/**
 * A part's centre line as the mesh draws it: from its root at `heading`, an arc of `len` that turns
 * by `turn` (signed, body frame), then a straight tip cap of `cap` along the end heading; `len` plus
 * `cap` is the part's length. The arc turns with curvature (less with webbing, so a webbed part
 * keeps to the rays its membrane spans) and never tighter than `fold` of its half-width.
 */
export interface PartCurve {
  x0: number;
  y0: number;
  heading: number;
  turn: number;
  len: number;
  cap: number;
}

/** A part's tip cap and how far its arc bends (left side; the right turns the other way). */
export function capAndBend(
  a: Omit<Curved, 'side' | 'angle' | 'dir'>,
  webbing = a.webbing,
): { cap: number; bend: number } {
  const P = D.part;
  const radius = a.width / 2;
  const cap = Math.min(
    radius * (1 - a.taper) * (P.capBlunt + P.capSharp * a.tip),
    P.capShare * a.length,
  );
  const fold = (P.fold * (a.length - cap)) / radius;
  return { cap, bend: clamp(a.curvature * P.turn * (1 - webbing), -fold, fold) };
}

export function partCurve(s: PlanSegment, a: Curved): PartCurve {
  const root = rootOf(s, a.angle, a.side);
  const { cap, bend } = capAndBend(a);
  return {
    x0: root.x,
    y0: root.y,
    heading: s.angle + a.side * a.dir,
    turn: a.side * bend,
    len: a.length - cap,
    cap,
  };
}

/** The point at share `t` of a centre line's arc, and its heading there. */
export function curveAt(c: PartCurve, t: number): Point & { heading: number } {
  const heading = c.heading + c.turn * t;
  if (Math.abs(c.turn) < 1e-6) {
    return { x: c.x0 + c.len * t * cos(c.heading), y: c.y0 + c.len * t * sin(c.heading), heading };
  }
  return {
    x: c.x0 + (c.len * (sin(heading) - sin(c.heading))) / c.turn,
    y: c.y0 - (c.len * (cos(heading) - cos(c.heading))) / c.turn,
    heading,
  };
}

/** Scratch for `arcFar`: the arc's end and its heading's cosine and sine there. */
const END = { x: 0, y: 0, c: 0, s: 0 };

/**
 * A part's bend as the reach needs it: the arc's signed turn (body frame), the cosine and sine of
 * that turn and of its share up to the fork, and of the branches' fan, so the probes of `fitPart` turn
 * headings by multiplication instead of trigonometry.
 */
export interface Bend {
  turn: number;
  ct: number;
  st: number;
  cb: number;
  sb: number;
  cf: number;
  sf: number;
}

const FAN_COS = cos(D.branchFan);

const FAN_SIN = sin(D.branchFan);

export function bendOf(bend: number, side: 1 | -1): Bend {
  if (bend === 0) return { turn: 0, ct: 1, st: 0, cb: 1, sb: 0, cf: FAN_COS, sf: side * FAN_SIN };
  return {
    turn: side * bend,
    ct: cos(bend),
    st: side * sin(bend),
    cb: cos(bend * D.branchAt),
    sb: side * sin(bend * D.branchAt),
    cf: FAN_COS,
    sf: side * FAN_SIN,
  };
}

/** The other side's bend: the same turn the other way. */
export const mirrorBend = (k: Bend): Bend => ({
  turn: -k.turn,
  ct: k.ct,
  st: -k.st,
  cb: k.cb,
  sb: -k.sb,
  cf: k.cf,
  sf: -k.sf,
});

/**
 * The farthest an arc from (`x`, `y`) heading (`c0`, `s0`), turning `k.turn` (less than π either
 * way) over `len`, then straight on for `cap`, lies from the core centre. Leaves its end in `END`.
 */
function arcFar(x: number, y: number, c0: number, s0: number, k: Bend, len: number, cap: number) {
  let far = hypot(x, y);
  if (Math.abs(k.turn) < 1e-6) {
    END.x = x + len * c0;
    END.y = y + len * s0;
    END.c = c0;
    END.s = s0;
  } else {
    const c1 = c0 * k.ct - s0 * k.st;
    const s1 = s0 * k.ct + c0 * k.st;
    const rho = len / k.turn;
    END.x = x + rho * (s1 - s0);
    END.y = y - rho * (c1 - c0);
    END.c = c1;
    END.s = s1;
    // The arc's circle: its point farthest from the core counts if the arc sweeps past it, that
    // is if the core-to-centre direction lies between the arc's two ends seen from the centre.
    const cx = x - rho * s0;
    const cy = y + rho * c0;
    const w = k.turn > 0 ? 1 : -1;
    const [ax, ay] = [x - cx, y - cy];
    const [bx, by] = [END.x - cx, END.y - cy];
    if (w * (ax * cy - ay * cx) >= 0 && w * (cx * by - cy * bx) >= 0) {
      far = Math.max(far, hypot(cx, cy) + Math.abs(rho));
    }
  }
  return Math.max(far, hypot(END.x, END.y), hypot(END.x + cap * END.c, END.y + cap * END.s));
}

type Reachable = Omit<Curved, 'side'> & Pick<Appendage, 'branches' | 'bulb'>;

/**
 * How far a part on `side` reaches from the core centre, as drawn: its centre line, its branches
 * (leaving the arc at `branchAt`, fanned `branchFan` either way, `branchScale` as long) and its bulb
 * tips. The width of the tubes is not counted, as in v1.
 */
export function partReach(s: PlanSegment, a: Reachable, side: 1 | -1): number {
  const { cap, bend } = capAndBend(a);
  const heading = s.angle + side * a.dir;
  const root = rootOf(s, a.angle, side);
  return reachFrom(root, cos(heading), sin(heading), bendOf(bend, side), cap, a, false);
}

/**
 * `partReach` from a known root, heading (`c0`, `s0`), bend and cap; with `rays`, also the part's
 * straight rays at full length, where the membranes of a webbed body run. It may stop early once
 * past `limit`: a caller that only asks whether the part fits needs no more.
 */
export function reachFrom(
  root: Point,
  c0: number,
  s0: number,
  k: Bend,
  cap: number,
  a: Reachable,
  rays: boolean,
  limit = Number.POSITIVE_INFINITY,
): number {
  const len = a.length - cap;
  let far = arcFar(root.x, root.y, c0, s0, k, len, cap);
  far = Math.max(far, hypot(END.x, END.y) + a.bulb);
  if (far > limit) return far;
  if (a.branches > 0) {
    // The fork, on the arc at `branchAt`, and its heading there.
    const ch = c0 * k.cb - s0 * k.sb;
    const sh = s0 * k.cb + c0 * k.sb;
    const straight = Math.abs(k.turn) < 1e-6;
    const rho = len / k.turn;
    const fx = straight ? root.x + len * D.branchAt * c0 : root.x + rho * (sh - s0);
    const fy = straight ? root.y + len * D.branchAt * s0 : root.y - rho * (ch - c0);
    for (let b = 0; b < a.branches; b++) {
      const sf = b === 0 ? k.sf : -k.sf;
      const cb = ch * k.cf - sh * sf;
      const sb = sh * k.cf + ch * sf;
      far = Math.max(far, arcFar(fx, fy, cb, sb, k, len * D.branchScale, cap * D.branchScale));
      far = Math.max(far, hypot(END.x, END.y) + a.bulb * D.branchScale);
    }
  }
  if (rays) {
    // Membranes span straight rays (`buildMembranes`), which a curled part does not follow, and a
    // neighbour's sheet may run the whole length of this part's ray.
    const L = a.length;
    far = Math.max(far, hypot(root.x + L * c0, root.y + L * s0));
    const fx = root.x + D.branchAt * L * c0;
    const fy = root.y + D.branchAt * L * s0;
    for (let b = 0; b < a.branches; b++) {
      const sf = b === 0 ? k.sf : -k.sf;
      const cb = c0 * k.cf - s0 * sf;
      const sb = s0 * k.cf + c0 * sf;
      far = Math.max(far, hypot(fx + D.branchScale * L * cb, fy + D.branchScale * L * sb));
    }
  }
  return far;
}

/**
 * An upper bound on `reachFrom` with the rays for every bend up to `bend` (any webbing), without
 * arcs: the straight rays' hull, plus how far a centre line that turns that much can drift off it
 * (its heading drifts linearly along the tube and stays put through the cap).
 */
export function roughReach(
  root: Point,
  c0: number,
  s0: number,
  bend: number,
  side: 1 | -1,
  a: Reachable,
): number {
  const L = a.length;
  const turn = Math.abs(bend);
  const tube = (length: number): number => (turn * length * (1 + D.part.capShare)) / 2;
  let far =
    Math.max(hypot(root.x, root.y), hypot(root.x + L * c0, root.y + L * s0)) + tube(L) + a.bulb;
  if (a.branches > 0) {
    const fl = D.branchAt * L;
    const bl = D.branchScale * L;
    const fx = root.x + fl * c0;
    const fy = root.y + fl * s0;
    // The fork drifts with the tube; the branch leaves it turned by that much and bends itself.
    const drift = (turn * D.branchAt * fl) / 2 + turn * D.branchAt * bl + tube(bl);
    const hull0 = Math.max(hypot(root.x, root.y), hypot(fx, fy));
    for (let b = 0; b < a.branches; b++) {
      const sf = side * (b === 0 ? FAN_SIN : -FAN_SIN);
      const vx = c0 * FAN_COS - s0 * sf;
      const vy = s0 * FAN_COS + c0 * sf;
      const hull = Math.max(
        hull0,
        hypot(root.x + bl * vx, root.y + bl * vy),
        hypot(fx + bl * vx, fy + bl * vy),
      );
      far = Math.max(far, hull + drift + D.branchScale * a.bulb);
    }
  }
  return far;
}
