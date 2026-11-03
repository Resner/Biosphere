import { describe, expect, it } from 'vitest';
import {
  drive,
  hunterFighter,
  IDLE_CODE,
  starterFighter,
  startOf,
} from '../../../tests/encounter-fixture';
import { RULES, RULES_VERSION } from '../rules';
import { createEncounter, hashEncounter, results, stepFrame } from './encounter';
import { joinFighter } from './join';
import { type EncounterLog, replayEncounter } from './replay';

const E = RULES.encounter;

const pair = () =>
  createEncounter(
    startOf('join', [starterFighter('b', 5200, 3000), starterFighter('m', 5240, 3000, Math.PI)]),
  );

const steps = (enc: ReturnType<typeof pair>, n: number) => {
  for (let i = 0; i < n; i++)
    stepFrame(
      enc,
      enc.fighters.map(() => IDLE_CODE),
    );
};

describe('joinFighter', () => {
  it('seats the joiner in the next slot, born at the current tick, whatever its id', () => {
    const enc = pair();
    steps(enc, 5);
    const slot = joinFighter(enc, starterFighter('a', 5220, 3040), 5);
    expect(slot).toBe(2);
    expect(enc.fighters.map((f) => f.creature)).toEqual(['b', 'm', 'a']);
    const joined = enc.fighters[2];
    expect(joined?.slot).toBe(2);
    expect(joined?.body.bornTick).toBe(1000 + 5 * E.frameTicks);
    expect(joined?.body.x).toBe(5220);
    expect(joined?.status).toBe('in');
  });

  it('moves the joiner by its own input from its join frame on', () => {
    const enc = pair();
    enc.world.options.currents = false;
    steps(enc, 2);
    joinFighter(enc, starterFighter('a', 5220, 3200), 2);
    stepFrame(enc, [IDLE_CODE, IDLE_CODE, drive(0, 15)]);
    expect(enc.fighters[2]?.body.x).toBeGreaterThan(5220);
    expect(enc.fighters[2]?.body.vx).toBeGreaterThan(0);
  });

  it('refuses a join at another frame, into a full fight, twice, or of a bad body', () => {
    const enc = pair();
    steps(enc, 3);
    expect(() => joinFighter(enc, starterFighter('a', 5220, 3040), 4)).toThrow(RangeError);
    expect(() => joinFighter(enc, starterFighter('a', 5220, 3040), 2)).toThrow(RangeError);
    expect(() => joinFighter(enc, starterFighter('b', 5220, 3040), 3)).toThrow(RangeError);
    expect(() =>
      joinFighter(enc, { ...starterFighter('a', 5220, 3040), y: Number.NaN }, 3),
    ).toThrow(RangeError);
    joinFighter(enc, starterFighter('c', 5220, 3040), 3);
    joinFighter(enc, starterFighter('d', 5220, 2960), 3);
    expect(enc.fighters).toHaveLength(E.maxFighters);
    expect(() => joinFighter(enc, starterFighter('e', 5220, 3080), 3)).toThrow(RangeError);
  });

  it('takes nobody into a fight that is over', () => {
    const enc = pair();
    enc.over = true;
    const before = hashEncounter(enc);
    expect(joinFighter(enc, starterFighter('a', 5220, 3040), enc.frame)).toBe(-1);
    expect(hashEncounter(enc)).toBe(before);
  });

  it('a log with a join replays to the same hash twice, and the join changes the hash', () => {
    const start = startOf('join-replay', [
      hunterFighter('b', 5200, 3000),
      starterFighter('m', 5242, 3000, Math.PI),
    ]);
    const frames: EncounterLog['frames'] = Array.from({ length: 40 }, (_, f) =>
      f < 10 ? [drive(0, 4), IDLE_CODE] : [drive(0, 4), IDLE_CODE, drive(192, 6, { target: 1 })],
    );
    const log: EncounterLog = {
      rules: RULES_VERSION,
      start,
      frames,
      joins: [{ f: 10, fighter: hunterFighter('c', 5242, 3045, -Math.PI / 2) }],
    };
    const first = replayEncounter(log);
    expect(replayEncounter(structuredClone(log))).toEqual(first);
    expect(first.results).toHaveLength(3);
    const alone = replayEncounter({ ...log, joins: [], frames: frames.map((f) => f.slice(0, 2)) });
    expect(alone.hash).not.toBe(first.hash);
  });

  it('a stepped encounter with a join hashes as its structured clone', () => {
    const enc = pair();
    steps(enc, 4);
    joinFighter(enc, { ...starterFighter('a', 5220, 3040), egg: true }, 4);
    steps(enc, 6);
    expect(hashEncounter(structuredClone(enc))).toBe(hashEncounter(enc));
    expect(results(enc)).toHaveLength(3);
  });
});
