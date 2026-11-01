// One merged geometry per creature and level of detail (M3 T10, M6 T10, ADR 0025): a smooth loft
// along the curved spine for the body, a thin shell over a carapace, tapered tubes with joint beads,
// bulb tips and chela fingers for the parts, thin ribbons for setae, double-sided sheets for the
// membranes and lens spheres for the eyes. Development caps parts by count only; this builder fits
// each level's vertex budget on its own, by stepping down a ladder of detail (rings, bristles drawn,
// membrane rows), and never drops a part. Positions are in the body frame, x forward, y left, z up,
// in core radii. Plates and the mouth add no vertices: they mark body vertices through `aPart`.
//
// The builder's modules: `mesh-buffer.ts` (the buffers and vertex tags), `creature-detail.ts` (the
// budgets and ladders), `creature-loft.ts` (the body and shell), `creature-parts.ts` (parts, organs
// and glints) and `creature-fit.ts` (the ladder search). This module assembles the geometry and
// re-exports what the rest of the game uses.

import * as THREE from 'three';
import type { BodyPlan } from '../genome/develop';
import { type Anatomy, NO_ANATOMY } from './anatomy';
import { type Lod, ORGAN_DETAIL } from './creature-detail';
import { addCreature, meshDetail } from './creature-fit';
import { type GlintPlan, NO_GLINT_PLAN } from './creature-parts';
import { Mesh, MOTION_WING, PART_GLINT, PART_REACH, partId, partKind } from './mesh-buffer';

export {
  GLINT_RESERVE,
  LOD_BUDGET,
  LOD_LADDER,
  type Lod,
  type MeshDetail,
  ORGAN_RESERVE,
} from './creature-detail';
export { countVertices, estimateVertices, meshDetail } from './creature-fit';
export { BODY_DEPTH, wallsAlong } from './creature-loft';
export {
  GLINT_GAP,
  type GlintPlan,
  type GlintSpot,
  glintSpots,
  NO_GLINT_PLAN,
  ORGAN_TAG,
  partPoint,
  partRadius,
} from './creature-parts';
export {
  METACHRONAL,
  MOTION_ANTENNA,
  MOTION_BEAT,
  MOTION_BELL,
  MOTION_RIGID,
  MOTION_TENTACLE,
  MOTION_WING,
  NO_WALL,
  ORGAN_KINDS,
  PART_APPENDAGE,
  PART_BODY,
  PART_CHAMBER,
  PART_DROPLET,
  PART_EYE,
  PART_GLINT,
  PART_GUT,
  PART_HEART,
  PART_KINDS,
  PART_MEMBRANE,
  PART_MOUTH,
  PART_PIGMENT,
  PART_PLATE,
  PART_REACH,
  PART_SETA,
  PART_SETULE,
  PART_SHELL,
  PART_STALK,
  partId,
  partKind,
} from './mesh-buffer';

const { hypot, abs, min, max } = Math;

/**
 * Scales each part's gain so it turns as if it reached `PART_REACH` at most: a long part sweeps no
 * further than a short one. Wings share the smallest gain, so a membrane moves with the parts it
 * spans between.
 */
function fitReach(m: Mesh): void {
  const reach = new Map<number, number>();
  const n = m.count;
  for (let i = 0; i < n; i++) {
    const id = partId(m.part[i] as number);
    // A glint rides its part but is not part of its reach.
    if (id === 0 || partKind(m.part[i] as number) === PART_GLINT) continue;
    const dx = (m.position[i * 3] as number) - (m.frame[i * 4 + 2] as number);
    const dy = (m.position[i * 3 + 1] as number) - (m.frame[i * 4 + 3] as number);
    const dz = m.position[i * 3 + 2] as number;
    reach.set(id, max(reach.get(id) ?? 0, hypot(dx, dy, dz)));
  }
  const scale = (id: number): number => min(1, PART_REACH / max(reach.get(id) ?? 0, 1e-9));
  let wing = Number.POSITIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    if (m.motion[i * 4] !== MOTION_WING) continue;
    wing = min(wing, abs(m.motion[i * 4 + 2] as number) * scale(partId(m.part[i] as number)));
  }
  for (let i = 0; i < n; i++) {
    const id = partId(m.part[i] as number);
    if (id === 0) continue;
    const k = i * 4 + 2;
    const gain = m.motion[k] as number;
    m.motion[k] = m.motion[i * 4] === MOTION_WING ? Math.sign(gain) * wing : gain * scale(id);
  }
}

/**
 * One indexed geometry for the whole creature, its organs (`anatomyOf`) and rare glints included. Attributes:
 * position, normal, uv, aSpine, aAttach, aWeight, aPart, the motion's aFrame, aMotion and
 * aFlutter (`gait.ts`), and aWall, the body's segment-wall coordinate (look pass 3).
 */
export function buildCreatureGeometry(
  plan: BodyPlan,
  lod: Lod,
  anatomy: Anatomy = NO_ANATOMY,
  glints: GlintPlan = NO_GLINT_PLAN,
): THREE.BufferGeometry {
  const m = new Mesh(false);
  addCreature(m, plan, meshDetail(plan, lod), anatomy, ORGAN_DETAIL[lod], glints);
  fitReach(m);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(m.position, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(m.uv, 2));
  g.setAttribute('aSpine', new THREE.Float32BufferAttribute(m.spine, 1));
  g.setAttribute('aAttach', new THREE.Float32BufferAttribute(m.attach, 1));
  g.setAttribute('aWeight', new THREE.Float32BufferAttribute(m.weight, 1));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(m.part, 1));
  g.setAttribute('aFrame', new THREE.Float32BufferAttribute(m.frame, 4));
  g.setAttribute('aMotion', new THREE.Float32BufferAttribute(m.motion, 4));
  g.setAttribute('aFlutter', new THREE.Float32BufferAttribute(m.flutter, 1));
  g.setAttribute('aWall', new THREE.Float32BufferAttribute(m.wall, 1));
  // Normals from the closed surfaces and one side of each sheet; sheets, bristles and glints keep their own.
  g.setIndex([...m.index, ...m.sheets]);
  g.computeVertexNormals();
  const normal = g.getAttribute('normal') as THREE.BufferAttribute;
  for (let k = 0; k < m.fixed.length; k += 4) {
    normal.setXYZ(
      m.fixed[k] as number,
      m.fixed[k + 1] as number,
      m.fixed[k + 2] as number,
      m.fixed[k + 3] as number,
    );
  }
  // Sheets are seen from either side: each triangle again, wound the other way.
  const back: number[] = [];
  for (let k = 0; k < m.sheets.length; k += 3) {
    back.push(m.sheets[k] as number, m.sheets[k + 2] as number, m.sheets[k + 1] as number);
  }
  // The glints last, over everything.
  g.setIndex([...m.index, ...m.sheets, ...back, ...m.glints]);
  g.computeBoundingSphere();
  return g;
}
