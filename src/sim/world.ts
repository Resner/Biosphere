import { depthAt } from './bathymetry';
import { type PhysStats, STARTER_PHYS, sanitizePhys } from './body';
import { seedFromString } from './prng';
import { RULES, RULES_VERSION } from './rules';
import type { CreatureState, World } from './types';
import { maxHealth, starterEnergy } from './vitals';

export interface WorldOptions {
  seed: string;
  size?: number;
  currents?: boolean;
  hazards?: boolean;
}

export function createWorld(opts: WorldOptions): World {
  const world = {
    rules: RULES_VERSION,
    seed: opts.seed,
    seed32: seedFromString(opts.seed),
    tick: 0,
    size: opts.size ?? RULES.world.size,
    creatures: [],
    consumed: {},
    options: { currents: opts.currents ?? true, hazards: opts.hazards ?? true },
    extraPlumes: [],
  } satisfies World;
  // Calibrate the pond's bathymetry now rather than inside the first tick.
  depthAt(world.seed32, world.size / 2, world.size / 2);
  return world;
}

export function spawnCreature(
  world: World,
  spec: { id: string; x: number; y: number; biomass?: number; phys?: PhysStats },
): CreatureState {
  const biomass = spec.biomass ?? RULES.starter.biomass;
  const creature: CreatureState = {
    id: spec.id,
    x: spec.x,
    y: spec.y,
    vx: 0,
    vy: 0,
    heading: 0,
    biomass,
    energy: starterEnergy(biomass),
    health: maxHealth(biomass),
    dashReadyTick: 0,
    alive: true,
    elder: false,
    cause: null,
    bornTick: world.tick,
    phys: sanitizePhys(spec.phys ?? STARTER_PHYS),
  };
  // world.creatures is sorted by id, so a duplicate sits right at the insertion point.
  let at = world.creatures.length;
  while (at > 0 && (world.creatures[at - 1] as CreatureState).id > spec.id) at--;
  if (world.creatures[at - 1]?.id === spec.id)
    throw new Error(`creature ${spec.id} already exists`);
  world.creatures.splice(at, 0, creature);
  return creature;
}
