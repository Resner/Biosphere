import { beforeAll, describe, expect, it } from 'vitest';
import { startMsg, TEST_POND } from '../../tests/scripted-referee';
import { createIdentity, type Identity, memoryKeyStore } from '../ledger/identity';
import { keyVerifier } from '../ledger/key-verify';
import { inputSigned, signInput, signWitnessFrame, witnessFrameSigned } from '../ledger/witness';
import { encodeFrameInput } from '../sim/encounter/codec';
import { RULES } from '../sim/rules';
import { BATCH_FRAMES } from './handover';
import type { DutyHistory } from './protocol';
import { FRAME_MS } from './referee';
import {
  type BatchMsg,
  type WitnessFrame,
  WitnessReferee,
  type WitnessRefereeOptions,
} from './witness-referee';

const E = RULES.encounter;
const CODE = encodeFrameInput({
  steer: 10,
  throttle: 1,
  dash: false,
  stance: 'balanced',
  target: 1,
  brace: false,
});

let a: Identity;
let b: Identity;
let w: Identity;
let outsider: Identity;
beforeAll(async () => {
  const make = () => createIdentity(memoryKeyStore());
  a = await make();
  b = await make();
  w = await make();
  outsider = await make();
});

/** A witness of a two-fighter duel from frame `from`, with the history's first `held` frames. */
function setup(from: number, held = from, opts: Partial<WitnessRefereeOptions> = {}) {
  const start = startMsg(10_000);
  start.fighters = start.fighters.map((f, s) => ({ ...f, player: [a, b][s]?.playerId as string }));
  const history: DutyHistory[] = Array.from({ length: held }, (_, f) => ({
    t: 'enc-frame',
    f,
    i: [CODE, CODE],
  }));
  const clock = { now: start.at };
  const frames: WitnessFrame[] = [];
  const batches: BatchMsg[] = [];
  const ref = new WitnessReferee({
    duty: { start, history, pondSeed: TEST_POND.seed, fighters: [a.playerId, b.playerId] },
    from,
    now: () => clock.now,
    signFrame: (f, i) => signWitnessFrame(w, start.enc, f, i),
    sendFrame: (ev) => frames.push(ev),
    sendBatch: (m) => batches.push(m),
    ...opts,
  });
  const at = (f: number) => start.at + f * FRAME_MS;
  const send = (who: Identity, f: number, code = CODE) =>
    ref.input(who.playerId, {
      t: 'finput',
      enc: start.enc,
      f,
      i: code,
      sig: signInput(who, start.enc, f, code),
    });
  /** Both fighters' inputs for frames `from` to `to − 1`, each sent as its frame starts. */
  const play = (to: number) => {
    for (let f = ref.next; f < to && !ref.done; f++) {
      clock.now = at(f);
      send(a, f);
      send(b, f);
    }
  };
  /** Runs the clock out to `t`, finalizing at each deadline. */
  const runTo = (t: number) => {
    while (!ref.done && ref.nextDeadline() <= t) {
      clock.now = ref.nextDeadline();
      ref.tick();
    }
    clock.now = t;
  };
  return { start, ref, frames, batches, clock, at, send, play, runTo };
}

describe('a witness’s referee (M10 T3)', () => {
  it('batches every 10 frames, and once more at the fight’s end', () => {
    const h = 5;
    const { ref, frames, batches, at, play, runTo } = setup(h);
    play(h + 25);
    // The rest is the autopilot's, each frame at its deadline, to the end.
    runTo(at(E.timeoutFrames + 2));
    expect(ref.done).toBe(true);
    expect(ref.encounter.over).toBe(true);
    const last = ref.encounter.frame;
    expect(frames.map((x) => x.f)).toEqual(Array.from({ length: last - h }, (_, k) => h + k));
    const sizes = batches.map((x) => x.i.length);
    expect(sizes.slice(0, -1).every((n) => n === BATCH_FRAMES)).toBe(true);
    expect(sizes.reduce((s, n) => s + n, 0)).toBe(last - h);
    expect(batches.map((x) => x.end)).toEqual(batches.map((_, k) => k === batches.length - 1));
    // Each batch continues the last.
    expect(batches.map((x) => x.f)).toEqual(batches.map((_, k) => h + k * BATCH_FRAMES));
    expect(ref.taken).toBe(50);
    expect(ref.frames).toBe(last - h);
  });

  it('signs every frame, and carries each input’s own signature into the batch', () => {
    const { start, ref, frames, batches, play } = setup(3);
    play(3 + BATCH_FRAMES);
    expect(batches).toHaveLength(1);
    for (const x of frames) {
      expect(witnessFrameSigned(w.playerId, start.enc, x.f, x.i, x.sig)).toBe(true);
      expect(witnessFrameSigned(a.playerId, start.enc, x.f, x.i, x.sig)).toBe(false);
    }
    const keys = [keyVerifier(a.playerId), keyVerifier(b.playerId)];
    const batch = batches[0] as BatchMsg;
    batch.i.forEach((row, k) => {
      expect(row).toEqual(frames[k]?.i);
      row.forEach((code, slot) => {
        const sig = batch.s[k]?.[slot];
        expect(code).not.toBeNull();
        expect(
          inputSigned(keys[slot] as never, start.enc, batch.f + k, code as number, sig as string),
        ).toBe(true);
      });
    });
    expect(ref.next).toBe(13);
  });

  it('gives a slot with no input the fallback marker and no signature', () => {
    const { ref, batches, clock, at, send } = setup(4);
    for (let f = 4; f < 14; f++) {
      clock.now = at(f);
      send(a, f);
      clock.now = at(f) + E.inputDeadlineMs + 1;
      ref.tick();
    }
    const batch = batches[0] as BatchMsg;
    expect(batch.i.every((row) => row[0] === CODE && row[1] === null)).toBe(true);
    expect(batch.s.every((row) => typeof row[0] === 'string' && row[1] === null)).toBe(true);
  });

  it('stops at a planned take-back with a final batch up to the frame before it', () => {
    const h = 6;
    const { ref, frames, batches, play, send } = setup(h);
    play(h + 12);
    ref.stopAt(h + 25);
    play(h + 30);
    expect(ref.done).toBe(true);
    expect(frames.map((x) => x.f).at(-1)).toBe(h + 24);
    expect(batches.map((x) => [x.f, x.i.length, x.end])).toEqual([
      [h, 10, false],
      [h + 10, 10, false],
      [h + 20, 5, true],
    ]);
    expect(send(a, h + 25)).toBe('moved');
    expect(ref.dropped.moved).toBe(1);
  });

  it('stops at once with a stop already passed, sending only the frames before it', () => {
    const h = 6;
    const { ref, batches, play } = setup(h);
    play(h + 4);
    ref.stopAt(h + 2);
    expect(ref.done).toBe(true);
    expect(batches.map((x) => [x.f, x.i.length, x.end])).toEqual([[h, 2, true]]);
  });

  it('sends nothing more after `stop`', () => {
    const { ref, frames, batches, play } = setup(2);
    play(7);
    ref.stop();
    play(30);
    expect(frames).toHaveLength(5);
    expect(batches).toHaveLength(0);
  });

  it('takes an input before its first frame as late, and drops strays and forgeries', () => {
    const h = 5;
    const { start, ref, clock, at, send } = setup(h);
    clock.now = at(h - 1);
    expect(send(a, h - 1)).toBe('late');
    expect(send(outsider, h)).toBe('stray');
    expect(
      ref.input(a.playerId, { t: 'finput', enc: 'ab'.repeat(32), f: h, i: CODE, sig: 'x' }),
    ).toBe('stray');
    const forged = signInput(a, start.enc, h, CODE + 1);
    expect(ref.input(a.playerId, { t: 'finput', enc: start.enc, f: h, i: CODE, sig: forged })).toBe(
      'forged',
    );
    expect(
      ref.input(b.playerId, {
        t: 'finput',
        enc: start.enc,
        f: h,
        i: CODE,
        sig: signInput(a, start.enc, h, CODE),
      }),
    ).toBe('forged');
    expect(send(a, h + 3)).toBe('early');
    expect(send(a, h)).toBe('ok');
    expect(send(a, h)).toBe('dup');
    expect(ref.dropped).toEqual({ late: 1, stray: 2, forged: 2, early: 1, dup: 1 });
    expect(ref.taken).toBe(1);
  });

  it('waits for the authority’s frames before its own first frame', () => {
    const h = 5;
    const { ref, frames, at, runTo } = setup(h, 2);
    expect(ref.nextDeadline()).toBe(Number.POSITIVE_INFINITY);
    runTo(at(h + 3));
    expect(frames).toHaveLength(0);
    expect(ref.hubFrame({ f: 3, i: [CODE, CODE] })).toBe(false);
    expect(ref.hubFrame({ f: 2, i: [CODE, CODE] })).toBe(true);
    expect(ref.hubFrame({ f: 3, i: [CODE, CODE] })).toBe(true);
    expect(ref.hubFrame({ f: 4, i: [CODE] })).toBe(false);
    expect(ref.hubFrame({ f: 4, i: [CODE, CODE] })).toBe(true);
    // Its frames past their deadlines are final at once, the autopilot's.
    expect(frames.map((x) => [x.f, x.i])).toEqual([
      [5, [null, null]],
      [6, [null, null]],
    ]);
    expect(ref.hubFrame({ f: 5, i: [CODE, CODE] })).toBe(false);
  });

  it('refuses a duty it cannot referee', () => {
    expect(() => setup(3, 4)).toThrow(RangeError);
    const start = startMsg(10_000);
    const base = {
      from: 0,
      now: () => 0,
      signFrame: () => '',
      sendFrame: () => {},
      sendBatch: () => {},
    };
    const fighters = start.fighters.map((f) => f.player);
    expect(
      () =>
        new WitnessReferee({
          ...base,
          duty: { start, history: [], pondSeed: TEST_POND.seed, fighters: [...fighters].reverse() },
        }),
    ).toThrow(RangeError);
    const broken = {
      ...start,
      fighters: [{ ...start.fighters[0], genome: 'x' }, start.fighters[1]],
    };
    expect(
      () =>
        new WitnessReferee({
          ...base,
          duty: { start: broken as never, history: [], pondSeed: TEST_POND.seed, fighters },
        }),
    ).toThrow(RangeError);
  });
});
