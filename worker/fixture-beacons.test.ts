import { describe, expect, it } from 'vitest';
import { roundAt } from '../src/ledger/drand';
import rounds from '../tests/fixtures/drand/rounds.json';
import soak from '../tests/fixtures/drand/soak-rounds.json';
import { fixtureSource } from './fixture-beacons';

// The recorded rounds as a beacon source (E2E only). `rounds.json` lasts 30 minutes of the source's
// clock; `soak-rounds.json` (M14 T14) starts at the same round and lasts 80, for the one-hour soak.

describe('the recorded rounds', () => {
  it('stop at the last round of rounds.json, so a longer run needs the soak set', async () => {
    let wall = 0;
    const source = fixtureSource(0, () => wall);
    wall = 40 * 60_000;
    expect((await source.fetch('latest')).round).toBe(rounds.last);
    await expect(source.fetch(rounds.last + 1)).rejects.toThrow('not available');
  });

  it('run on for 80 minutes in the soak set, with the same first 600 rounds', async () => {
    expect(soak.first).toBe(rounds.first);
    expect(soak.beacons.slice(0, rounds.beacons.length)).toEqual(rounds.beacons);
    let wall = 0;
    const source = fixtureSource(0, () => wall, soak);
    wall = 70 * 60_000;
    const latest = await source.fetch('latest');
    expect(latest.round).toBe(roundAt(source.now()));
    expect(latest.round).toBeGreaterThan(rounds.last + 600);
    expect((await source.fetch(rounds.last + 1)).round).toBe(rounds.last + 1);
    expect(soak.last - soak.first + 1).toBe(soak.beacons.length);
  });
});
