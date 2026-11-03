// Fixtures for encounter tests and the tournament: starter fighters and small starts.

import { STARTER_COMBAT, STARTER_PHYS } from '../src/sim/body';
import { encodeFrameInput } from '../src/sim/encounter/codec';
import type {
  Behaviour,
  EncounterStart,
  FighterStart,
  FrameInput,
} from '../src/sim/encounter/types';
import { seedFromString } from '../src/sim/prng';
import { RULES } from '../src/sim/rules';
import { maxHealth, starterEnergy } from '../src/sim/vitals';

export const CALM: Behaviour = {
  aggression: 0.5,
  caution: 0.5,
  curiosity: 0.5,
  reflex: 0.5,
  targetPref: 'nearest',
};

/** A starter cell at (x, y) facing `heading`. */
export function starterFighter(
  creature: string,
  x: number,
  y: number,
  heading = 0,
  biomass: number = RULES.starter.biomass,
): FighterStart {
  return {
    player: `player-${creature}`,
    creature,
    x,
    y,
    vx: 0,
    vy: 0,
    heading,
    biomass,
    energy: starterEnergy(biomass),
    health: maxHealth(biomass),
    elder: false,
    egg: false,
    phys: STARTER_PHYS,
    combat: STARTER_COMBAT,
    behaviour: CALM,
    worth: 1,
  };
}

/** A starter body with a weapon: reach 1.5, a wide arc and power 0.6 (a strike power of 0.9). */
export function hunterFighter(
  creature: string,
  x: number,
  y: number,
  heading = 0,
  biomass: number = RULES.starter.biomass,
): FighterStart {
  const f = starterFighter(creature, x, y, heading, biomass);
  return { ...f, combat: { ...STARTER_COMBAT, reach: 1.5, arc: 1, power: 0.6 } };
}

export function startOf(
  pondSeed: string,
  fighters: FighterStart[],
  size: number = RULES.world.size,
): EncounterStart {
  return {
    id: `enc-${pondSeed}`,
    pondSeed,
    size,
    seed: seedFromString(`${pondSeed}-fight`),
    t0: 1000,
    fighters,
  };
}

/** The input code for a heading in 256 steps and a throttle. */
export const drive = (steer: number, throttle = 15, extra: Partial<FrameInput> = {}): number =>
  encodeFrameInput({
    steer,
    throttle,
    dash: false,
    stance: 'balanced',
    target: 0,
    brace: false,
    ...extra,
  });

export const IDLE_CODE = drive(0, 0);
