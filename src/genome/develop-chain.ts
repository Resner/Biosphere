// Development, chain stage: moved verbatim out of develop.ts (ADR 0045).

import { clamp, cos, length as hypot, lerp, PI, pow, sin, TAU } from '../sim/math';
import type { PlanForm, PlanSegment } from './develop-plan';
import * as fromPlan from './develop-plan';
import type { Traits } from './express';

// Bound once: the test runner reads an import through a getter on every use, which costs a fifth of the
// 0.15 ms development budget (stats.test.ts) in these hot loops.
const { peak, range, D, STRETCH, radiusAlong, TRUNK_HEAD, WIDTH } = fromPlan;

/** How the spine bends: everything of `PlanForm` but `slim`, which the chain's layout decides. */
export type Bending = Omit<PlanForm, 'slim'>;

/**
 * The spine's tangent heading at `t` (0 the core, 1 the tail): a C (and a coil drawn by `bend`)
 * turns evenly; an S (M6b T6) rises evenly to half its turn at `peak`, then falls back to 0, so it
 * bends two opposite arcs of half the turn each.
 */
export function heading(form: Bending, peak: number, t: number): number {
  if (form.mode !== 1) return form.turn * t;
  return (form.turn / 2) * (t <= peak ? t / peak : (1 - t) / (1 - peak));
}

const COIL_TURN = range(D.curve.coilTurn);

/**
 * The spine's turn and mode (M6b T6): a C turns curve × π; an S of `sFrom` segments or more two
 * opposite arcs of `sArc` × curve × π each (at most `sMax` × π), a shorter one of half the curve's
 * turn each; past `coilStart` a chain of `coilFrom` segments or more coils from `coilTurn[0]` × π
 * to `coilTurn[1]` × π, and any other chain (or any, without `coil`) takes the C-curl (ADR 0041).
 */
export function formOf(shape: Traits['shape'], count: number, coil = true): Bending {
  const C = D.curve;
  const radial = shape.symmetry >= D.radial.at ? 1 : 0;
  if (count < 2 || !(shape.curve > 0)) return { turn: 0, mode: 0, radial };
  if (shape.curve > C.coilStart) {
    // The coil's gate (ADR 0041): a segment trait of `coilFrom` or more; else the C-curl. The
    // leg gate is `develop`'s, since it reads the parts.
    if (!coil || count < C.coilFrom) return { turn: PI * shape.curve, mode: 0, radial };
    const k = (shape.curve - C.coilStart) / (1 - C.coilStart);
    return { turn: PI * lerp(COIL_TURN[0], COIL_TURN[1], k), mode: 2, radial };
  }
  if (shape.curveMode >= C.sMode) {
    // A short chain has too few links to draw two arcs, so its S stays shallow.
    const arc = count >= C.sFrom ? Math.min(C.sArc * shape.curve, C.sMax) : shape.curve / 2;
    return { turn: 2 * PI * arc, mode: 1, radial };
  }
  return { turn: PI * shape.curve, mode: 0, radial };
}

/** The chain's shape before it is scaled: segment count, each segment's stretch and profile radius. */
function chainProfile(traits: Traits) {
  const { body, shape } = traits;
  const T = D.tagmata;
  const n = clamp(Math.floor(body.segments), 1, D.caps.segments);
  const aspect = clamp(body.aspect / D.aspectNeutral, STRETCH[0], STRETCH[1]);
  // Symmetry rounds the body toward an aspect of 1.
  const stretch = lerp(aspect, 1, shape.symmetry);
  const tail = (i: number): number =>
    n > 1 ? clamp((i / (n - 1) - (1 - T.tailShare)) / T.tailShare, 0, 1) : 0;
  // The tagma profile behind the head: swollen in the trunk, tapered in the tail.
  const profile = (i: number): number =>
    (1 + T.trunk * shape.trunkSwell * peak(i / (n - 1), T.trunkAt, T.trunkSpread)) *
    (1 - T.tailTaper * shape.tailTaper * tail(i));
  const radius = (i: number): number =>
    n > 1 ? (1 - body.taper * D.taperDrop * (i / (n - 1))) * (i > 0 ? profile(i) : 1) : 1;
  const stretchOf = (i: number): number =>
    stretch * (1 + T.tailLength * shape.tailLength * tail(i));
  return { n, radius, stretchOf };
}

/**
 * How a v2 chain is drawn (M6b T5, ADR 0037): `plain` (a cell, a two-segment chain, a radial body),
 * `trunk` (one long body, widest at the trunk), `worm` (a trunk chain of `trunk.worm.from`
 * segments or more with no carapace, curled by `trunk.worm.curl` or more but not coiled: even and
 * slimmer) or `coil` (a chain of `chain.slimFrom` or more past `curve.coilStart`: a chambered
 * spiral, M6b T6).
 * The worm's curl is the one `silhouetteOf` reads, so a curled worm is drawn slimmer than its
 * straight twin (amends ADR 0031).
 */
type Build = 'plain' | 'trunk' | 'worm' | 'coil';

/** How many of a chain's front segments the carapace fuses. */
export function fusedCount(fusion: number, n: number): number {
  return Math.min(n, Math.round(fusion * n));
}

export function buildOf(traits: Traits, form: Bending, n: number): Build {
  const W = D.chain.trunk.worm;
  if (form.radial === 1 || n < D.chain.slimFrom) return 'plain';
  if (form.mode === 2) return 'coil';
  if (fusedCount(traits.shape.fusion, n) >= 2) return 'trunk';
  return n >= W.from && traits.shape.curve >= W.curl ? 'worm' : 'trunk';
}

export function buildSegments(
  traits: Traits,
  form: Bending,
  build: Build,
): { segments: PlanSegment[]; slim: number } {
  if (build === 'coil') return { segments: coilOf(traits, form), slim: 1 };
  let chain = chainV2(traits, build);
  if (build !== 'plain') chain = slimTail(chain, traits.shape.fusion);
  // A radial body's chain lies inside its round core, so it neither grows nor slims.
  if (form.turn > 0 && form.radial === 0) return curled(chain, form, build);
  const narrow = slimming(chain, form, build);
  const straight = narrow < 1 ? chain.map((s) => ({ ...s, ry: s.ry * narrow })) : chain;
  return { segments: form.turn > 0 ? bend(straight, form) : straight, slim: narrow };
}

/** How far a chain's segments reach from the core centre (`planBounds`' measure of them). */
export function farEdge(segments: readonly PlanSegment[]): number {
  let far = 0;
  for (const s of segments) far = Math.max(far, hypot(s.x, s.y) + Math.max(s.rx, s.ry));
  return far;
}

/**
 * Whether segments `a` and `b`, which are not neighbours, keep `curve.gap` of their summed radii
 * (along the line between their centres) apart (M6b T6).
 */
export function apart(a: PlanSegment, b: PlanSegment): boolean {
  const d = hypot(b.x - a.x, b.y - a.y);
  if (!(d > 0)) return false;
  const [dx, dy] = [(b.x - a.x) / d, (b.y - a.y) / d];
  return d >= (1 + D.curve.gap) * (radiusAlong(a, dx, dy) + radiusAlong(b, -dx, -dy));
}

/** Whether every two segments of a chain that are not neighbours keep `apart`. */
function clear(segments: readonly PlanSegment[]): boolean {
  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 2; j < segments.length; j++) {
      if (!apart(segments[i] as PlanSegment, segments[j] as PlanSegment)) return false;
    }
  }
  return true;
}

/**
 * The straight chain with every segment behind the head `grow` times as long, and each link longer
 * by as much as its two segments, so neighbours overlap as they did.
 */
function lengthen(chain: readonly PlanSegment[], grow: number): PlanSegment[] {
  const out: PlanSegment[] = [chain[0] as PlanSegment];
  for (let i = 1; i < chain.length; i++) {
    const [a, b] = [chain[i - 1], chain[i]] as [PlanSegment, PlanSegment];
    const front = i > 1 ? grow * a.rx : a.rx;
    const link = ((a.x - b.x) * (front + grow * b.rx)) / (a.rx + b.rx);
    out.push({ ...b, x: (out[i - 1] as PlanSegment).x - link, rx: grow * b.rx });
  }
  return out;
}

/**
 * A curled C or S chain fits the bounds along its curve, not laid straight (M6b T6, ADR 0038): its
 * segments and links grow by the largest factor, up to `curve.longer`, at which the curled pose
 * reaches no farther than the straight chain did. It is slimmed by its length along the curve (ADR
 * 0031), and further, by lateral compression too, if a tight bend would bring two segments that are
 * not neighbours together.
 */
function curled(
  chain: PlanSegment[],
  form: Bending,
  build: Build,
): { segments: PlanSegment[]; slim: number } {
  const C = D.curve;
  // As far as the straight chain reaches, slimmed as it is drawn.
  const straight = slimming(chain, form, build);
  const limit = farEdge(chain.map((s) => ({ ...s, ry: s.ry * straight }))) + D.epsilon;
  const lay = (grow: number, narrow: number): PlanSegment[] => {
    const long = grow === 1 ? chain : lengthen(chain, grow);
    return bend(narrow < 1 ? long.map((s) => ({ ...s, ry: s.ry * narrow })) : long, form);
  };
  const slimOf = (grow: number): number =>
    slimming(grow === 1 ? chain : lengthen(chain, grow), form, build);
  const reaches = (grow: number): boolean => farEdge(lay(grow, slimOf(grow))) <= limit;
  let grow = 1;
  if (reaches(C.longer)) grow = C.longer;
  else if (reaches(1)) {
    let hi = C.longer;
    for (let k = 0; k < C.steps; k++) {
      const mid = (grow + hi) / 2;
      if (reaches(mid)) grow = mid;
      else hi = mid;
    }
  }
  let narrow = slimOf(grow);
  let segments = lay(grow, narrow);
  // Measured along the curve, where a tight bend draws neighbours closer than laid straight.
  const aspect = aspectFor(chain, form, build);
  for (let k = 0; k < 2 * C.steps && aspect > 0; k++) {
    const along = spineLength(segments) / (2 * widestOf(segments));
    if (along >= aspect) break;
    // Narrower than the ratio, since a bend's links shorten as its segments narrow.
    const r = along / aspect;
    narrow *= r * r * (1 - 1e-4);
    segments = lay(grow, narrow);
  }
  if (!clear(segments)) {
    // The largest further narrowing that clears, to 2^−`steps`·2 of it.
    let [lo, hi] = [0, 1];
    for (let k = 0; k < 2 * C.steps; k++) {
      const mid = (lo + hi) / 2;
      if (clear(lay(grow, narrow * mid))) lo = mid;
      else hi = mid;
    }
    // Nothing clears (coincident centres): keep the pose, so `bodyViolations` names it, not a zero width.
    if (lo > 0) {
      narrow *= lo;
      segments = lay(grow, narrow);
    }
  }
  return { segments, slim: narrow };
}

/**
 * A coil (M6b T6, ADR 0038): a chambered spiral of `caps.segments` segments that turns `form.turn`
 * from the head to the tail. Every link turns alike and is `whorl` ^ (its turn ÷ 2π) as long as
 * the one in front, so the chambers lie on a logarithmic spiral and each whorl is `whorl` the size
 * of the one outside it. A chamber is `chamber` of its links long and as wide as the trunk profile
 * lets it, up to the widest that keeps it clear of the whorl inside it; the head is a share of the
 * widest chamber, and its link only as long as keeps the two overlapping. The spiral is then scaled
 * to reach as far as a trunk does.
 */
function coilOf(traits: Traits, form: Bending): PlanSegment[] {
  const C = D.curve;
  const n = D.caps.segments;
  const step = form.turn / (n - 1);
  const q = pow(C.whorl, step / TAU);
  const profile = trunkProfile(traits, n, 'coil');
  let top = 0;
  for (let i = 1; i < n; i++) top = Math.max(top, profile(i));
  const share = headShareOf(traits, 'coil');
  const stretch = chainProfile(traits).stretchOf(0);
  // Chamber i sits between links i and i + 1, of lengths q^(i − 1) and q^i: its size is between.
  const size = (i: number): number => pow(q, i - 0.5);
  const lay = (wide: number): PlanSegment[] => {
    const ry = [0];
    let widest = 0;
    for (let i = 1; i < n; i++) {
      // The shell tapers by its whorls; the trunk profile keeps only half its swing.
      ry.push(wide * size(i) * lerp(1, profile(i) / top, 0.5));
      widest = Math.max(widest, ry[i] as number);
    }
    const head = share * widest;
    const out: PlanSegment[] = [
      { x: 0, y: 0, rx: D.chain.trunk.headLength * stretch * head, ry: head, angle: 0 },
    ];
    for (let i = 1; i < n; i++) {
      const prev = out[i - 1] as PlanSegment;
      const h = (i - 0.5) * step;
      const [dx, dy] = [-cos(h), -sin(h)];
      const seg = { x: 0, y: 0, rx: C.chamber * size(i), ry: ry[i] as number, angle: i * step };
      // A link only reaches as far as keeps its two segments overlapping (the small head's does not).
      const fit = C.overlap * (radiusAlong(prev, dx, dy) + radiusAlong(seg, -dx, -dy));
      const d = Math.min(pow(q, i - 1), fit);
      out.push({ ...seg, x: prev.x + d * dx, y: prev.y + d * dy });
    }
    return out;
  };
  // The widest chambers that keep clear of the whorl inside them, in 1/32 of a link. Too narrow a
  // chamber shortens its links to overlap its neighbours, and the spiral bunches, so search down.
  let unit = lay(1 / 32);
  for (let k = 0; k < 31; k++) {
    const trial = lay(1 - k / 32);
    if (clear(trial)) {
      unit = trial;
      break;
    }
  }
  // As large as reaches as far as a trunk does, but at most `curve.coiled` times as long as the
  // straight trunk the same genes lay out.
  const straight = slimTail(chainV2(traits, 'trunk'), traits.shape.fusion);
  const scale = Math.min(
    D.chain.trunk.reach / farEdge(unit),
    (C.coiled * spineLength(straight)) / spineLength(unit),
  );
  return unit.map((s) => ({
    x: s.x * scale,
    y: s.y * scale,
    rx: s.rx * scale,
    ry: s.ry * scale,
    angle: s.angle,
  }));
}

/** How much of the trunk profile's swing a chain keeps: a worm only `trunk.even` of it. */
const swingOf = (build: Build): number => (build === 'worm' ? D.chain.trunk.even : 1);

/**
 * The trunk profile (M6b T5, ADR 0037): segment `i`'s width share along a chain of `n`, rising
 * behind the head to its peak at `trunk.at`, then narrowing to the tail. Each factor is concave or
 * a triangle, so their product has one peak: behind it every segment is narrower than the one in
 * front. A worm keeps only `trunk.even` of the swing, so it is even.
 */
function trunkProfile(traits: Traits, n: number, build: Build): (i: number) => number {
  const { body, shape } = traits;
  const T = D.chain.trunk;
  const G = D.tagmata;
  const k = swingOf(build);
  return (i) => {
    const t = i / (n - 1);
    const front = 1 - k * T.rise * Math.max(0, 1 - t / T.at);
    const behind = Math.max(0, (t - T.at) / (1 - T.at));
    const rear = 1 - k * (T.drop + body.taper * D.taperDrop) * behind;
    const swell = 1 + k * G.trunk * shape.trunkSwell * peak(t, T.at, G.trunkSpread);
    const tail = clamp((t - (1 - G.tailShare)) / G.tailShare, 0, 1);
    return front * rear * swell * (1 - k * G.tailTaper * shape.tailTaper * tail);
  };
}

/** The head's half-width as a share of the trunk's widest (head scale and symmetry raise it). */
function headShareOf(traits: Traits, build: Build): number {
  const [lo, hi] = TRUNK_HEAD;
  const { shape } = traits;
  return lerp(lerp(hi - swingOf(build) * (hi - lo), hi, shape.headScale), hi, shape.symmetry);
}

/**
 * A fused chain's free tail (M6b T5): behind a carapace of 2 or more segments, the free segments
 * narrow by one factor to at most `trunk.freeTail` of the widest fused one, so the carapace reads as
 * an oval front with a slim tail. The fused count is the carapace's (`buildCarapace`).
 */
function slimTail(chain: PlanSegment[], fusion: number): PlanSegment[] {
  const count = fusedCount(fusion, chain.length);
  if (count < 2 || count >= chain.length) return chain;
  let fused = 0;
  let free = 0;
  for (let i = 0; i < chain.length; i++) {
    const r = (chain[i] as PlanSegment).ry;
    if (i < count) fused = Math.max(fused, r);
    else free = Math.max(free, r);
  }
  if (!(free > 0)) return chain;
  const k = Math.min(1, (D.chain.trunk.freeTail * fused) / free);
  if (k >= 1) return chain;
  return chain.map((s, i) => (i < count ? s : { ...s, ry: s.ry * k }));
}

/** A straight chain's length (the head's front to the tail's end) per width (its widest segment). */
function aspectOf(segments: readonly PlanSegment[]): number {
  const head = segments[0] as PlanSegment;
  const tail = segments[segments.length - 1] as PlanSegment;
  return (head.x + head.rx - (tail.x - tail.rx)) / (2 * widestOf(segments));
}

/**
 * Body proportions v3 (look pass 4, ADR 0031): the factor that narrows a bilateral chain of
 * `chain.slimFrom` segments or more to `chain.aspect` times as long as wide (a worm to
 * `trunk.worm.aspect`, M6b T5), every segment alike, so the head and trunk keep their profile and
 * the chain keeps its length; 1 for any other body. The chain is measured laid straight with the
 * length it has along its curve (M6b T6).
 */
function slimming(straight: PlanSegment[], form: Bending, build: Build): number {
  const aspect = aspectFor(straight, form, build);
  return aspect > 0 ? Math.min(1, aspectOf(straight) / aspect) : 1;
}

/** How many times as long as wide a chain must be: 0 for a body that is never slimmed. */
function aspectFor(chain: readonly PlanSegment[], form: Bending, build: Build): number {
  const C = D.chain;
  if (form.radial === 1 || chain.length < C.slimFrom) return 0;
  return build === 'worm' ? C.trunk.worm.aspect : C.aspect;
}

/** A chain's length along its spine: the head's front, through every link, to the tail's end. */
function spineLength(segments: readonly PlanSegment[]): number {
  let length = (segments[0] as PlanSegment).rx + (segments[segments.length - 1] as PlanSegment).rx;
  for (let i = 1; i < segments.length; i++) {
    const [a, b] = [segments[i - 1], segments[i]] as [PlanSegment, PlanSegment];
    length += hypot(b.x - a.x, b.y - a.y);
  }
  return length;
}

/** Twice the widest half-width of a chain is its width. */
function widestOf(segments: readonly PlanSegment[]): number {
  let w = 0;
  for (const s of segments) w = Math.max(w, s.ry);
  return w;
}

/**
 * The v2 head in front of a chain: `chain.head` of the v1 head's size without head scale, so the
 * trunk can carry the body, the v1 size at head scale 1, and round and whole as symmetry rises. Its
 * half-length never falls below v1's shortest. A single cell keeps the v1 head.
 */
function headOf(traits: Traits): { rx: number; ry: number } {
  const { shape } = traits;
  const { n, stretchOf } = chainProfile(traits);
  if (n < 2) return { rx: stretchOf(0), ry: 1 };
  const share = lerp(lerp(D.chain.head, 1, shape.headScale), 1, shape.symmetry);
  return { rx: Math.max(STRETCH[0], stretchOf(0) * share), ry: share };
}

/**
 * The v2 chain (ADR 0028): the segments behind the head are `chain.width` core radii wide along the
 * tagma profile, and the chain fits its reach by shortening its segments first, down to
 * `chain.squash` of their width, and only then narrowing; a big head then narrows it by
 * 1 ÷ (1 + `tagmata.head` × head scale). Neighbours sit `segmentSpacing` of their summed
 * half-lengths apart, so they always overlap. A `trunk` or `worm` build (M6b T5) lays the segments
 * out along `trunkProfile` and sizes the head by the trunk.
 */
function chainV2(traits: Traits, build: Build): PlanSegment[] {
  const C = D.chain;
  const trunked = build !== 'plain';
  const profile = chainProfile(traits);
  const { n, stretchOf } = profile;
  const radius = trunked ? trunkProfile(traits, n, build) : profile.radius;
  const width = [0];
  const along = [0];
  // sum[i]: segment i's distance behind the head's end of the chain, in half-lengths at full size.
  const sum = [0];
  let widest = 0;
  const base = trunked ? C.trunk.width : C.width;
  for (let i = 1; i < n; i++) {
    const r = radius(i);
    width.push(base * r);
    widest = Math.max(widest, width[i] as number);
    // A trunk chain's segments narrow faster than they shorten, so its tail stays a tail.
    const long = trunked ? base * Math.sqrt(r) : (width[i] as number);
    along.push(long * stretchOf(i));
    sum.push(
      (sum[i - 1] as number) + (i > 1 ? (along[i - 1] as number) : 0) + (along[i] as number),
    );
  }
  // Head scale narrows the chain behind the head (ADR 0028). On one long body (M6b T5) the head
  // is a share of the trunk's widest segment as drawn, and head scale raises that share.
  const big = 1 / (1 + D.tagmata.head * traits.shape.headScale);
  const share = trunked ? headShareOf(traits, build) * big * widest : 0;
  const { rx: head, ry } = trunked
    ? { rx: C.trunk.headLength * stretchOf(0) * share, ry: share }
    : headOf(traits);
  const out: PlanSegment[] = [{ x: 0, y: 0, rx: head, ry, angle: 0 }];
  if (n < 2) return out;
  // A radial body keeps its chain inside its round core (M6b T7: from symmetry 0.5, so the chain
  // never covers the ring's roots).
  const radial = traits.shape.symmetry >= D.radial.at;
  const reach = radial ? head : trunked ? C.trunk.reach : C.reach;
  const room = reach - D.segmentSpacing * head;
  // Shorten first: the largest squash at which every segment's far edge stays in reach.
  let squash = 1;
  for (let i = 1; i < n; i++) {
    const s = D.segmentSpacing * (sum[i] as number);
    squash = Math.min(squash, (room - (width[i] as number)) / s, room / (s + (along[i] as number)));
  }
  // Then narrow: one scale for the whole chain at the shortest squash.
  let scale = 1;
  if (!(squash >= C.squash)) {
    squash = C.squash;
    for (let i = 1; i < n; i++) {
      const extent =
        D.segmentSpacing * squash * (sum[i] as number) +
        Math.max(squash * (along[i] as number), width[i] as number);
      scale = Math.min(scale, room / extent);
    }
  }
  // A narrowed trunk narrows the head in proportion; its length stays laid out.
  if (trunked) out[0] = { x: 0, y: 0, rx: head, ry: ry * scale, angle: 0 };
  for (let i = 1; i < n; i++) {
    out.push({
      x: -(D.segmentSpacing * (head + squash * scale * (sum[i] as number))),
      y: 0,
      rx: squash * scale * (along[i] as number),
      ry: big * scale * (width[i] as number),
      angle: 0,
    });
  }
  return out;
}

/** Lays the straight chain along the curve: same links, turned by the tangent, neighbours overlapping. */
export function bend(straight: PlanSegment[], form: Bending): PlanSegment[] {
  const n = straight.length;
  // An S peaks at the middle segment (the front one of two), so the segments show both arcs whole.
  const peak = Math.round((n - 1) / 2) / (n - 1);
  const out: PlanSegment[] = [straight[0] as PlanSegment];
  for (let i = 1; i < n; i++) {
    const prev = out[i - 1] as PlanSegment;
    const s = straight[i] as PlanSegment;
    const phi = PI + heading(form, peak, (i - 0.5) / (n - 1));
    const dx = cos(phi);
    const dy = sin(phi);
    const seg = { ...s, angle: heading(form, peak, i / (n - 1)) };
    let d = (straight[i - 1] as PlanSegment).x - s.x;
    d = Math.min(d, D.curve.overlap * (radiusAlong(prev, dx, dy) + radiusAlong(seg, -dx, -dy)));
    out.push({ ...seg, x: prev.x + d * dx, y: prev.y + d * dy });
  }
  return out;
}

/**
 * How thick a part may be on each segment (M6b T7, ADR 0039): `part.root` of the segment's drawn
 * half-width, so legs on a slim trunk are thin. The gene's width range scales down to it, as a share.
 */
export function widthScales(segments: readonly PlanSegment[]): number[] {
  return segments.map((s) => Math.min(1, (D.part.root * s.ry) / WIDTH[1]));
}

/**
 * A part's drawn width from its gene's at its segment's scale `k`: never thinner than `part.floor`
 * (or its gene) where the segment has room for it, so a thin leg still shows at a small size.
 */
export const drawnWidth = (gene: number, k: number): number =>
  Math.max(gene * k, Math.min(gene, D.part.floor, k * WIDTH[1]));
