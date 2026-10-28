// The depth gauge and the hazard cues of the HUD (M6 T16): which zone the player is in, how deep,
// and whether UV or pressure is hurting it, by the same exposure the sim applies.

import type { Zone } from '../sim/bathymetry';
import { zoneOfDepth } from '../sim/bathymetry';
import type { PhysStats } from '../sim/body';
import { zoneExposure } from '../sim/hazards';

export const ZONE_NAMES: Readonly<Record<Zone, string>> = {
  shallows: 'Shallows',
  twilight: 'Twilight',
  deep: 'Deep',
  abyss: 'Abyss',
};

export interface ZoneReadout {
  zone: Zone;
  name: string;
  /** 0 (surface) .. 1 (abyss floor). */
  depth: number;
  /** UV burns this creature here. */
  uv: boolean;
  /** Pressure crushes this creature here. */
  pressure: boolean;
}

/** `hazards` is the world's option: the title's demo water hurts nobody. */
export function zoneReadout(
  depth: number,
  phys: Pick<PhysStats, 'uvTolerance' | 'pressureTolerance'>,
  hazards: boolean,
): ZoneReadout {
  const zone = zoneOfDepth(depth);
  const exposure = zoneExposure(depth);
  return {
    zone,
    name: ZONE_NAMES[zone],
    depth,
    uv: hazards && exposure.uv > 0 && phys.uvTolerance < 1,
    pressure: hazards && exposure.pressure > 0 && phys.pressureTolerance < 1,
  };
}
