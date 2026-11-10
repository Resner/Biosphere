import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checksOf, reportOf } from './soak-report';
import type { Soak } from './soak-run';

// The committed run (`docs/perf/soak.json`, M14 T14g): the latest full hour played on a runner. It
// passes every check; the checks and the report are rebuilt from the recorded JSON.

const recorded = JSON.parse(
  readFileSync(new URL('../docs/perf/soak.json', import.meta.url), 'utf8'),
) as Soak;

describe('the recorded soak', () => {
  it('passes every check', () => {
    const failed = checksOf(recorded)
      .filter((c) => !c.ok)
      .map((c) => c.name);
    expect(failed).toEqual([]);
    expect(recorded.failures).toEqual([]);
  });

  it('builds the committed report byte for byte', () => {
    expect(reportOf(recorded)).toBe(
      readFileSync(new URL('../docs/perf/soak.md', import.meta.url), 'utf8'),
    );
  });
});
