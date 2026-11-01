// The level-of-detail fit (ADR 0025): development caps parts by count only, so each level fits its
// vertex budget on its own, by stepping down a ladder of detail, and never drops a part.

import type { BodyPlan } from '../genome/develop';
import { type Anatomy, NO_ANATOMY } from './anatomy';
import {
  GLINT_RESERVE,
  LOD_BUDGET,
  LOD_LADDER,
  type Lod,
  type MeshDetail,
  ORGAN_DETAIL,
  ORGAN_RESERVE,
  type OrganDetail,
  organVertices,
} from './creature-detail';
import { addBody, addShell, stations } from './creature-loft';
import {
  addAppendage,
  addEyes,
  addGlints,
  addMembrane,
  addOrgans,
  type GlintPlan,
  glintSpots,
  NO_GLINT_PLAN,
  rootFrame,
} from './creature-parts';
import { Mesh, NO_MOTION } from './mesh-buffer';
import { centreLine } from './spine';

const FALLBACK: Readonly<Record<Lod, readonly MeshDetail[]>> = {
  high: [...LOD_LADDER.high, ...LOD_LADDER.medium, ...LOD_LADDER.low],
  medium: [...LOD_LADDER.medium, ...LOD_LADDER.low],
  low: LOD_LADDER.low,
};

export function addCreature(
  m: Mesh,
  plan: BodyPlan,
  d: MeshDetail,
  anatomy: Anatomy = NO_ANATOMY,
  organs: OrganDetail = ORGAN_DETAIL.high,
  glints: GlintPlan = NO_GLINT_PLAN,
): void {
  const spine = stations(plan, centreLine(plan.segments), d);
  const webbed = new Set(plan.membranes.flatMap((sheet) => [sheet.part, sheet.to]));
  const frames = plan.appendages.map((a, i) =>
    rootFrame(plan, spine, a, a.webbing > 0 || webbed.has(i)),
  );
  // Draw order (one draw call, no depth test): membranes, parts and bristles, the body, the organs
  // inside it, the shell, the eyes.
  for (const sheet of plan.membranes) {
    const frame = frames[sheet.part];
    if (frame) addMembrane(m, plan, sheet, frame, d);
  }
  plan.appendages.forEach((a, i) => {
    addAppendage(m, plan, spine, a, frames[i] as ReturnType<typeof rootFrame>, i + 1, d);
  });
  m.gait = NO_MOTION;
  addBody(m, plan, spine, d);
  addOrgans(m, plan, spine, anatomy, organs);
  addShell(m, plan, spine, d);
  addEyes(m, plan, spine, d);
  addGlints(
    m,
    plan,
    spine,
    glintSpots(plan, anatomy, glints.count, glints.seed),
    glints.size,
    frames,
  );
}

/** The vertices `plan`'s body and parts take at one rung of detail, without organs. */
export function countVertices(plan: BodyPlan, detail: MeshDetail): number {
  const m = new Mesh(true);
  addCreature(m, plan, detail);
  return m.count;
}

/** The richest detail that keeps `plan` within its level's budget, less the organs' and glints' reserves. */
export function meshDetail(plan: BodyPlan, lod: Lod): MeshDetail {
  return fit(plan, lod).detail;
}

const fitted = new WeakMap<BodyPlan, Partial<Record<Lod, Fit>>>();

interface Fit {
  detail: MeshDetail;
  count: number;
}

/** Plans are immutable, so the ladder search runs once per plan and level. */
function fit(plan: BodyPlan, lod: Lod): Fit {
  const byLod = fitted.get(plan) ?? {};
  fitted.set(plan, byLod);
  const found = byLod[lod] ?? search(plan, lod);
  byLod[lod] = found;
  return found;
}

function search(plan: BodyPlan, lod: Lod): Fit {
  const ladder = FALLBACK[lod];
  const budget = LOD_BUDGET[lod] - ORGAN_RESERVE[lod] - GLINT_RESERVE;
  let count = 0;
  for (const detail of ladder) {
    count = countVertices(plan, detail);
    if (count <= budget) return { detail, count };
  }
  return { detail: ladder[ladder.length - 1] as MeshDetail, count };
}

/** The vertices `buildCreatureGeometry(plan, lod, anatomy, glints)` makes. */
export function estimateVertices(
  plan: BodyPlan,
  lod: Lod,
  anatomy: Anatomy = NO_ANATOMY,
  glints: GlintPlan = NO_GLINT_PLAN,
): number {
  return (
    fit(plan, lod).count +
    organVertices(lod, anatomy.organs.length, anatomy.gut.length >= 2) +
    4 * glintSpots(plan, anatomy, glints.count, glints.seed).length
  );
}
