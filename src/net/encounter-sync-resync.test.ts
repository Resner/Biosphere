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
import { encounterStartOf } from './encounter-start';
import { EncounterSync, type EncStartMsg, type InputMsg } from './encounter-sync';
import type { HubMsg } from './protocol';
import { FRAME_MS } from './referee';

// The authority's resync (M8 T10): a repeated `enc-start` for the running fight, then every bundle
// so far, after a disconnect, a sign-in or a restart.

const E = RULES.encounter;

const input = (steer: number, throttle: number, extra: Partial<FrameInput> = {}): FrameInput => ({
  steer,
  throttle,
  dash: false,
  stance: 'balanced',
  target: 0,
  brace: false,
  ...extra,
});

interface CutRun {
  a: EncounterSync;
  b: EncounterSync;
  referee: ScriptedReferee;
  endHash: string;
  sentA: InputMsg[];
}

/**
 * Two clients and the scripted referee; A's connection is cut both ways over `[cutFrom, cutTo)`
 * (hub time from frame 0). A keeps predicting meanwhile, and at `cutTo` the hub resyncs it with
 * `enc-start` and the history so far, as the authority does at a sign-in.
 */
function cutRun(cutFrom: number, cutTo: number): CutRun {
  const latency = 60;
  const jitter = 20;
  const msg = startMsg();
  const start = encounterStartOf(msg, TEST_POND.seed);
  if (!start) throw new Error('no start');
  const referee = new ScriptedReferee(start, msg.at);
  const up = new Link<InputMsg & { slot: number }>(latency, jitter, 'resync-up');
  const downA = new Link<HubMsg>(latency, jitter, 'resync-down-a');
  const downB = new Link<HubMsg>(latency, jitter, 'resync-down-b');
  const sentA: InputMsg[] = [];
  const cut = (t: number) => t >= msg.at + cutFrom && t < msg.at + cutTo;
  let now = 0;
  const client = (me: string, script: (f: number) => FrameInput) =>
    new EncounterSync({
      me,
      sample: script,
      oneWayMs: () => latency + jitter / 2,
      send: (m) => {
        if (me === 'pa') sentA.push(m);
        if (me === 'pa' && cut(now)) return;
        up.send(now, { ...m, slot: referee.slotOf(me) });
      },
    });
  // A chases B slowly, then turns away; B drifts.
  const a = client('pa', (f) => input(f < 40 ? 0 : 128, f < 40 ? 4 : 10));
  const b = client('pb', (f) => input(128, f < 25 ? 2 : 5));
  a.start(msg, TEST_POND);
  b.start(msg, TEST_POND);
  let endHash: string | null = null;
  let resynced = false;
  for (now = msg.at - 200; now < msg.at + 100_000 && !(a.over && b.over); now += 2) {
    for (const m of up.take(now)) referee.input(m.slot, m.f, m.i, now);
    for (const bundle of referee.due(now)) {
      if (!cut(now)) downA.send(now, bundle);
      downB.send(now, bundle);
    }
    if (referee.enc.over && endHash === null) {
      const end = referee.endMsg();
      endHash = end.hash;
      if (!cut(now)) downA.send(now, end);
      downB.send(now, end);
    }
    if (!resynced && now >= msg.at + cutTo) {
      resynced = true;
      downA.send(now, msg);
      referee.bundles.forEach((i, f) => {
        downA.send(now, { t: 'enc-frame', enc: msg.enc, f, i });
      });
      if (referee.enc.over) downA.send(now, referee.endMsg());
    }
    for (const [sync, link] of [
      [a, downA],
      [b, downB],
    ] as const) {
      for (const m of link.take(now)) {
        if (cut(now) && sync === a) continue;
        if (m.t === 'enc-start') sync.start(m, TEST_POND);
        if (m.t === 'enc-frame') sync.receive(m);
        if (m.t === 'enc-end') sync.end(m);
      }
    }
    if (now % 16 === 0) {
      a.step(now);
      b.step(now);
    }
  }
  if (endHash === null) throw new Error('the fight never ended');
  return { a, b, referee, endHash, sentA };
}

describe('EncounterSync resync (M8 T10)', () => {
  it('converges on the referee’s final hash after a resync mid-fight', () => {
    const { a, b, endHash } = cutRun(20 * FRAME_MS, 45 * FRAME_MS);
    expect(a.rejoins).toBe(1);
    expect(b.rejoins).toBe(0);
    expect(a.over).toBe(true);
    expect(a.hash).toBe(endHash);
    expect(b.hash).toBe(endHash);
    expect(a.desyncs).toBe(0);
  });

  it('converges on the autopilot for own inputs sent while the connection was cut', () => {
    const { a, referee, endHash, sentA } = cutRun(15 * FRAME_MS, 30 * FRAME_MS);
    const slot = referee.slotOf('pa');
    // A sampled and sent its inputs while cut off; none arrived, so the referee played null.
    const lost = sentA.filter((m) => m.f >= 17 && m.f < 28).map((m) => m.f);
    expect(lost.length).toBeGreaterThan(5);
    for (const f of lost) expect(referee.bundles[f]?.[slot]).toBeNull();
    expect(a.hash).toBe(endHash);
    expect(a.desyncs).toBe(0);
  });

  it('a start for the running fight keeps the counters and adds a rejoin; another fight’s is a new start', () => {
    const msg = startMsg();
    const sync = new EncounterSync({
      me: 'pa',
      sample: () => null,
      oneWayMs: () => 0,
      send: () => {},
    });
    sync.start(msg, TEST_POND);
    sync.step(msg.at + 5 * FRAME_MS);
    sync.dropped = 2;
    expect(sync.start(msg, TEST_POND)).toBe(true);
    expect(sync.rejoins).toBe(1);
    expect(sync.dropped).toBe(2);
    expect(sync.frame).toBe(0);
    expect(sync.confirmed).toBe(0);
    expect(sync.start({ ...msg, enc: 'f2'.repeat(32) }, TEST_POND)).toBe(true);
    expect(sync.rejoins).toBe(0);
    expect(sync.dropped).toBe(0);
  });

  it('catches up 900 frames of a 4-fighter fight in one step, sampling only the newest', () => {
    const base = startMsg();
    const biomass = RULES.starter.biomass;
    const fighter = (i: number) => ({
      player: `p${i}`,
      creature: `c${i}`,
      genome: STARTER_TEXT,
      x: 5200 + i * 12,
      y: 3000 + (i % 2) * 12,
      vx: 0,
      vy: 0,
      heading: 0,
      biomass,
      energy: starterEnergy(biomass),
      health: maxHealth(biomass),
      elder: false,
      egg: false,
      worth: 1,
    });
    const msg: EncStartMsg = { ...base, fighters: [0, 1, 2, 3].map(fighter) };
    const start = encounterStartOf(msg, TEST_POND.seed);
    if (!start) throw new Error('no start');
    const referee = new ScriptedReferee(start, msg.at);
    const now = msg.at + E.timeoutFrames * FRAME_MS + 500;
    const bundles = referee.due(now);
    const sampled: number[] = [];
    const sync = new EncounterSync({
      me: 'p0',
      sample: (f) => {
        sampled.push(f);
        return null;
      },
      oneWayMs: () => 0,
      send: () => {},
    });
    sync.start(msg, TEST_POND);
    for (const m of bundles) sync.receive(m);
    expect(sync.step(now)).toBe(E.timeoutFrames);
    expect(sync.frame).toBe(E.timeoutFrames);
    expect(sampled.length).toBeLessThanOrEqual(1);
    const end = referee.endMsg();
    sync.end(end);
    expect(sync.hash).toBe(end.hash);
    expect(sync.desyncs).toBe(0);
  });
});
