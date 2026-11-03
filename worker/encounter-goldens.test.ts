import { describe, expect, it } from 'vitest';
import approach from '../src/sim/__golden__/encounter-approach.json';
import autopilot from '../src/sim/__golden__/encounter-autopilot.json';
import duel from '../src/sim/__golden__/encounter-duel.json';
import egg from '../src/sim/__golden__/encounter-egg.json';
import fleeing from '../src/sim/__golden__/encounter-escape.json';
import plume from '../src/sim/__golden__/encounter-plume.json';
import { type EncounterLog, replayEncounter } from '../src/sim/encounter/replay';

// M7 T9: the referee steps the same encounter as every client, so the encounter goldens (pinned in
// Node by `src/sim/encounter/replay.test.ts`) must replay to the same hashes inside workerd.

const GOLDENS = { approach, autopilot, duel, egg, escape: fleeing, plume } as unknown as Record<
  string,
  { log: EncounterLog; hash: string; results: unknown }
>;

describe('encounter goldens in workerd', () => {
  for (const [name, golden] of Object.entries(GOLDENS)) {
    it(`encounter-${name} replays to its pinned hash`, () => {
      const replayed = replayEncounter(golden.log);
      expect(replayed.hash).toBe(golden.hash);
      expect(replayed.results).toEqual(golden.results);
    });
  }
});
