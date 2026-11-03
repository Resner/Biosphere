import { describe, expect, it } from 'vitest';
import {
  drive,
  hunterFighter,
  IDLE_CODE,
  starterFighter,
  startOf,
} from '../../tests/encounter-fixture';
import { createEncounter, stepFrame } from '../sim/encounter/encounter';
import type { Encounter } from '../sim/encounter/types';
import { RULES } from '../sim/rules';
import { maxHealth } from '../sim/vitals';
import { combatHudOf } from './combat-hud';

const E = RULES.encounter;

function duel(): Encounter {
  const a = hunterFighter('a', 3000, 3000);
  const b = starterFighter('b', 3045, 3000, Math.PI);
  const enc = createEncounter(startOf('hud', [a, b]));
  enc.world.options.currents = false;
  enc.world.options.hazards = false;
  return enc;
}

describe('combatHudOf', () => {
  it('shows only while locked in a fight the player is still in', () => {
    const enc = duel();
    expect(combatHudOf(null, 0, 'balanced', true).shown).toBe(false);
    expect(combatHudOf(enc, 0, 'balanced', false).shown).toBe(false);
    expect(combatHudOf(enc, 5, 'balanced', true).shown).toBe(false);
    expect(combatHudOf(enc, 0, 'balanced', true).shown).toBe(true);
    // Once the player's own outcome is in (dead, escaped), the HUD goes.
    const me = enc.fighters[0] as Encounter['fighters'][number];
    me.status = 'escaped';
    expect(combatHudOf(enc, 0, 'balanced', true).shown).toBe(false);
  });

  it('lights the stance the input carries and lists the living opponents’ health', () => {
    const enc = duel();
    const b = enc.fighters[1] as Encounter['fighters'][number];
    b.body.health = maxHealth(b.body.biomass) * 0.4;
    const hud = combatHudOf(enc, 0, 'evasive', true);
    expect(hud.stance).toBe('evasive');
    expect(hud.opponents).toEqual([{ player: 'player-b', health: expect.closeTo(0.4, 9) }]);
    b.status = 'killed';
    expect(combatHudOf(enc, 0, 'evasive', true).opponents).toEqual([]);
  });

  it('runs the brace’s cooldown ring down from full after a brace, and opens its window', () => {
    const enc = duel();
    expect(combatHudOf(enc, 1, 'balanced', true).brace).toEqual({
      ready: true,
      cooldown: 0,
      active: false,
    });
    stepFrame(enc, [IDLE_CODE, drive(0, 0, { brace: true })]);
    const braced = combatHudOf(enc, 1, 'balanced', true).brace;
    expect(braced.ready).toBe(false);
    expect(braced.active).toBe(true);
    expect(braced.cooldown).toBeGreaterThan(0.9);
    let last = braced.cooldown;
    for (let f = 0; f < E.brace.cooldownTicks / E.frameTicks; f++) {
      stepFrame(enc, [IDLE_CODE, IDLE_CODE]);
      const { cooldown } = combatHudOf(enc, 1, 'balanced', true).brace;
      expect(cooldown).toBeLessThanOrEqual(last);
      last = cooldown;
    }
    expect(combatHudOf(enc, 1, 'balanced', true).brace.cooldown).toBe(0);
    // Without the energy for it, a brace is not ready even off cooldown.
    const b = enc.fighters[1] as Encounter['fighters'][number];
    b.body.energy = 0;
    expect(combatHudOf(enc, 1, 'balanced', true).brace.ready).toBe(false);
  });

  it('fills the escape ring as the ticks outside every opponent’s range run', () => {
    const enc = duel();
    const me = enc.fighters[1] as Encounter['fighters'][number];
    expect(combatHudOf(enc, 1, 'balanced', true).escape).toBe(0);
    me.outside = E.escapeTicks / 2;
    expect(combatHudOf(enc, 1, 'balanced', true).escape).toBeCloseTo(0.5, 9);
    me.outside = E.escapeTicks * 2;
    expect(combatHudOf(enc, 1, 'balanced', true).escape).toBe(1);
  });
});
