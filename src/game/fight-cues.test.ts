import { describe, expect, it } from 'vitest';
import {
  drive,
  hunterFighter,
  IDLE_CODE,
  starterFighter,
  startOf,
} from '../../tests/encounter-fixture';
import type { Cue } from '../audio/cues';
import { createEncounter, stepFrame } from '../sim/encounter/encounter';
import type { Encounter } from '../sim/encounter/types';
import { aimsAt, FightCues } from './fight-cues';

/** The hunter (slot 0, player-a) faces a still starter (slot 1, player-b) just inside its reach. */
function duel(egg = false): Encounter {
  const hunter = hunterFighter('a', 3000, 3000);
  const target = { ...starterFighter('b', 0, 3000, Math.PI), egg };
  const r = Math.sqrt(hunter.biomass);
  target.x = 3000 + 1.2 * r + r;
  const enc = createEncounter(startOf('cues', [hunter, target]));
  enc.world.options.currents = false;
  enc.world.options.hazards = false;
  return enc;
}

function recorder() {
  const log = {
    cues: [] as Cue[],
    hurt: [] as { amount: number; struck: boolean }[],
    flashes: [] as string[],
    sparks: 0,
    staggers: [] as string[],
  };
  const cues = new FightCues({
    cue: (c) => log.cues.push(c),
    hurt: (amount, struck) => log.hurt.push({ amount, struck }),
    flash: (p) => log.flashes.push(p),
    spark: () => log.sparks++,
    stagger: (p) => log.staggers.push(p),
  });
  return { cues, log };
}

/** Steps `frames` frames, the events and a tick to the cues after each, as the game does. */
function play(
  enc: Encounter,
  cues: FightCues,
  own: number,
  frames: number,
  inputs: (f: number) => (number | null)[] = () => [IDLE_CODE, IDLE_CODE],
  replay = false,
): number {
  let windups = 0;
  cues.tick(enc, own);
  for (let f = 0; f < frames && !enc.over; f++) {
    const before = structuredClone(enc);
    const events = stepFrame(enc, inputs(f));
    cues.events(enc, own, events);
    // A rollback replays the frame: its events come again, and nothing shows twice.
    if (replay) cues.events(enc, own, stepFrame(before, inputs(f)));
    cues.tick(enc, own);
    if (enc.fighters.some((x) => x.slot !== own && aimsAt(x, own, enc.world.tick))) windups++;
  }
  return windups;
}

describe('FightCues', () => {
  it('ticks once per windup aimed at the player, and lands its own damage as struck hits', () => {
    const enc = duel();
    const { cues, log } = recorder();
    play(enc, cues, 1, 60, undefined, true);
    const ticks = log.cues.filter((c) => c === 'windup').length;
    // The hunter strikes again and again: one tick each, however often the frames replay.
    expect(ticks).toBeGreaterThanOrEqual(2);
    expect(cues.windups).toBe(ticks);
    expect(cues.hits).toBeGreaterThan(0);
    expect(log.hurt.length).toBeGreaterThan(0);
    expect(log.hurt.every((h) => h.amount > 0)).toBe(true);
    expect(log.hurt.some((h) => h.struck)).toBe(true);
    // The player's own body flashes through the damage hits, never as another fighter.
    expect(log.flashes).not.toContain('player-b');
  });

  it('flashes and thuds the target of the player’s strikes, and never ticks a windup not aimed at it', () => {
    const enc = duel();
    const { cues, log } = recorder();
    play(enc, cues, 0, 60);
    expect(log.flashes.length).toBeGreaterThan(0);
    expect(new Set(log.flashes)).toEqual(new Set(['player-b']));
    expect(log.cues).toContain('hurt');
    // The starter's nips aim at the hunter (slot 0), so those tick; the hunter's own never do.
    for (const c of log.cues) expect(['hurt', 'windup']).toContain(c);
  });

  it('sparks, clinks and staggers the attacker on a block', () => {
    const enc = duel();
    const { cues, log } = recorder();
    // The starter braces every frame: whenever its brace is ready, the next strike is blocked.
    play(enc, cues, 1, 60, () => [IDLE_CODE, drive(0, 0, { brace: true })]);
    expect(cues.blocks).toBeGreaterThan(0);
    expect(log.sparks).toBe(cues.blocks);
    expect(log.cues.filter((c) => c === 'block')).toHaveLength(cues.blocks);
    expect(log.staggers).toContain('player-a');
  });

  it('gulps at a kill (not for the victim) and cracks an eaten egg, once each', () => {
    const enc = duel(true);
    const target = enc.fighters[1] as Encounter['fighters'][number];
    target.body.health = 0.5;
    const killer = recorder();
    const victim = recorder();
    for (let f = 0; f < 60 && !enc.over; f++) {
      const before = structuredClone(enc);
      const events = stepFrame(enc, [IDLE_CODE, IDLE_CODE]);
      killer.cues.events(enc, 0, events);
      killer.cues.events(enc, 0, stepFrame(before, [IDLE_CODE, IDLE_CODE]));
      victim.cues.events(enc, 1, events);
    }
    expect(target.status).toBe('killed');
    expect(killer.log.cues.filter((c) => c === 'kill')).toHaveLength(1);
    expect(killer.log.cues.filter((c) => c === 'egg-eaten')).toHaveLength(1);
    expect(victim.log.cues).not.toContain('kill');
    expect(victim.log.cues).toContain('egg-eaten');
  });
});
