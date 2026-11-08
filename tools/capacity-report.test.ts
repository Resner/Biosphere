import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { logWindowDays } from '../worker/capacity';
import { MEASURED, TABLES } from '../worker/plan';
import { measuredFrom } from './capacity-measure';
import { capacityReport, overridesFrom } from './capacity-report';

// M13 T8: `worker/plan.ts` holds what the committed measurements give, and `docs/CAPACITY.md` is
// those measurements regenerated. A change to a measurement that does not regenerate both fails here.

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const json = (name: string) => JSON.parse(read(`docs/perf/${name}.json`));
const inputs = () => ({
  load: json('load'),
  hub: json('hub'),
  hubLoad: json('hub-load'),
  storage: json('storage'),
  witness: json('witness'),
});

describe('the capacity report', () => {
  it('plan.ts constants equal what the committed measurements give', () => {
    // Regenerate with `node tools/capacity.mjs --write-measured` after `npm run report:storage` etc.
    expect(MEASURED).toEqual(measuredFrom(inputs()));
  });

  it('docs/CAPACITY.md regenerates byte for byte', () => {
    expect(capacityReport(inputs())).toBe(read('docs/CAPACITY.md'));
  });

  it('answers its four questions on the first screen', () => {
    const first = read('docs/CAPACITY.md').split('## Assumptions')[0] ?? '';
    expect(first).toMatch(/free plan\*\* serves \*\*[\d,]+ player-hours a day/);
    expect(first).toMatch(/concurrent players\*\* around the clock within \*\*\$9\.50/);
    expect(first).toMatch(/One authority object\*\* serves \*\*[\d,]+ concurrent players/);
    expect(first).toMatch(/10,000 concurrent players\*\* need \*\*\d+ objects/);
  });

  it('the log window in the code is what the rule gives', () => {
    // Read from the source: the worker's own types stay out of the tools' type check.
    const kept = /export const LOG_KEEP_DAYS = (\d+);/.exec(read('worker/fight-store.ts'));
    expect(Number(kept?.[1])).toBe(logWindowDays(MEASURED, TABLES));
  });

  it('a saved /v1/metrics answer replaces the per-player numbers it measures', () => {
    const today = {
      playerMs: 10 * 3_600_000,
      messages: 12_000,
      requests: 700,
      rowsWritten: 400,
      rowsRead: 900,
      relay: { kb: 5_000_000 },
    };
    const over = overridesFrom({ today });
    expect(over.messagesPerHour).toBe(1200);
    expect(over.requestsPerHour).toBe(70);
    expect(over.rowsWrittenPerHour).toBe(40);
    expect(over.turnGbPerHour).toBeCloseTo(0.5, 9);
    expect(overridesFrom(null)).toEqual({});
    const text = capacityReport(inputs(), { today });
    expect(text).not.toBe(read('docs/CAPACITY.md'));
  });
});
