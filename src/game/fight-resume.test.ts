import { describe, expect, it } from 'vitest';
import { Link, ScriptedReferee, startMsg, TEST_POND } from '../../tests/scripted-referee';
import { PondClock } from '../net/clock';
import { encounterStartOf } from '../net/encounter-start';
import type { InputMsg } from '../net/encounter-sync';
import type { FightMsg, HubStatus, LifeMsg, Welcome } from '../net/hub-client';
import type { ClientMsg } from '../net/protocol';
import { FRAME_MS } from '../net/referee';
import { createEncounter } from '../sim/encounter/encounter';
import type { Input } from '../sim/input';
import { TICK_HZ } from '../sim/rules';
import { step } from '../sim/step';
import type { CreatureState, World } from '../sim/types';
import { createWorld } from '../sim/world';
import { FightPlay } from './app-encounter';
import { FightResume } from './fight-resume';
import { type OnlineHub, type OnlineMesh, OnlineSession } from './online';

/** The hub side of a fake online session: what the client sends, and life and fight messages to deliver. */
class FakeHub implements OnlineHub {
  status: HubStatus = 'online';
  queue = null;
  readonly clock = new PondClock();
  readonly sent: ClientMsg[] = [];
  private lifeFns: ((m: LifeMsg) => void)[] = [];
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
  onLife(fn: (m: LifeMsg) => void) {
    this.lifeFns.push(fn);
    return () => {};
  }
  onWelcome() {
    return () => {};
  }
  onFight(fn: (m: FightMsg) => void) {
    this.fightFns.push(fn);
    return () => {};
  }
  life(m: LifeMsg): void {
    for (const fn of this.lifeFns) fn(m);
  }
  fight(m: FightMsg): void {
    for (const fn of this.fightFns) fn(m);
  }
}

const TICK_MS = 1000 / TICK_HZ;
const lifeMsg = (fight?: string): LifeMsg =>
  ({ t: 'life', life: null, genesisIn: 0, ...(fight ? { fight } : {}) }) as LifeMsg;

/** B's page as the game wires it: a `life` reaches the resume, fight messages wait there or reach the fight. */
function page(hub: FakeHub, now: () => number) {
  let life: { player: CreatureState; world: World } | null = null;
  let steering: Input = { steer: 0, throttle: 0, dash: false };
  const play = new FightPlay({
    me: () => 'pb',
    pond: () => TEST_POND,
    life: () => life,
    steering: () => steering,
    send: (m) => session.send(m),
    hubNow: now,
    oneWayMs: () => 40,
    hidden: () => false,
  });
  const resume = new FightResume((id) => play.fighting && play.sync?.id === id);
  const reached: FightMsg['t'][] = [];
  const session: OnlineSession = new OnlineSession({
    selfId: 'pb',
    hub,
    createMesh: () => ({}) as OnlineMesh,
    handlers: {
      welcome: () => {},
      member: () => {},
      peerOpen: () => {},
      state: () => {},
      event: () => {},
      proxy: () => {},
      life: (m) => {
        if (m.t !== 'life') return;
        resume.life(m.fight);
        play.named(m.fight);
      },
      fight: (m) => {
        if (resume.hold(m)) return;
        reached.push(m.t);
        play.receive(m);
      },
    },
  });
  return {
    play,
    resume,
    reached,
    setLife: (l: typeof life) => {
      life = l;
    },
    steer: (s: Input) => {
      steering = s;
    },
  };
}

describe('FightResume with the fake online session (M8 T10)', () => {
  it('offers the fight on the title, holds its messages and plays them on resume, with no free-roam tick between', () => {
    const msg = startMsg();
    const start = encounterStartOf(msg, TEST_POND.seed);
    if (!start) throw new Error('no start');
    const referee = new ScriptedReferee(start, msg.at);
    const hub = new FakeHub();
    let now = msg.at - 100;
    const b = page(hub, () => now);
    const down = new Link<FightMsg>(40, 10, 'resume-down');
    const up = new Link<InputMsg>(40, 10, 'resume-up');
    const aSlot = referee.slotOf('pa');
    const bSlot = referee.slotOf('pb');
    let ended: Extract<FightMsg, { t: 'enc-end' }> | null = null;
    let signedIn = false;
    let resumedAt: number | null = null;
    let read = 0;
    let nextTick = now;
    let ticks = 0;
    let fightTicks = 0;
    let firstTick: boolean | null = null;
    let player: CreatureState | null = null;
    let world: World | null = null;

    for (; now < msg.at + 100_000 && !b.play.sync?.over; now += 2) {
      // A idles, on time. B's page reloaded before frame 0: nothing comes from it until it resumes.
      const sinceA = now - (msg.at - 10);
      if (sinceA >= 0 && sinceA % FRAME_MS === 0) referee.input(aSlot, sinceA / FRAME_MS, 0, now);
      for (; read < hub.sent.length; read++) {
        const m = hub.sent[read];
        if (m?.t === 'input') up.send(now, m);
      }
      for (const m of up.take(now)) referee.input(bSlot, m.f, m.i, now);
      const due = referee.due(now);
      if (signedIn) for (const bundle of due) down.send(now, bundle);
      if (referee.enc.over && !ended) {
        ended = referee.endMsg();
        down.send(now, ended);
      }
      // 2 s in, B's new page signs in: `life` names the fight, then `enc-start` and the history.
      if (!signedIn && now >= msg.at + 2000) {
        signedIn = true;
        hub.life(lifeMsg(msg.enc));
        expect(b.resume.offered).toBe(msg.enc);
        down.send(now, msg);
        referee.bundles.forEach((i, f) => {
          down.send(now, { t: 'enc-frame', enc: msg.enc, f, i });
        });
      }
      for (const m of down.take(now)) hub.fight(m);
      // A second later, on the title, B presses "Back to the fight".
      if (resumedAt === null && now >= msg.at + 3000) {
        resumedAt = now;
        expect(b.reached).toEqual([]);
        expect(b.play.sync).toBeNull();
        // The new life spawns far from the fight; resuming puts it in its fighter's place.
        const own = createEncounter(start).fighters.find((f) => f.player === 'pb');
        if (!own) throw new Error('no fighter');
        world = createWorld(TEST_POND);
        world.tick = msg.t0 + 20;
        player = { ...own.body, x: own.body.x + 400, y: own.body.y - 300, bornTick: 0 };
        world.creatures.push(player);
        b.setLife({ player, world });
        const held = b.resume.take();
        expect(held[0]?.t).toBe('enc-start');
        expect(held.slice(1).every((m) => m.t === 'enc-frame')).toBe(true);
        expect(held.length).toBeGreaterThan(15);
        for (const m of held) b.play.receive(m);
        expect(b.resume.offered).toBeNull();
        expect(b.play.resumed()).toBe(true);
        expect(b.play.sync?.frame).toBeGreaterThan(25);
        const pose = b.play.sync?.pose(b.play.sync.slot, now, false);
        expect(player.x).toBe(pose?.x);
        expect(player.y).toBe(pose?.y);
        // B swims east now: its inputs count from the referee's next frame.
        b.steer({ steer: 0, throttle: 6, dash: false });
        nextTick = now;
      }
      while (player && world && nextTick <= now) {
        nextTick += TICK_MS;
        const fought = b.play.tick();
        firstTick ??= fought;
        ticks++;
        if (fought) fightTicks++;
        else step(world, { [player.id]: { steer: 0, throttle: 6, dash: false } });
      }
    }
    if (!ended) throw new Error('the fight never ended');
    expect(firstTick).toBe(true);
    // Every tick from the resume to the end was the fight's.
    expect(fightTicks).toBeGreaterThan(10);
    expect(ticks).toBe(fightTicks);
    expect(b.play.view()?.rejoins).toBe(1);
    expect(b.play.sync?.hash).toBe(ended.hash);
    expect(b.play.sync?.desyncs).toBe(0);
    // B's own inputs after the resume reached the referee's bundles.
    expect(referee.bundles.some((row) => row[bSlot] !== null)).toBe(true);
    expect(b.play.fighting).toBe(false);
    expect(b.play.tick()).toBe(false);
  });

  it('a life naming the fight already played offers nothing, and its resync reaches the fight', () => {
    const msg = startMsg();
    const hub = new FakeHub();
    let now = msg.at + 500;
    const b = page(hub, () => now);
    const world = createWorld(TEST_POND);
    const start = encounterStartOf(msg, TEST_POND.seed);
    const own = start && createEncounter(start).fighters.find((f) => f.player === 'pb');
    if (!own) throw new Error('no fighter');
    const player: CreatureState = { ...own.body, bornTick: 0 };
    world.creatures.push(player);
    b.setLife({ player, world });
    hub.life(lifeMsg());
    hub.fight(msg);
    expect(b.play.fighting).toBe(true);
    b.play.tick();
    // A network-only reconnect: the same fight, resynced.
    hub.life(lifeMsg(msg.enc));
    expect(b.resume.offered).toBeNull();
    hub.fight(msg);
    expect(b.reached).toEqual(['enc-start', 'enc-start']);
    expect(b.play.view()?.rejoins).toBe(1);
    now += 300;
    expect(b.play.tick()).toBe(true);
    // A life naming no fight offers none, and its messages are not held. The fight it no longer
    // names ended while the page was away: it stops, and free roam carries on.
    hub.life(lifeMsg());
    expect(b.resume.hold({ t: 'enc-frame', enc: msg.enc, f: 0, i: [null, null] })).toBe(false);
    expect(b.play.fighting).toBe(false);
    expect(b.play.view()?.over).toBe(true);
    expect(b.play.view()?.endHash).toBeNull();
    expect(b.play.tick()).toBe(false);
  });
});
