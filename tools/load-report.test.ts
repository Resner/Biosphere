import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MSG_TYPES, OPS } from '../tests/aoi-meter';
import {
  LOAD_HIDDEN_PER_MILLION,
  LOAD_JOIN_P95,
  LOAD_MSG_MEAN,
  LOAD_MSG_MEDIAN,
  LOAD_MSG_P95,
} from '../tests/load';
import type { LoadMeasure } from './load-report';

// The committed load report (M13 T5): the numbers of one 10,000-player run, read against the gates.

const measure = JSON.parse(
  readFileSync(new URL('../docs/perf/load.json', import.meta.url), 'utf8'),
) as LoadMeasure;
const text = readFileSync(new URL('../docs/perf/load.md', import.meta.url), 'utf8');

describe('docs/perf/load.json', () => {
  it('is a run at 10,000 players that passes its six gates', () => {
    expect(measure.players).toBe(10_000);
    expect(measure.gates.map((g) => g.n)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(measure.gates.filter((g) => !g.ok)).toEqual([]);
    expect(measure.ok).toBe(true);
  });

  it('holds every message type and every timed operation, and the hold minute by minute', () => {
    for (const t of MSG_TYPES) expect(measure.messages[t]).toBeGreaterThanOrEqual(0);
    expect(measure.ops.map((o) => o.op)).toEqual([...OPS]);
    for (const o of measure.ops) expect(o.count, o.op).toBeGreaterThan(0);
    expect(measure.holdSeries.length).toBe(6);
    expect(measure.heapBytes).toBeGreaterThan(0);
    expect(measure.wallSeconds).toBeGreaterThan(0);
  });

  it('reads the gates at the ADR 0070 thresholds', () => {
    expect([LOAD_MSG_MEDIAN, LOAD_MSG_P95, LOAD_JOIN_P95, LOAD_MSG_MEAN]).toEqual([8, 20, 100, 12]);
    expect(LOAD_HIDDEN_PER_MILLION).toBe(1);
    // The recorded hold sits inside them.
    for (const row of measure.holdSeries) {
      expect(row.median).toBeLessThanOrEqual(LOAD_MSG_MEDIAN);
      expect(row.p95).toBeLessThanOrEqual(LOAD_MSG_P95);
      expect(row.mean).toBeLessThanOrEqual(LOAD_MSG_MEAN);
    }
  });
});

describe('docs/perf/load.md', () => {
  it('prints the gates, the fill, the hold and a timings section apart', () => {
    for (const heading of [
      '## Gates',
      '## Result',
      '## Messages by type',
      '## The fill, minute by minute',
      '## The hold, minute by minute',
      '## Timings (machine-dependent)',
    ])
      expect(text).toContain(heading);
    expect(text).not.toContain('FAIL');
    // Nothing that varies with the machine sits above the timings section.
    const [before] = text.split('## Timings (machine-dependent)');
    expect(before).not.toMatch(/wall time/i);
  });
});
