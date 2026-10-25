import { seedFromString } from './prng';
import { RULES, RULES_VERSION } from './rules';
import type { CreatureState, World } from './types';

export interface WorldOptions {
  seed: string;
  size?: number;
  currents?: boolean;
  hazards?: boolean;
}

export function createWorld(opts: WorldOptions): World {
  return {
    rules: RULES_VERSION,
    seed: opts.seed,
    seed32: seedFromString(opts.seed),
    tick: 0,
    size: opts.size ?? RULES.world.size,
    creatures: [],
    consumed: {},
    options: { currents: opts.currents ?? true, hazards: opts.hazards ?? true },
  };
}

export function spawnCreature(
  world: World,
  spec: { id: string; x: number; y: number; biomass?: number },
): CreatureState {
  if (world.creatures.some((c) => c.id === spec.id)) {
    throw new Error(`creature ${spec.id} already exists`);
  }
  const biomass = spec.biomass ?? RULES.starter.biomass;
  const creature: CreatureState = {
    id: spec.id,
    x: spec.x,
    y: spec.y,
    vx: 0,
    vy: 0,
    heading: 0,
    biomass,
    energy: RULES.starter.energyFraction * RULES.creature.energyPerBiomass * biomass,
    health: RULES.creature.healthPerRadius * Math.sqrt(biomass),
    dashReadyTick: 0,
    alive: true,
    cause: null,
    bornTick: world.tick,
  };
  let at = world.creatures.length;
  while (at > 0 && (world.creatures[at - 1] as CreatureState).id > spec.id) at--;
  world.creatures.splice(at, 0, creature);
  return creature;
}
