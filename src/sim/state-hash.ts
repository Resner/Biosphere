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
      .str(c.cause ?? '')
      .u32(c.bornTick);
  }

  const ids = Object.keys(world.consumed).sort();
  h.u32(ids.length);
  for (const id of ids) {
    const eaten = world.consumed[id] as { k: number; until: number };
    h.str(id).u32(eaten.k).u32(eaten.until);
  }
  return h.digest();
}
