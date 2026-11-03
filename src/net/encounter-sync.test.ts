import { describe, expect, it } from 'vitest';
import {
  Link,
  ScriptedReferee,
  STARTER_TEXT,
  startMsg,
  TEST_POND,
} from '../../tests/scripted-referee';
import { decodeFrameInput } from '../sim/encounter/codec';
import type { FrameInput } from '../sim/encounter/types';
import {
  EASE_MS,
  type EncEndMsg,
  EncounterSync,
  type EncStartMsg,
  encounterStartOf,
  FRAME_MS,
  type InputMsg,
  KEEP_FRAMES,
  leadMs,
} from './encounter-sync';
import type { HubMsg } from './protocol';

const input = (steer: number, throttle: number, extra: Partial<FrameInput> = {}): FrameInput => ({
  steer,
  throttle,
  dash: false,
  stance: 'balanced',
  target: 0,
  brace: false,
  ...extra,
});
const IDLE_INPUT = input(0, 0);

/** Each client's own input per frame; `pa` flees west from frame 10, so the fight ends in an escape. */
type Script = (f: number) => FrameInput | null;
const fleeing: Script = (f) => (f < 10 ? IDLE_INPUT : input(128, 15, { stance: 'evasive' }));
/** A slow chaser whose input changes at frames 20 and 40. */
const changing: Script = (f) => input(128, f < 20 ? 3 : f < 40 ? 6 : 2);
const steady: Script = () => input(128, 2);

interface Run {
  a: EncounterSync;
  b: EncounterSync;
  referee: ScriptedReferee;
  end: EncEndMsg;
  sentA: InputMsg[];
}

interface RunOptions {
  scripts?: { a?: Script; b?: Script };
  /** One-way latency and jitter in ms. */
  latency?: number;
  jitter?: number;
  /** The hub-to-A link stalls from this hub time for `stallMs`. */
  stallAt?: number;
  stallMs?: number;
  /** Frames whose input from A the referee never sees. */
  lostA?: (f: number) => boolean;
  /** A's tab is hidden over these hub times: it receives bundles but neither steps nor samples. */
  hiddenA?: [number, number];
  /** Changes the end A receives. */
  tamper?: (end: EncEndMsg) => EncEndMsg;
  /** Runs at every client step, with the hub time. */
  watch?: (t: number, run: Omit<Run, 'end'>) => void;
}

/**
 * Two clients and the scripted referee over seeded links, the hub clock in 2 ms steps and each
 * client stepping every 16 ms. Each client estimates the one-way latency as its mean.
 */
function play(opts: RunOptions = {}): Run {
  const latency = opts.latency ?? 80;
  const jitter = opts.jitter ?? 30;
  const msg = startMsg();
  const start = encounterStartOf(msg, TEST_POND);
  if (!start) throw new Error('no start');
  const referee = new ScriptedReferee(start, msg.at);
  const up = new Link<InputMsg & { slot: number }>(latency, jitter, 'up');
  const downA = new Link<HubMsg>(latency, jitter, 'down-a');
  const downB = new Link<HubMsg>(latency, jitter, 'down-b');
  const sentA: InputMsg[] = [];
  let now = 0;
  const client = (me: string, script: Script) =>
    new EncounterSync({
      me,
      sample: script,
      oneWayMs: () => latency + jitter / 2,
      send: (m) => {
        if (me === 'pa') sentA.push(m);
        if (me === 'pa' && opts.lostA?.(m.f)) return;
        up.send(now, { ...m, slot: referee.slotOf(me) });
      },
    });
  const a = client('pa', opts.scripts?.a ?? fleeing);
  const b = client('pb', opts.scripts?.b ?? changing);
  expect(a.start(msg, TEST_POND)).toBe(true);
  expect(b.start(msg, TEST_POND)).toBe(true);
  if (opts.stallAt !== undefined) downA.stallUntil = opts.stallAt + (opts.stallMs ?? 0);
  let end: EncEndMsg | null = null;
  const limit = msg.at + 100_000;
  for (now = msg.at - 200; now < limit && !(a.over && b.over); now += 2) {
    if (opts.stallAt !== undefined && now < opts.stallAt) downA.stallUntil = -Infinity;
    else if (opts.stallAt !== undefined) downA.stallUntil = opts.stallAt + (opts.stallMs ?? 0);
    for (const m of up.take(now)) referee.input(m.slot, m.f, m.i, now);
    for (const bundle of referee.due(now)) {
      downA.send(now, bundle);
      downB.send(now, bundle);
    }
    if (referee.enc.over && !end) {
      end = referee.endMsg();
      downA.send(now, opts.tamper ? opts.tamper(end) : end);
      downB.send(now, end);
    }
    for (const [sync, link] of [
      [a, downA],
      [b, downB],
    ] as const) {
      for (const m of link.take(now)) {
        if (m.t === 'enc-frame') sync.receive(m);
        if (m.t === 'enc-end') sync.end(m);
      }
    }
    if (now % 16 === 0) {
      const hidden = opts.hiddenA && now >= opts.hiddenA[0] && now < opts.hiddenA[1];
      if (!hidden) a.step(now);
      b.step(now);
      opts.watch?.(now, { a, b, referee, sentA });
    }
  }
  if (!end) throw new Error('the fight never ended');
  return { a, b, referee, end, sentA };
}

describe('leadMs', () => {
  it('is the one-way latency less 80 ms, between 0 and 100', () => {
    expect(leadMs(50)).toBe(0);
    expect(leadMs(95)).toBe(15);
    expect(leadMs(500)).toBe(100);
    expect(leadMs(Number.NaN)).toBe(0);
  });
});

describe('EncounterSync', () => {
  it('moves the own fighter in the frame its input is sampled for', () => {
    const at = 10_000;
    const msg: EncStartMsg = startMsg(at);
    const run = (moveAt: number) => {
      const sent: InputMsg[] = [];
      const sync = new EncounterSync({
        me: 'pa',
        oneWayMs: () => 0,
        send: (m) => sent.push(m),
        sample: (f) => (f >= moveAt ? input(0, 15) : IDLE_INPUT),
      });
      sync.start(msg, TEST_POND);
      return { sync, sent };
    };
    const moving = run(5);
    const still = run(Number.POSITIVE_INFINITY);
    for (let f = 0; f < 5; f++) {
      moving.sync.step(at + f * FRAME_MS);
      still.sync.step(at + f * FRAME_MS);
    }
    expect(moving.sync.frame).toBe(5);
    expect(moving.sync.ownBody()?.x).toBe(still.sync.ownBody()?.x);
    // Frame 5 begins: its input is sampled, sent and simulated in the same step.
    moving.sync.step(at + 5 * FRAME_MS);
    still.sync.step(at + 5 * FRAME_MS);
    expect(moving.sync.frame).toBe(6);
    expect(moving.sent.at(-1)).toMatchObject({ t: 'input', f: 5 });
    expect(decodeFrameInput(moving.sent.at(-1)?.i ?? 0).throttle).toBe(15);
    expect((moving.sync.ownBody()?.x ?? 0) - (still.sync.ownBody()?.x ?? 0)).toBeGreaterThan(0);
  });

  it('ends on the referee hash, rolling back only for remote inputs that differ', () => {
    let longest = 0;
    const { a, b, referee, end } = play({
      watch: (_t, r) => {
        longest = Math.max(longest, r.a.longestRollback, r.b.longestRollback);
      },
    });
    expect(referee.late).toBe(0);
    expect(referee.early).toBe(0);
    expect(a.hash).toBe(end.hash);
    expect(b.hash).toBe(end.hash);
    expect(a.desyncs + b.desyncs).toBe(0);
    expect(a.resyncs + b.resyncs).toBe(0);
    // A predicted B's first frames as the autopilot, then B changed at frames 20 and 40.
    expect(a.rollbacks).toBeGreaterThanOrEqual(1);
    expect(a.rollbacks).toBeLessThanOrEqual(3);
    expect(longest).toBeLessThanOrEqual(KEEP_FRAMES);
    expect(end.fighters.map((f) => f.outcome).sort()).toEqual(['escaped', 'stood']);
  });

  it('never rolls back for a remote that repeats its input', () => {
    const { a, end } = play({ scripts: { b: steady } });
    // Only the first bundle corrects the autopilot guess A made before it knew B's input.
    expect(a.rollbacks).toBe(1);
    expect(a.hash).toBe(end.hash);
  });

  it('resyncs once from frame 0 for a bundle 15 frames behind, and converges', () => {
    // Bundles to A stall for 1.5 s from frame 15 on, while B changes its input at frame 20.
    const msg = startMsg();
    const { a, end } = play({ stallAt: msg.at + 15 * FRAME_MS, stallMs: 15 * FRAME_MS + 300 });
    expect(a.resyncs).toBe(1);
    expect(a.hash).toBe(end.hash);
    expect(a.desyncs).toBe(0);
  });

  it('rewinds to the end when its clock ran past the frame the referee ended on', () => {
    const msg = startMsg();
    const start = encounterStartOf(msg, TEST_POND);
    if (!start) throw new Error('no start');
    const referee = new ScriptedReferee(start, msg.at);
    const bundles = referee.due(msg.at + 100_000);
    const end = referee.endMsg();
    const sync = new EncounterSync({
      me: 'pa',
      sample: () => null,
      oneWayMs: () => 100,
      send: () => {},
    });
    expect(sync.start(msg, TEST_POND)).toBe(true);
    // The bundles up to the end arrive, and the clock has already begun two frames more.
    for (const b of bundles) sync.receive(b);
    sync.step(msg.at + (end.f + 2) * FRAME_MS);
    expect(sync.frame).toBeGreaterThan(end.f);
    sync.end(end);
    expect(sync.frame).toBe(end.f);
    expect(sync.hash).toBe(end.hash);
    expect(sync.desyncs).toBe(0);
  });

  it('converges on the autopilot where the referee turned the own input into null', () => {
    const lost = (f: number) => f >= 12 && f < 18;
    const { a, b, referee, end } = play({ lostA: lost });
    const slot = referee.slotOf('pa');
    for (let f = 12; f < 18; f++) expect(referee.bundles[f]?.[slot]).toBeNull();
    expect(a.rollbacks).toBeGreaterThanOrEqual(1);
    expect(a.hash).toBe(end.hash);
    expect(b.hash).toBe(end.hash);
    expect(a.desyncs).toBe(0);
  });

  it('catches up after a hidden tab, its own frames played by the autopilot', () => {
    const at = startMsg().at;
    let caughtUp = 0;
    const { a, referee, end, sentA } = play({
      hiddenA: [at + 5 * FRAME_MS, at + 25 * FRAME_MS],
      watch: (t, r) => {
        // The first step back simulates every frame begun while hidden.
        if (t >= at + 25 * FRAME_MS && caughtUp === 0) caughtUp = r.a.frame;
      },
    });
    const slot = referee.slotOf('pa');
    for (let f = 8; f < 24; f++) expect(referee.bundles[f]?.[slot]).toBeNull();
    expect(sentA.some((m) => m.f >= 7 && m.f < 25)).toBe(false);
    expect(caughtUp).toBeGreaterThanOrEqual(25);
    expect(a.resyncs).toBe(0);
    expect(a.hash).toBe(end.hash);
  });

  it('snaps the own fighter to a different final state and counts a desync', () => {
    let told: EncEndMsg | null = null;
    const { a, b } = play({
      tamper: (end) => {
        const fighters = end.fighters.map((f) => (f.player === 'pa' ? { ...f, x: f.x + 5 } : f));
        told = { ...end, fighters };
        return told;
      },
    });
    const mine = (told as EncEndMsg | null)?.fighters.find((f) => f.player === 'pa');
    expect(a.desyncs).toBe(1);
    expect(a.ownBody()?.x).toBe(mine?.x);
    expect(b.desyncs).toBe(0);
  });

  it("eases a remote's rollback correction over 0.1 s instead of jumping", () => {
    const at = 10_000;
    const msg = startMsg(at);
    const sync = new EncounterSync({
      me: 'pa',
      oneWayMs: () => 0,
      send: () => {},
      sample: () => IDLE_INPUT,
    });
    sync.start(msg, TEST_POND);
    for (let f = 0; f < 6; f++) sync.step(at + f * FRAME_MS);
    const t = at + 5 * FRAME_MS + 50;
    const remote = 1 - sync.slot;
    const before = sync.pose(remote, t);
    // B really swam east at full throttle with a dash: every predicted frame was wrong.
    for (let f = 0; f < 6; f++) {
      const row: (number | null)[] = [null, null];
      row[sync.slot] = 0;
      row[remote] = 15 << 8;
      sync.receive({ t: 'enc-frame', enc: msg.enc, f, i: row });
    }
    sync.step(t);
    expect(sync.rollbacks).toBe(1);
    const shown = sync.pose(remote, t);
    const exact = sync.pose(remote, t, false);
    if (!before || !shown || !exact) throw new Error('no pose');
    expect(Math.hypot(exact.x - before.x, exact.y - before.y)).toBeGreaterThan(1);
    expect(shown.x).toBeCloseTo(before.x, 6);
    expect(shown.y).toBeCloseTo(before.y, 6);
    const half = sync.pose(remote, t + EASE_MS / 2);
    const halfExact = sync.pose(remote, t + EASE_MS / 2, false);
    expect(half?.x).not.toBeCloseTo(halfExact?.x ?? 0, 3);
    expect(sync.pose(remote, t + EASE_MS)).toEqual(sync.pose(remote, t + EASE_MS, false));
  });

  it('ignores bundles for another fight and counts ones of the wrong width', () => {
    const sync = new EncounterSync({
      me: 'pa',
      oneWayMs: () => 0,
      send: () => {},
      sample: () => IDLE_INPUT,
    });
    const msg = startMsg();
    sync.start(msg, TEST_POND);
    sync.receive({ t: 'enc-frame', enc: 'ff'.repeat(32), f: 0, i: [null, null] });
    expect(sync.confirmed).toBe(0);
    sync.receive({ t: 'enc-frame', enc: msg.enc, f: 0, i: [null] });
    expect(sync.dropped).toBe(1);
    expect(sync.confirmed).toBe(0);
  });

  it('refuses a start it is not in, or whose genome does not build', () => {
    const sync = new EncounterSync({
      me: 'someone-else',
      oneWayMs: () => 0,
      send: () => {},
      sample: () => IDLE_INPUT,
    });
    expect(sync.start(startMsg(), TEST_POND)).toBe(false);
    const broken = startMsg();
    broken.fighters[0] = {
      ...(broken.fighters[0] as (typeof broken.fighters)[number]),
      genome: 'x',
    };
    const me = new EncounterSync({
      me: 'pa',
      oneWayMs: () => 0,
      send: () => {},
      sample: () => IDLE_INPUT,
    });
    expect(me.start(broken, TEST_POND)).toBe(false);
    expect(me.start(startMsg(), TEST_POND)).toBe(true);
    expect(STARTER_TEXT.length).toBeGreaterThan(0);
  });
});
