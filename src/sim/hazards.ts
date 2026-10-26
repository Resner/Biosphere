import { colliderReach } from './body';
import { currentDriftAt } from './currents';
import { cos, sin, TAU } from './math';
import { hashU32 } from './prng';
import { DT, RULES, TICK_HZ } from './rules';
import type { CreatureState, Plume, StepEvent, World } from './types';

const SALT = { roll: 1, x: 2, y: 3, radius: 4 } as const;
const H = RULES.hazards;
// The farthest a plume can stray from its anchor: its drift is a fraction of the current's integral.
const MAX_DRIFT =
  (H.driftFactor * 2 * RULES.currents.maxSpeed) /
  (TAU / (RULES.currents.timePeriodTicks / TICK_HZ));

const cellHash = (world: World, cx: number, cy: number, salt: number): number =>
  hashU32(...world.seed32, cx, cy, salt, 0x70) >>> 0;
const unit = (hash: number): number => hash / 4294967296;

/** The plume anchored in a cell, before drift (its anchor and radius), or null. */
function anchorInCell(world: World, cx: number, cy: number): Plume | null {
  if (cellHash(world, cx, cy, SALT.roll) % H.cellsPerPlume !== 0) return null;
  const cell = RULES.world.cellSize;
  return {
    id: `p${cx}_${cy}`,
    x: cx * cell + unit(cellHash(world, cx, cy, SALT.x)) * cell,
    y: cy * cell + unit(cellHash(world, cx, cy, SALT.y)) * cell,
    radius:
      H.plumeMinRadius +
      unit(cellHash(world, cx, cy, SALT.radius)) * (H.plumeMaxRadius - H.plumeMinRadius),
  };
}

/**
 * Toxic plumes whose area reaches the disc of `radius` around a point, ordered by cell. Each grid
 * cell anchors at most one plume, which then drifts with the currents; a pure function of the
 * seed and the tick.
 */
export function plumesNear(world: World, x: number, y: number, radius: number): Plume[] {
  const found: Plume[] = [];
  for (const plume of world.extraPlumes) {
    const range = radius + plume.radius;
    const dx = plume.x - x;
    const dy = plume.y - y;
    if (dx * dx + dy * dy <= range * range) found.push({ ...plume });
  }
  if (!world.options.hazards) return found;
  const cell = RULES.world.cellSize;
  const n = Math.floor(world.size / cell);
  const reach = radius + H.plumeMaxRadius + MAX_DRIFT;
  const x0 = Math.max(0, Math.floor((x - reach) / cell));
  const x1 = Math.min(n - 1, Math.floor((x + reach) / cell));
  const y0 = Math.max(0, Math.floor((y - reach) / cell));
  const y1 = Math.min(n - 1, Math.floor((y + reach) / cell));
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      const plume = anchorInCell(world, cx, cy);
      if (plume === null) continue;
      // Cheap cull on the anchor before computing the drift.
      const range = radius + plume.radius;
      const far = range + MAX_DRIFT;
      const ax = plume.x - x;
      const ay = plume.y - y;
      if (ax * ax + ay * ay > far * far) continue;
      const drift = currentDriftAt(world, plume.x, plume.y);
      plume.x += H.driftFactor * drift.x;
      plume.y += H.driftFactor * drift.y;
      const dx = plume.x - x;
      const dy = plume.y - y;
      if (dx * dx + dy * dy <= range * range) found.push(plume);
    }
  }
  return found;
}

/**
 * Toxin damage scaled by the creature's exposure: the share of its collider area (`r²` per circle)
 * whose centre, rotated by the heading and scaled by the core radius, lies inside a plume.
 * Overlapping plumes don't stack. A single-circle body takes all or nothing.
 */
export function applyHazards(world: World, creature: CreatureState): StepEvent[] {
  if (!creature.alive) return [];
  const { colliders } = creature.phys;
  const radius = Math.sqrt(creature.biomass);
  const plumes = plumesNear(
    world,
    creature.x,
    creature.y,
    colliderReach(creature.phys, creature.biomass),
  );
  if (plumes.length === 0) return [];
  const hx = cos(creature.heading);
  const hy = sin(creature.heading);
  let exposed = 0;
  let total = 0;
  for (const c of colliders) {
    const area = c.r * c.r;
    total += area;
    const px = creature.x + (c.x * hx - c.y * hy) * radius;
    const py = creature.y + (c.x * hy + c.y * hx) * radius;
    for (const p of plumes) {
      if ((p.x - px) * (p.x - px) + (p.y - py) * (p.y - py) <= p.radius * p.radius) {
        exposed += area;
        break;
      }
    }
  }
  if (exposed === 0) return [];
  const amount = RULES.damage.toxin * DT * (exposed / total);
  creature.health -= amount;
  return [{ type: 'damage', creature: creature.id, amount, cause: 'toxin' }];
}
