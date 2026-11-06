import { describe, expect, it } from 'vitest';
import { framesRoot } from '../src/ledger/settlement';
import { encounterStartOf } from '../src/net/encounter-start';
import { KEEP_FRAMES } from '../src/net/encounter-sync';
import { FRAME_MS } from '../src/net/referee';
import { RULES } from '../src/sim/rules';
import { heavyTest } from './heavy';
import { type HarnessResult, runHarness, scriptedInputs } from './net-harness';
import { ScriptedReferee, startMsg, TEST_POND } from './scripted-referee';

const E = RULES.encounter;
const link = (oneWayMs: number, jitterMs: number, loss: number, clockErrMs: number) => ({
  oneWayMs,
  jitterMs,
  loss,
  clockErrMs,
});
const share = (r: HarnessResult, i: number): number => {
  const c = r.clients[i] as HarnessResult['clients'][number];
  return c.onTime / c.sent;
};

describe('net harness (M8 T13)', () => {
  it('replays the same run for the same options', () => {
    const o = { seed: 'same', clients: 2, link: link(80, 30, 0.02, 20) };
    const a = runHarness(o);
    const b = runHarness(o);
    expect(b.refereeHash).toBe(a.refereeHash);
    expect(b.bundles).toEqual(a.bundles);
    expect(b.clients).toEqual(a.clients);
    expect(runHarness({ ...o, seed: 'other' }).refereeHash).not.toBe(a.refereeHash);
  });

  it('scripts the same inputs for a seed, whatever the order they are asked in', () => {
    const one = scriptedInputs('s');
    const two = scriptedInputs('s');
    const last = two(30);
    for (let f = 0; f <= 30; f++) expect(one(f)).toEqual(two(f));
    expect(one(30)).toEqual(last);
  });

  heavyTest('clients 2 to 4 over an ideal link end on the referee’s hash', () => {
    for (const n of [2, 3, 4]) {
      const r = runHarness({ seed: 'ideal', clients: n, link: link(0, 0, 0, 0) });
      expect(r.converged, `${n} clients`).toBe(true);
      expect(r.clients.every((c) => c.desyncs === 0)).toBe(true);
    }
  });

  heavyTest('a good link keeps at least 95% of own inputs on time', () => {
    for (const oneWay of [20, 80, 150]) {
      for (const jitter of [0, 30]) {
        for (const err of [0, 20]) {
          for (const seed of ['a', 'b']) {
            const r = runHarness({ seed, clients: 3, link: link(oneWay, jitter, 0, err) });
            for (let i = 0; i < r.clients.length; i++) {
              expect(
                share(r, i),
                `client ${i} at ${oneWay}/${jitter}/${err} (${seed})`,
              ).toBeGreaterThanOrEqual(0.95);
            }
          }
        }
      }
    }
  });

  heavyTest('lossy and slow links still end on the referee’s hash, with bounded rollbacks', () => {
    for (const oneWay of [20, 150, 250]) {
      for (const jitter of [0, 60]) {
        for (const loss of [0, 0.05]) {
          for (const err of [0, 60]) {
            const r = runHarness({
              seed: 'grid',
              clients: 2,
              link: link(oneWay, jitter, loss, err),
            });
            const cell = `${oneWay}/${jitter}/${loss}/${err}`;
            expect(r.converged, cell).toBe(true);
            for (const c of r.clients) {
              expect(c.desyncs, cell).toBe(0);
              expect(c.longestRollback, cell).toBeLessThanOrEqual(KEEP_FRAMES);
            }
          }
        }
      }
    }
  });

  heavyTest('a 5 s disconnect converges with one resync, the autopilot playing the gap', () => {
    const from = 3000;
    const r = runHarness({
      seed: 'cut',
      clients: 2,
      link: link(80, 30, 0, 20),
      disconnect: { client: 0, from, to: from + 5000 },
    });
    expect(r.converged).toBe(true);
    expect(r.clients[0]?.rejoins).toBe(1);
    expect(r.clients[1]?.rejoins).toBe(0);
    // Frames whose deadline fell inside the gap hold no input of the cut client.
    const gapFrom = Math.ceil((from + E.inputDeadlineMs + 300) / FRAME_MS);
    const gapTo = Math.floor((from + 5000 - 300) / FRAME_MS);
    expect(r.frames).toBeGreaterThan(gapTo);
    for (let f = gapFrom; f < gapTo; f++) expect(r.bundles[f]?.[0], `frame ${f}`).toBeNull();
  });
});

describe('a witness phase (M10 T3)', () => {
  // A calm duel long enough for a witness's span and a take-back.
  const o = { seed: 'witness-19', clients: 2, link: link(20, 0, 0, 0), calm: true };
  const phase = { from: 33, until: 120, oneWayMs: 20, jitterMs: 0, clockErrMs: 0 };

  it('gives the same frames, root and hash refereed by the authority alone or by a witness from 33 to 119', () => {
    const alone = runHarness(o);
    const witnessed = runHarness({ ...o, witness: phase });
    expect(alone.frames).toBeGreaterThan(phase.until + 10);
    expect(alone.witness).toBeNull();
    expect(witnessed.witness).toMatchObject({ frames: phase.until - phase.from, hash: null });
    // Every input was delivered in both runs, so both refereed the same frames.
    expect(alone.bundles.every((row) => row.every((code) => code !== null))).toBe(true);
    expect(witnessed.bundles).toEqual(alone.bundles);
    expect(framesRoot(witnessed.bundles)).toBe(framesRoot(alone.bundles));
    expect(witnessed.refereeHash).toBe(alone.refereeHash);
    expect(alone.converged).toBe(true);
    expect(witnessed.converged).toBe(true);
    for (const c of witnessed.clients) {
      expect(c.onTime).toBe(c.sent);
      expect([c.resyncs, c.overruled, c.disputes, c.desyncs]).toEqual([0, 0, 0, 0]);
    }
    expect(runHarness({ ...o, witness: phase })).toEqual(witnessed);
  });

  it('ends on the witness’s hash when it referees the fight’s end', () => {
    const r = runHarness({
      ...o,
      witness: { from: phase.from, oneWayMs: 80, jitterMs: 0, clockErrMs: 0 },
    });
    expect(r.witness?.hash).toBe(r.refereeHash);
    expect(r.witness?.batches).toBe(Math.ceil((r.frames - phase.from) / 10));
    expect(r.converged).toBe(true);
  });
});

describe('the referee’s clock under every clock error (M8 T13)', () => {
  const setup = () => {
    const msg = startMsg(10_000, 5200, 3000, 2);
    const start = encounterStartOf(msg, TEST_POND.seed);
    if (!start) throw new Error('no start');
    return { msg, referee: new ScriptedReferee(start, msg.at) };
  };

  it('never lets an input for a finalized frame change a bundle, however the sender’s clock is off', () => {
    for (const err of [0, 20, 60, 500]) {
      const { msg, referee } = setup();
      referee.input(1, 0, 7, msg.at + 10);
      const frames = referee.due(msg.at + E.inputDeadlineMs + 1);
      expect(frames.map((f) => f.f)).toEqual([0]);
      const final = structuredClone(referee.bundles[0]);
      referee.input(0, 0, 9, msg.at + E.inputDeadlineMs + 1 + err);
      expect(referee.late).toBe(1);
      expect(referee.bundles[0]).toEqual(final);
      expect(final).toEqual([null, 7]);
    }
  });

  it('refuses an input after its frame’s deadline as late', () => {
    const { msg, referee } = setup();
    referee.input(0, 3, 5, msg.at + 3 * FRAME_MS + E.inputDeadlineMs + 1);
    expect(referee.late).toBe(1);
  });

  it('refuses an input more than 2 frames ahead as early, and takes one 2 ahead', () => {
    const { msg, referee } = setup();
    referee.input(0, 3, 5, msg.at);
    expect(referee.early).toBe(1);
    referee.input(0, 2, 5, msg.at);
    referee.input(1, 2, 6, msg.at);
    expect(referee.early).toBe(1);
    expect(referee.due(msg.at + 2 * FRAME_MS + E.inputDeadlineMs + 1).map((f) => f.f)).toEqual([
      0, 1, 2,
    ]);
    expect(referee.bundles[2]).toEqual([5, 6]);
  });
});
