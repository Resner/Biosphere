// Development (ADR 0006, ADR 0025, ADR 0028): traits become a bounded, repaired body plan. Total and
// deterministic; the caps live here, never in the renderer. Lengths are in core radii (the core is
// radius 1 at the origin, x forward, y left). Appendages are built for the left side and mirrored,
// so every repair keeps the body bilateral. Development bends, profiles and fuses the segment
// chain, rings a radial body's parts and adds eyes, and dresses parts with fine detail (webbing,
// setae, bulbs, chelae, joint beads: M6 T8). Its proportions (M6 T14b, ADR 0028) give a trunk that
// carries the body, and parts fitted by their drawn reach.

import { clamp, lerp } from '../sim/math';
import type { Bending } from './develop-chain';
import * as fromChain from './develop-chain';
import * as fromDetail from './develop-detail';
import * as fromFit from './develop-fit';
import * as fromOrganize from './develop-organize';
import * as fromParts from './develop-parts';
import type { BodyPlan, PlanSegment, Plate } from './develop-plan';
import * as fromPlan from './develop-plan';
import type { Traits } from './express';

// Bound once: the test runner reads an import through a getter on every use, which costs a fifth of the
// 0.15 ms development budget (stats.test.ts) in these hot loops.
const { buildOf, buildSegments, widthScales, formOf } = fromChain;
const { outlineOf } = fromFit;
const { D, PLATE_THICKNESS } = fromPlan;
const { buildParts } = fromParts;
const { radialParts, bilateralParts, mirror, dress } = fromOrganize;
const { buildCarapace, buildMouth, buildColliders, buildEyes, buildMembranes } = fromDetail;

export { bodyViolations, hashPlan, planBounds } from './develop-check';
export { polygonArea } from './develop-detail';
export { ringAngle } from './develop-fit';
export { motileArea } from './develop-organize';
export type { PartCurve } from './develop-parts';
export {
  baseLength,
  curveAt,
  partCurve,
  partLength,
  partReach,
  weaponShare,
} from './develop-parts';
export type {
  Appendage,
  BodyPlan,
  Carapace,
  Membrane,
  PlanEyes,
  PlanForm,
  PlanMouth,
  PlanSegment,
  Plate,
  Point,
} from './develop-plan';
export {
  branchWeight,
  dirOf,
  extentOf,
  onAxis,
  peak,
  placeOn,
  rootOf,
  turnTo,
} from './develop-plan';

/** The chain and its parts for one form, before they are dressed and mirrored. */
function grow(traits: Traits, form: Bending, n: number) {
  const shape = traits.shape;
  const build = buildOf(traits, form, n);
  const { segments, slim } = buildSegments(traits, form, build);
  const scales = widthScales(segments);
  // A coil's parts root on its outer whorl, so they grow clear of the whorls inside it (M6b T7).
  const rooms = build === 'coil' ? Math.min(segments.length, D.curve.outer) : segments.length;
  const built = buildParts(traits, scales, rooms);
  // Parts keep off the drawn body (M6b T7).
  const body = outlineOf(segments);
  const R = D.radial;
  const parts = form.radial
    ? radialParts(built, segments, shape.drape * R.drapeSweep * R.ringDrape, body)
    : bilateralParts(
        built,
        segments,
        lerp(D.sweep, R.drapeSweep, shape.drape),
        body,
        scales,
        build === 'coil',
      );
  return { build, segments, slim, parts };
}

export function develop(traits: Traits): BodyPlan {
  const shape = traits.shape;
  const n = clamp(Math.floor(traits.body.segments), 1, D.caps.segments);
  let form = formOf(shape, n);
  let grown = grow(traits, form, n);
  const legs = (): number =>
    grown.parts.reduce((count, p) => count + (p.role === 'leg' ? 1 : 0), 0);
  // The coil's leg gate (ADR 0041): a coil with more leg pairs than `coilLegs` takes the C-curl.
  if (form.mode === 2 && legs() > D.curve.coilLegs) {
    form = formOf(shape, n, false);
    grown = grow(traits, form, n);
  }
  const { segments, slim, parts } = grown;
  // A coil lays its chain out as more chambers than its segment genes give (M6b T6).
  const count = segments.length;
  const plating = traits.skin.plating;
  const carapace = buildCarapace(segments, shape.fusion, plating);
  const appendages = mirror(dress(parts, segments), segments);
  const plates: Plate[] =
    plating < D.plateMin
      ? []
      : segments
          .map((_, segment) => ({
            segment,
            coverage: plating,
            thickness: lerp(PLATE_THICKNESS[0], PLATE_THICKNESS[1], plating),
          }))
          .slice(carapace.count); // the carapace covers the fused segments
  return {
    segments,
    appendages,
    plates,
    mouth: buildMouth(traits.mouth, form.radial),
    colliders: buildColliders(segments, appendages, carapace),
    flexibility: traits.body.flexibility * (1 - (D.fusion.stiffen * carapace.count) / count),
    form: { turn: form.turn, mode: form.mode, radial: form.radial, slim },
    carapace,
    eyes: buildEyes(shape, segments[0] as PlanSegment),
    membranes: buildMembranes(segments, appendages),
  };
}
