import { describe, expect, it } from 'vitest';
import { Link, ScriptedReferee, startMsg, TEST_POND } from '../../tests/scripted-referee';
import { PondClock } from '../net/clock';
import { encounterStartOf, type InputMsg } from '../net/encounter-sync';
import type { FightMsg, HubStatus, Welcome } from '../net/hub-client';
import type { ClientMsg } from '../net/protocol';
import { createEncounter } from '../sim/encounter/encounter';
import type { Input } from '../sim/input';
import { TICK_HZ } from '../sim/rules';
import { step } from '../sim/step';
import type { CreatureState } from '../sim/types';
import { createWorld } from '../sim/world';
import { FightPlay } from './app-encounter';
import { type OnlineHub, type OnlineMesh, OnlineSession } from './online';

/** The hub side of a fake online session: what the client sends, and fight messages to deliver. */
class FakeHub implements OnlineHub {
  status: HubStatus = 'online';
  queue = null;
  readonly clock = new PondClock();
  readonly sent: ClientMsg[] = [];
  private fightFns: ((m: FightMsg) => void)[] = [];
  connect(): Promise<Welcome> {
    return new Promise(() => {});
  }
  close(): void {}
  send(msg: ClientMsg): void {
    this.sent.push(msg);
  }
  onStatus() {
    return () => {};
  }
  onSignal() {
    return () => {};
  }
  onMember() {
    return () => {};
  }
  onLife() {
    return () => {};
  }
  onWelcome() {
    return () => {};
  }
  onFight(fn: (m: FightMsg) => void) {
    this.fightFns.push(fn);
    return () => {};
  }
  fight(m: FightMsg): void {
    for (const fn of this.fightFns) fn(m);
  }
}

const TICK_MS = 1000 / TICK_HZ;

describe('FightPlay with the fake online session', () => {
  it('plays enc-start, frames and enc-end, then the player swims on in free roam', () => {
    const msg = startMsg();
    const start = encounterStartOf(msg, TEST_POND);
    if (!start) throw new Error('no start');
    const own = createEncounter(start).fighters.find((f) => f.player === 'pa');
    if (!own) throw new Error('no fighter');
    // The player's free-roam creature, a little short of where the authority puts it at t0.
    const player: CreatureState = { ...own.body, x: own.body.x + 2, bornTick: 0 };
    const world = createWorld(TEST_POND);
    // The pond clock: tick t0 at hub time `at`, 300 ms (9 ticks) from now.
    world.tick = msg.t0 - 9;
    world.creatures.push(player);

    const hub = new FakeHub();
    let now = msg.at - 300;
    // West at full throttle: away from B, so the fight ends in an escape.
    let steering: Input = { steer: 128, throttle: 15, dash: false };
    let play: FightPlay | null = null;
    const session = new OnlineSession({
      selfId: 'pa',
      hub,
      createMesh: () => ({}) as OnlineMesh,
      handlers: {
        welcome: () => {},
        member: () => {},
        peerOpen: () => {},
        state: () => {},
        event: () => {},
        life: () => {},
        fight: (m) => play?.receive(m),
      },
    });
    play = new FightPlay({
      me: () => 'pa',
      pond: () => TEST_POND,
      life: () => ({ player, world }),
      steering: () => steering,
      send: (m) => session.send(m),
      hubNow: () => now,
      oneWayMs: () => 95,
      hidden: () => false,
    });

    const referee = new ScriptedReferee(start, msg.at);
    const bSlot = referee.slotOf('pb');
    const up = new Link<InputMsg & { slot: number }>(80, 30, 'game-up');
    const down = new Link<FightMsg>(80, 30, 'game-down');
    let read = 0;
    let ended: Extract<FightMsg, { t: 'enc-end' }> | null = null;
    let nextTick = now;
    let fightTicks = 0;
    let lockedAt: number | null = null;

    hub.fight(msg);
    expect(play.fighting).toBe(true);
    for (; now < msg.at + 30_000 && !play.sync?.over; now += 2) {
      for (; read < hub.sent.length; read++) {
        const m = hub.sent[read];
        if (m?.t === 'input') up.send(now, { ...m, slot: referee.slotOf('pa') });
      }
      // B idles; its inputs reach the referee on time.
      const sinceB = now - (msg.at - 10);
      if (sinceB >= 0 && sinceB % 100 === 0) referee.input(bSlot, sinceB / 100, 0, now);
      for (const m of up.take(now)) referee.input(m.slot, m.f, m.i, now);
      for (const bundle of referee.due(now)) down.send(now, bundle);
      if (referee.enc.over && !ended) {
        ended = referee.endMsg();
        down.send(now, ended);
      }
      for (const m of down.take(now)) hub.fight(m);
      while (nextTick <= now) {
        nextTick += TICK_MS;
        const tickBefore = world.tick;
        if (play.tick()) {
          fightTicks++;
          lockedAt ??= tickBefore;
          // The creature mirrors its fighter; the world keeps its tick.
          expect(world.tick).toBe(tickBefore + 1);
        } else {
          step(world, { [player.id]: steering });
        }
      }
    }
    if (!ended) throw new Error('the fight never ended');
    expect(play.sync?.hash).toBe(ended.hash);
    expect(play.sync?.desyncs).toBe(0);
    expect(fightTicks).toBeGreaterThan(30);
    // Frame 0 began at pond tick t0, give or take the local lead and a tick.
    expect(Math.abs((lockedAt ?? 0) - msg.t0)).toBeLessThanOrEqual(2);
    expect(hub.sent.filter((m) => m.t === 'input').length).toBeGreaterThan(10);

    // The player took the authority's final state, and is free again.
    const result = ended.fighters.find((x) => x.player === 'pa');
    expect(result?.outcome).toBe('escaped');
    expect(play.fighting).toBe(false);
    expect(player.x).toBe(result?.x);
    expect(player.y).toBe(result?.y);
    expect(player.energy).toBe(result?.energy);
    expect(player.alive).toBe(true);
    expect(play.tick()).toBe(false);
    steering = { steer: 0, throttle: 15, dash: false };
    // It fled west; free roam turns it east from where the fight left it.
    for (let i = 0; i < 90; i++) step(world, { [player.id]: steering });
    expect(player.vx).toBeGreaterThan(0);
    expect(player.x).not.toBe(result?.x);
    expect(player.alive).toBe(true);
    expect(play.view()?.over).toBe(true);
  });
});
