import { describe, expect, it } from 'vitest';
import {
  Link,
  ScriptedReferee,
  STARTER_TEXT,
  startMsg,
  TEST_POND,
} from '../../tests/scripted-referee';
import type { FrameInput } from '../sim/encounter/types';
import { RULES } from '../sim/rules';
import { maxHealth, starterEnergy } from '../sim/vitals';
import { encounterStartOf, fighterStartOf } from './encounter-start';
import { type EncEndMsg, EncounterSync, type InputMsg } from './encounter-sync';
import type { FighterInfo, HubMsg } from './protocol';
import { FRAME_MS } from './referee';

// M7 T15: a client that joins a running fight replays its start and history, then steps the same
// encounter from its join frame; the clients already in seat the joiner at its frame, rolling back
// when their prediction ran past it.

const E = RULES.encounter;
type Join = Extract<HubMsg, { t: 'enc-join' }>;

const input = (steer: number, throttle: number, extra: Partial<FrameInput> = {}): FrameInput => ({
  steer,
  throttle,
  dash: false,
  stance: 'balanced',
  target: 0,
  brace: false,
  ...extra,
});

/** C, a starter north of the pair. */
function joinerInfo(): FighterInfo {
  const biomass = RULES.starter.biomass;
  return {
    player: 'pc',
    creature: 'c',
    genome: STARTER_TEXT,
    x: 5215,
    y: 3040,
    vx: 0,
    vy: 0,
    heading: -Math.PI / 2,
    biomass,
    energy: starterEnergy(biomass),
    health: maxHealth(biomass),
    elder: false,
    egg: false,
    worth: 1,
  };
}

const client = (
  me: string,
  sample: (f: number) => FrameInput | null,
  send: (m: InputMsg) => void,
) => new EncounterSync({ me, sample, oneWayMs: () => 95, send });

interface Run {
  syncs: Record<'pa' | 'pb' | 'pc', EncounterSync>;
  end: EncEndMsg;
  referee: ScriptedReferee;
  sentC: InputMsg[];
  join: Join;
}

/**
 * A and B fight from frame 0; at hub time `joinAt` C engages and joins at the referee's next frame
 * + 2. The hub sends C the start and every bundle so far, then everyone the `enc-join`. A flees
 * west from frame 40 and C chases B, so the fight ends.
 */
function play(joinAt: number, latency = 80): Run {
  const msg = startMsg();
  const start = encounterStartOf(msg, TEST_POND.seed);
  if (!start) throw new Error('no start');
  const referee = new ScriptedReferee(start, msg.at);
  const up = new Link<InputMsg & { slot: number }>(latency, 30, 'up');
  const down = {
    pa: new Link<HubMsg>(latency, 30, 'down-a'),
    pb: new Link<HubMsg>(latency, 30, 'down-b'),
    pc: new Link<HubMsg>(latency, 30, 'down-c'),
  };
  const sentC: InputMsg[] = [];
  let now = 0;
  const sender = (me: string) => (m: InputMsg) => {
    if (me === 'pc') sentC.push(m);
    up.send(now, { ...m, slot: referee.slotOf(me) });
  };
  const syncs = {
    pa: client(
      'pa',
      (f) => (f < 40 ? input(0, 0) : input(128, 15, { stance: 'evasive' })),
      sender('pa'),
    ),
    pb: client('pb', () => input(128, 2), sender('pb')),
    pc: client('pc', () => input(64, 6, { target: 1 }), sender('pc')),
  };
  expect(syncs.pa.start(msg, TEST_POND)).toBe(true);
  expect(syncs.pb.start(msg, TEST_POND)).toBe(true);
  const sent: HubMsg[] = [];
  let join: Join | null = null;
  let end: EncEndMsg | null = null;
  const inFight = new Set<'pa' | 'pb' | 'pc'>(['pa', 'pb']);
  for (now = msg.at - 200; now < msg.at + 200_000 && !end; now += 2) {
    if (!join && now >= joinAt) {
      const f = referee.next + E.joinAheadFrames;
      const info = joinerInfo();
      const fighter = fighterStartOf(info);
      if (!fighter) throw new Error('no joiner');
      referee.join(f, fighter);
      join = { t: 'enc-join', enc: msg.enc, f, fighter: info };
      // The joiner's catch-up, then the join to everyone.
      for (const m of [msg, ...sent]) down.pc.send(now, m);
      inFight.add('pc');
      for (const p of inFight) down[p].send(now, join);
      sent.push(join);
    }
    for (const m of up.take(now)) referee.input(m.slot, m.f, m.i, now);
    for (const bundle of referee.due(now)) {
      sent.push(bundle);
      for (const p of inFight) down[p].send(now, bundle);
    }
    if (referee.enc.over) {
      end = referee.endMsg();
      for (const p of inFight) down[p].send(now, end);
    }
    deliver(syncs, down, now);
    if (now % 16 === 0) for (const p of inFight) syncs[p].step(now);
  }
  for (let t = now; t < now + 2000; t += 2) deliver(syncs, down, t);
  if (!end || !join) throw new Error('the fight never ended');
  return { syncs, end, referee, sentC, join };
}

function deliver(
  syncs: Run['syncs'],
  down: Record<keyof Run['syncs'], Link<HubMsg>>,
  now: number,
): void {
  for (const p of ['pa', 'pb', 'pc'] as const) {
    const sync = syncs[p];
    for (const m of down[p].take(now)) {
      if (m.t === 'enc-start') sync.start(m, TEST_POND, undefined, true);
      else if (m.t === 'enc-frame') sync.receive(m);
      else if (m.t === 'enc-join') sync.join(m);
      else if (m.t === 'enc-end') sync.end(m);
    }
  }
}

describe('EncounterSync joins (M7 T15)', () => {
  it('a joiner catches up, plays its own slot from its join frame, and every hash is the referee’s', () => {
    const run = play(10_000 + 25 * FRAME_MS);
    const { syncs, end, referee, sentC, join } = run;
    expect(end.fighters).toHaveLength(3);
    for (const sync of Object.values(syncs)) {
      expect(sync.over).toBe(true);
      expect(sync.hash).toBe(end.hash);
      expect(sync.desyncs).toBe(0);
    }
    expect(syncs.pc.slot).toBe(2);
    // C sends nothing for the frames before its join, and its own input drives its slot after it.
    expect(sentC.length).toBeGreaterThan(0);
    expect(Math.min(...sentC.map((m) => m.f))).toBe(join.f);
    const own = referee.bundles.slice(join.f).filter((b) => b[2] !== null);
    expect(own.length).toBeGreaterThan(0);
    expect(referee.bundles.slice(0, join.f).every((b) => b.length === 2)).toBe(true);
  });

  it('a client whose prediction ran past the join frame rolls back to seat the joiner', () => {
    // A long one-way delay: the join reaches A and B after they have simulated its frame.
    const { syncs, end } = play(10_000 + 25 * FRAME_MS, 190);
    expect(syncs.pa.rollbacks + syncs.pa.resyncs).toBeGreaterThan(0);
    for (const sync of Object.values(syncs)) expect(sync.hash).toBe(end.hash);
  });

  it('ignores a join for another fight, a second join of one creature, and one past the limit', () => {
    const sync = client(
      'pa',
      () => input(0, 0),
      () => {},
    );
    const msg = startMsg();
    sync.start(msg, TEST_POND);
    const join = (creature: string, enc = msg.enc): Join => ({
      t: 'enc-join',
      enc,
      f: 3,
      fighter: { ...joinerInfo(), player: `p${creature}`, creature },
    });
    expect(sync.join(join('c', 'ff'.repeat(32)))).toBe(false);
    expect(sync.join(join('c'))).toBe(true);
    expect(sync.join(join('c'))).toBe(false);
    expect(sync.join(join('a'))).toBe(false);
    expect(sync.join(join('d'))).toBe(true);
    expect(sync.join(join('e'))).toBe(false);
    for (let f = 0; f < 6; f++) sync.step(msg.at + f * FRAME_MS);
    expect(sync.enc?.fighters.map((x) => x.creature)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('a joiner whose fight ends before its join frame stops waiting, with no outcome of its own', () => {
    const sync = client(
      'pc',
      () => input(0, 0),
      () => {},
    );
    const msg = startMsg();
    expect(sync.start(msg, TEST_POND)).toBe(false);
    expect(sync.start(msg, TEST_POND, undefined, true)).toBe(true);
    expect(sync.slot).toBe(-1);
    expect(sync.ownBody()).toBeNull();
    const end: EncEndMsg = { t: 'enc-end', enc: msg.enc, f: 0, hash: '0'.repeat(16), fighters: [] };
    expect(sync.end(end)).toBeNull();
    expect(sync.over).toBe(true);
    expect(sync.running).toBe(false);
  });
});
