import { beforeEach, describe, expect } from 'vitest';
import { heavyTest } from '../tests/heavy';
import {
  FARM_SIZES,
  farmReport,
  gatesOf,
  HONEST_GAIN_PER_MIN,
  HOUR,
  type Measure,
  MIN,
} from '../tools/farm-sim';
import { runScenario, type Scenario } from './farm-kit';
import { clock, useFightHub } from './fight-test-kit';

// M10 T13 (ADR 0059): the bot-farm simulation. Scripted identities on one hub, on the hand clock, under
// the live rules and scales, for 3 hours of play, with the fixture beacons; each scenario prints its
// `FARM_MEASURE` line, which `npm run report:farm` turns into `docs/perf/farm.md`. The last test holds
// every farm to the gates of ADR 0059 against the honest pair.

useFightHub();
// A fixed start, so a rerun draws the same genomes (the hub's hand clock otherwise starts at the real now).
beforeEach(() => {
  clock.t = Date.UTC(2026, 10, 6, 12, 0, 0);
});

const honestPace = { perMinute: HONEST_GAIN_PER_MIN };
const HONEST: Scenario = {
  name: 'honest',
  bots: 1,
  farmer: honestPace,
  botGrowth: honestPace,
  hours: 1,
  killEveryMs: 0,
};
const farm = (bots: number): Scenario => ({
  name: `farm-${bots}`,
  bots,
  farmer: 'max',
  botGrowth: 'max',
  hours: 3,
  killEveryMs: 6 * MIN,
});

const measures = new Map<string, Measure>();
async function measure(s: Scenario): Promise<Measure> {
  const m = await runScenario(s);
  measures.set(s.name, m);
  console.log(`FARM_MEASURE ${JSON.stringify(m)}`);
  return m;
}

describe('the farm simulation', () => {
  heavyTest('the honest pair reaches generation 3 on the gates alone', async () => {
    const m = await measure(HONEST);
    expect(m.gen3AtMs).not.toBeNull();
    expect(m.hours * HOUR).toBeGreaterThan(m.gen3AtMs ?? Number.POSITIVE_INFINITY);
  });

  for (const bots of FARM_SIZES) {
    heavyTest(`a farmer with ${bots} bots meets the gates`, async () => {
      const honest = measures.get('honest');
      if (!honest) throw new Error('the honest pair runs first');
      const m = await measure(farm(bots));
      for (const gate of gatesOf(m, honest)) {
        expect(gate.ok, `${gate.n}. ${gate.name}: ${gate.detail}`).toBe(true);
      }
    });
  }

  heavyTest('the report states every gate of every farm as met', () => {
    const report = farmReport([...measures.values()]);
    expect(report).not.toContain('MISSED');
    expect(report.match(/\| met \|/g)).toHaveLength(FARM_SIZES.length * 5);
  });
});
