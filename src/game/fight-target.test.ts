import { describe, expect, it } from 'vitest';
import { hunterFighter, starterFighter, startOf } from '../../tests/encounter-fixture';
import { startMsg, TEST_POND } from '../../tests/scripted-referee';
import type { ClientMsg } from '../net/protocol';
import { decodeFrameInput } from '../sim/encounter/codec';
import { EGG_CODE } from '../sim/encounter/egg';
import { createEncounter } from '../sim/encounter/encounter';
import type { CreatureState } from '../sim/types';
import { createWorld } from '../sim/world';
import { FightPlay } from './app-encounter';
import { fightKey } from './engage';
import {
  inputTarget,
  markedTarget,
  nextTarget,
  targetAt,
  targetingOffered,
  targetOptions,
} from './fight-target';

// M7 T15: Tab cycles the living opponents and the whole eggs, nearest first; a click picks a
// fighter or an egg; the input's target field carries the choice, the nearest by default.

/** Slot 0 (A) at 5200; B 40 wu east carrying an egg (trailing east of it, since it faces west); C 70 wu north. */
function melee() {
  return createEncounter(
    startOf('target', [
      hunterFighter('a', 5200, 3000),
      { ...starterFighter('b', 5240, 3000, Math.PI), egg: true },
      starterFighter('c', 5200, 2930, Math.PI / 2),
    ]),
  );
}

describe('fight targets', () => {
  it('are offered with three fighters or an egg, never in a plain duel', () => {
    expect(targetingOffered(melee())).toBe(true);
    const duel = createEncounter(
      startOf('duel', [starterFighter('a', 5200, 3000), starterFighter('b', 5240, 3000)]),
    );
    expect(targetingOffered(duel)).toBe(false);
    const egg = createEncounter(
      startOf('egg', [
        starterFighter('a', 5200, 3000),
        { ...starterFighter('b', 5240, 3000), egg: true },
      ]),
    );
    expect(targetingOffered(egg)).toBe(true);
  });

  it('Tab goes nearest first through the living opponents and whole eggs, and wraps', () => {
    const enc = melee();
    const options = targetOptions(enc, 0);
    expect(options.map((o) => o.code)).toEqual([1, EGG_CODE + 1, 2]);
    expect(options.map((o) => o.distance)).toEqual(
      [...options.map((o) => o.distance)].sort((x, y) => x - y),
    );
    expect(nextTarget(enc, 0, null)).toBe(1);
    expect(nextTarget(enc, 0, 1)).toBe(EGG_CODE + 1);
    expect(nextTarget(enc, 0, EGG_CODE + 1)).toBe(2);
    expect(nextTarget(enc, 0, 2)).toBe(1);
    // A dead fighter and an eaten egg drop out.
    (enc.fighters[2] as (typeof enc.fighters)[number]).status = 'killed';
    (enc.fighters[1]?.eggBody as { by: number }).by = 0;
    expect(targetOptions(enc, 0).map((o) => o.code)).toEqual([1]);
    expect(nextTarget(enc, 0, 1)).toBe(1);
  });

  it('a click on an egg targets the egg, on a body the body, and on open water nothing', () => {
    const enc = melee();
    const egg = enc.fighters[1]?.eggBody;
    if (!egg) throw new Error('no egg');
    expect(targetAt(enc, 0, egg.x, egg.y, 1)).toBe(EGG_CODE + 1);
    expect(targetAt(enc, 0, 5200, 2931, 1)).toBe(2);
    expect(targetAt(enc, 0, 5000, 3300, 1)).toBeNull();
    // The own body is never a target.
    expect(targetAt(enc, 0, 5200, 3000, 1)).toBeNull();
  });

  it('the input carries the choice while it is valid, else the own slot (the nearest)', () => {
    const enc = melee();
    expect(inputTarget(enc, 0, EGG_CODE + 1)).toBe(EGG_CODE + 1);
    expect(inputTarget(enc, 0, null)).toBe(0);
    expect(inputTarget(enc, 0, EGG_CODE + 2)).toBe(0);
    expect(markedTarget(enc, 0, null)).toEqual({ code: 1, chosen: false });
    expect(markedTarget(enc, 0, 2)).toEqual({ code: 2, chosen: true });
  });

  it('Tab is a combat key only while locked', () => {
    expect(fightKey('Tab', true, false)).toEqual({ t: 'target' });
    expect(fightKey('Tab', false, false)).toBeNull();
  });
});

describe('FightPlay targeting', () => {
  it('Tab and a click set the target bits of the inputs it sends', () => {
    const msg = startMsg();
    msg.fighters.push({
      ...(msg.fighters[0] as (typeof msg.fighters)[number]),
      player: 'pc',
      creature: 'c',
      y: 2950,
    });
    const sent: ClientMsg[] = [];
    let now = msg.at;
    const world = createWorld(TEST_POND);
    const player = { id: 'a' } as CreatureState;
    const play = new FightPlay({
      me: () => 'pa',
      pond: () => TEST_POND,
      life: () => ({ player, world }),
      steering: () => ({ steer: 0, throttle: 0, dash: false }),
      send: (m) => sent.push(m),
      hubNow: () => now,
      oneWayMs: () => 0,
      hidden: () => false,
    });
    play.receive(msg);
    const targets = () =>
      sent.flatMap((m) => (m.t === 'input' ? [decodeFrameInput(m.i).target] : []));
    play.tick();
    expect(targets()).toEqual([0]);
    expect(play.cycleTarget()).toBe(true);
    const first = play.view()?.aim;
    expect(first?.chosen).toBe(true);
    now += 100;
    play.tick();
    expect(targets()[1]).toBe(first?.code);
    // A click on C's body picks it.
    const c = play.sync?.enc?.fighters.find((f) => f.player === 'pc');
    if (!c) throw new Error('no C');
    expect(play.pickTarget(c.body.x, c.body.y, 2)).toBe(true);
    expect(play.pickTarget(0, 0, 2)).toBe(false);
    now += 100;
    play.tick();
    expect(targets()[2]).toBe(c.slot);
    expect(play.view()?.aim).toEqual({ code: c.slot, chosen: true });
  });
});
