// World state hash (ADR 0005): walks fields in a fixed order and never relies on key order.

import { Hasher } from './hash';
import type { World } from './types';

export function hashWorld(world: World): string {
  const h = new Hasher();
  h.u32(world.rules).str(world.seed);
  for (const lane of world.seed32) h.u32(lane);
  h.u32(world.tick).f64(world.size);
  h.u32(world.options.currents ? 1 : 0).u32(world.options.hazards ? 1 : 0);

  h.u32(world.creatures.length);
  for (const c of world.creatures) {
    h.str(c.id).f64(c.x).f64(c.y).f64(c.vx).f64(c.vy).f64(c.heading);
    h.f64(c.biomass).f64(c.energy).f64(c.health);
    h.u32(c.dashReadyTick)
      .u32(c.alive ? 1 : 0)
      .u32(c.elder ? 1 : 0)
      .str(c.cause ?? '')
      .u32(c.bornTick);
    const p = c.phys;
    h.f64(p.maxBiomass).f64(p.thrust).f64(p.drag).f64(p.turn).f64(p.basal).f64(p.growth);
    h.f64(p.uvTolerance).f64(p.pressureTolerance);
    h.f64(p.mouth.offset).f64(p.mouth.radius).f64(p.mouth.arc).f64(p.mouth.type);
    h.f64(p.mouth.digestion).u32(p.colliders.length);
    for (const k of p.colliders) h.f64(k.x).f64(k.y).f64(k.r);
  }

  const eaten = Object.entries(world.consumed).sort(([a], [b]) => (a < b ? -1 : 1));
  h.u32(eaten.length);
  for (const [id, slot] of eaten) h.str(id).u32(slot.k).u32(slot.until);
  // Only present when something added plumes, so ordinary worlds hash as before.
  if (world.extraPlumes.length > 0) {
    h.u32(world.extraPlumes.length);
    for (const p of world.extraPlumes) h.str(p.id).f64(p.x).f64(p.y).f64(p.radius);
  }
  return h.digest();
}
