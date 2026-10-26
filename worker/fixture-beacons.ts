import { type Beacon, roundAt, roundTime } from '../src/ledger/drand';
import rounds from '../tests/fixtures/drand/rounds.json';
import type { BeaconSource } from './beacons';

// The recorded drand rounds as a beacon source, for local E2E only (`worker/e2e-entry.ts`); the
// production entry never imports this file, so no fixture data ships.

const beacons = rounds.beacons as Beacon[];

/**
 * The fake clock starts at the first recorded round when the source is made and then advances in
 * real time. Past the last round `latest` keeps serving it and later rounds are unavailable.
 */
export function fixtureSource(start = Date.now(), wall: () => number = Date.now): BeaconSource {
  const now = (): number => roundTime(rounds.first) + (wall() - start);
  const at = (round: number): Beacon => {
    const beacon = beacons[round - rounds.first];
    if (!beacon || round > roundAt(now())) throw new Error(`round ${round} is not available`);
    return beacon;
  };
  return {
    now,
    async fetch(round) {
      const newest = Math.min(roundAt(now()), rounds.last);
      return at(round === 'latest' ? newest : round);
    },
  };
}
