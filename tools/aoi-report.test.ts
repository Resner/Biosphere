import { describe, expect, it } from 'vitest';
import { runScenario } from '../tests/aoi-harness';
import { makeScenario, SCENARIO_NAMES, type ScenarioName } from '../tests/aoi-scenarios';
import type { RunResult } from '../tests/aoi-types';
import { heavyTest } from '../tests/heavy';
import { aoiReport, REPORT_SEEDS } from './aoi-report';

describe('the area-of-interest report', () => {
  it('has a row of seeds for every scenario', () => {
    expect(Object.keys(REPORT_SEEDS).sort()).toEqual([...SCENARIO_NAMES].sort());
  });

  heavyTest('writes every scenario with its eleven gates and its metrics', () => {
    const results = Object.fromEntries(
      SCENARIO_NAMES.map((name) => [
        name,
        [runScenario(makeScenario(name, 'r', { scale: 0.2 }), 'r')],
      ]),
    ) as Record<ScenarioName, RunResult[]>;
    // Smaller worlds for the test: only the shape of the text is judged.
    const without = [runScenario(makeScenario('throng', 'r', { scale: 0.2, instances: false }), 'r')];
    const text = aoiReport(results, without);
    expect(text).toContain('### throng without instances (comparison)');
    expect(text.match(/\| 10\. Crowds/g)).toHaveLength(SCENARIO_NAMES.length + 1);
    expect(text.match(/\| 11\. Spawns/g)).toHaveLength(SCENARIO_NAMES.length + 1);
    for (const name of SCENARIO_NAMES) expect(text).toContain(`### ${name}`);
    expect(text.match(/\| 8\. Witness duties/g)).toHaveLength(SCENARIO_NAMES.length);
    expect(text.match(/\| 9\. Bandwidth/g)).toHaveLength(SCENARIO_NAMES.length);
    expect(text).toContain('Upload on the wire at 24 links');
    expect(text).toContain('Links per client');
    expect(text).toContain('Discovery latency');
  });
});
