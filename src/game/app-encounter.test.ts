import { beforeAll, describe, expect, it } from 'vitest';
import { hunterFighter, IDLE_CODE, starterFighter, startOf } from '../../tests/encounter-fixture';
import { Link, ScriptedReferee, startMsg, TEST_POND } from '../../tests/scripted-referee';
import { genomeFromBase64url, genomeHash } from '../genome/codec';
import { createIdentity, type Identity, memoryKeyStore } from '../ledger/identity';
import { keyVerifier } from '../ledger/key-verify';
import { inputSigned, signInput, signWitnessFrame, witnessFrameSigned } from '../ledger/witness';
import { PondClock } from '../net/clock';
import { encounterStartOf } from '../net/encounter-start';
import type { InputMsg } from '../net/encounter-sync';
import type { FightMsg, HubStatus, Welcome } from '../net/hub-client';
import { type ClientMsg, genomeRefOf, type PeerEvent } from '../net/protocol';
import { FRAME_MS } from '../net/referee';
import { decodeFrameInput } from '../sim/encounter/codec';
import { createEncounter, stepFrame } from '../sim/encounter/encounter';
import type { Input } from '../sim/input';
import { TICK_HZ } from '../sim/rules';
import { step } from '../sim/step';
import type { CreatureState } from '../sim/types';
import { createWorld } from '../sim/world';
import { AUTO_BRACE_TICKS, FightPlay, threatened } from './app-encounter';
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
  onDuty() {
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
    const start = encounterStartOf(msg, TEST_POND.seed);
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
        proxy: () => {},
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
    // The keys' stance (3: evasive) and one brace (Shift) go out with the own inputs.
    play.stance = 'evasive';
    play.brace();
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
    const inputs = hub.sent.flatMap((m) => (m.t === 'input' ? [decodeFrameInput(m.i)] : []));
    expect(inputs.length).toBeGreaterThan(10);
    expect(inputs.every((i) => i.stance === 'evasive')).toBe(true);
    expect(inputs.filter((i) => i.brace)).toHaveLength(1);
    expect(inputs[0]?.brace).toBe(true);
    expect(play.view()?.endHash).toBe(ended.hash);

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

  it('marks an away opponent and reads the confirmed fight for the proxy relay (M8 T11)', () => {
    const msg = startMsg();
    const start = encounterStartOf(msg, TEST_POND.seed);
    const own = start && createEncounter(start).fighters.find((f) => f.player === 'pa');
    if (!start || !own) throw new Error('no start');
    const player: CreatureState = { ...own.body, bornTick: 0 };
    const world = createWorld(TEST_POND);
    world.tick = msg.t0;
    world.creatures.push(player);
    let now = msg.at;
    const play = new FightPlay({
      me: () => 'pa',
      pond: () => TEST_POND,
      life: () => ({ player, world }),
      steering: () => ({ steer: 0, throttle: 0, dash: false }),
      send: () => {},
      hubNow: () => now,
      oneWayMs: () => 0,
      hidden: () => false,
      present: (p) => p !== 'pb',
    });
    play.receive(msg);
    now += 450;
    expect(play.tick()).toBe(true);
    const away = Object.fromEntries(play.view()?.fighters.map((f) => [f.player, f.away]) ?? []);
    expect(away).toEqual({ pa: false, pb: true });

    const fight = play.relayFight();
    expect(fight?.id).toBe(msg.enc);
    expect(play.relayFight()).toBe(fight);
    const slot = fight?.players.indexOf('pb') ?? -1;
    const b = start.fighters.find((f) => f.player === 'pb');
    const info = msg.fighters.find((f) => f.player === 'pb');
    const genome = info && genomeFromBase64url(info.genome);
    if (!b || !genome) throw new Error('no B');
    // Nothing is confirmed yet: B as frame 0 found it, its body named by its genome.
    expect(play.sync?.frame).toBeGreaterThan(0);
    expect(fight?.snapshot(slot)).toMatchObject({
      tick: msg.t0,
      x: b.x,
      y: b.y,
      fighting: true,
      alive: true,
      genomeRef: genomeRefOf(genomeHash(genome)),
    });
  });

  it('debug.autoBrace sees a windup aimed at the player only in its last 4 ticks (M7 T12)', () => {
    const hunter = hunterFighter('a', 3000, 3000);
    const target = starterFighter('b', 3000 + 2.2 * Math.sqrt(hunter.biomass), 3000, Math.PI);
    const enc = createEncounter(startOf('auto', [hunter, target]));
    enc.world.options.currents = false;
    enc.world.options.hazards = false;
    const seen: number[] = [];
    for (let f = 0; f < 20; f++) {
      const a = enc.fighters[0];
      const left = a && a.fx.windupEnd >= 0 ? a.fx.windupEnd - enc.world.tick : null;
      if (left !== null) {
        expect(threatened(enc, 1, AUTO_BRACE_TICKS)).toBe(left <= AUTO_BRACE_TICKS);
        // The hunter's windup never threatens the hunter itself.
        expect(threatened(enc, 0, AUTO_BRACE_TICKS)).toBe(false);
        seen.push(left);
      }
      stepFrame(enc, [IDLE_CODE, IDLE_CODE]);
    }
    expect(seen.some((l) => l <= AUTO_BRACE_TICKS)).toBe(true);
    expect(seen.some((l) => l > AUTO_BRACE_TICKS)).toBe(true);
  });
});

describe('a fighter’s route to a witness (M10 T7)', () => {
  let a: Identity;
  let w: Identity;
  beforeAll(async () => {
    [a, w] = await Promise.all([
      createIdentity(memoryKeyStore()),
      createIdentity(memoryKeyStore()),
    ]);
  });

  /** A fighting page for `a` (slot 0) on a hand clock, its sends to the hub and to the witness kept. */
  function fighter() {
    const msg = startMsg();
    msg.fighters = msg.fighters.map((f, s) => (s === 0 ? { ...f, player: a.playerId } : f));
    const start = encounterStartOf(msg, TEST_POND.seed);
    const own = start && createEncounter(start).fighters.find((f) => f.player === a.playerId);
    if (!own) throw new Error('no start');
    const player: CreatureState = { ...own.body, bornTick: 0 };
    const world = createWorld(TEST_POND);
    world.tick = msg.t0;
    world.creatures.push(player);
    const clock = { now: msg.at };
    const hub: ClientMsg[] = [];
    const toW: [string, PeerEvent][] = [];
    const play = new FightPlay({
      me: () => a.playerId,
      pond: () => TEST_POND,
      life: () => ({ player, world }),
      steering: () => ({ steer: 30, throttle: 5, dash: false }),
      send: (m) => hub.push(m),
      hubNow: () => clock.now,
      oneWayMs: () => 0,
      hidden: () => false,
      sendWitness: (peer, ev) => toW.push([peer, ev]),
      signInput: (enc, f, code) => signInput(a, enc, f, code),
      frameSigned: witnessFrameSigned,
      peerOneWayMs: () => null,
    });
    play.receive(msg);
    /** Plays up to frame `f` (its start), one tick a frame. */
    const playTo = (f: number) => {
      for (let g = play.sync?.frame ?? 0; g <= f; g++) {
        clock.now = msg.at + g * FRAME_MS + 1;
        play.tick();
      }
    };
    return { msg, play, hub, toW, playTo };
  }

  it('sends each input from the handover’s frame to the witness, signed, and back to the hub after a take-back', () => {
    const { msg, play, hub, toW, playTo } = fighter();
    const enc = msg.enc;
    playTo(10);
    expect(hub.filter((m) => m.t === 'input').length).toBeGreaterThanOrEqual(10);
    // The handover at frame 9: frame 9 and 10 were sent to the hub already and go to W once more.
    play.receive({ t: 'enc-referee', enc, from: 9, by: w.playerId });
    expect(toW.map(([, ev]) => ev.t === 'finput' && ev.f)).toEqual([9, 10]);
    playTo(20);
    const hubFrames = hub.flatMap((m) => (m.t === 'input' ? [m.f] : []));
    expect(Math.max(...hubFrames)).toBe(10);
    const key = keyVerifier(a.playerId);
    if (!key) throw new Error('no key');
    for (const [peer, ev] of toW) {
      expect(peer).toBe(w.playerId);
      if (ev.t !== 'finput') throw new Error('not an input');
      expect(inputSigned(key, enc, ev.f, ev.i, ev.sig)).toBe(true);
    }
    expect(play.view()?.referee).toEqual({ by: w.playerId, from: 9 });
    expect(play.view()?.handovers).toBe(1);

    // A planned take-back from frame 18: frames 18 to 20, sent to W, go to the hub too, and every later one.
    const sentToW = toW.length;
    play.receive({ t: 'enc-referee', enc, from: 18, by: 'authority' });
    expect(hub.flatMap((m) => (m.t === 'input' && m.f >= 18 ? [m.f] : []))).toEqual([18, 19, 20]);
    playTo(24);
    expect(toW.length).toBe(sentToW);
    expect(hub.filter((m) => m.t === 'input' && m.f > 20).length).toBe(4);
    expect(play.view()?.referee).toEqual({ by: 'authority', from: 18 });
  });

  it('plays the witness’s signed frames, and the authority’s different frame overrules one with a dispute', () => {
    const { msg, play, hub, playTo } = fighter();
    const enc = msg.enc;
    play.receive({ t: 'enc-referee', enc, from: 1, by: w.playerId });
    playTo(4);
    const wframe = (f: number, i: (number | null)[]) => ({
      t: 'wframe' as const,
      enc,
      f,
      i,
      sig: signWitnessFrame(w, enc, f, i),
    });
    play.receive({ t: 'enc-frame', enc, f: 0, i: [null, null] });
    // Frame 0 is the authority's: W's is not played.
    play.witnessFrame(w.playerId, wframe(0, [null, 0]));
    expect(play.sync?.held).toEqual([[null, null]]);
    play.witnessFrame(w.playerId, wframe(1, [null, null]));
    play.witnessFrame(w.playerId, wframe(2, [null, null]));
    // A forged frame is not played.
    play.witnessFrame(w.playerId, { ...wframe(3, [null, null]), sig: wframe(3, [null, 1]).sig });
    expect(play.sync?.confirmed).toBe(3);
    play.receive({ t: 'enc-frame', enc, f: 1, i: [null, null] });
    expect(hub.some((m) => m.t === 'dispute')).toBe(false);
    play.receive({ t: 'enc-frame', enc, f: 2, i: [null, 0] });
    const disputes = hub.filter((m) => m.t === 'dispute');
    expect(disputes).toHaveLength(1);
    expect(disputes[0]).toMatchObject({ enc, f: 2, i: [null, null] });
    expect(play.sync?.held[2]).toEqual([null, 0]);
    expect(play.view()?.disputes).toBe(1);
  });
});
