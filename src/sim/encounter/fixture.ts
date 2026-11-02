// Fixtures for encounter tests and the tournament: starter fighters and small starts.

import { STARTER_COMBAT, STARTER_PHYS } from '../body';
import { seedFromString } from '../prng';
import { RULES } from '../rules';
import { maxHealth, starterEnergy } from '../vitals';
import { encodeFrameInput } from './codec';
import type { Behaviour, EncounterStart, FighterStart, FrameInput } from './types';

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
  };
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
