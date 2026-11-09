import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checksOf, reportOf } from './soak-report';
import type { Soak } from './soak-run';

// The committed run (`docs/perf/soak.json`, M14 T14): the first full hour that was played to its end.
// It fails, and the report says why; the checks and the report are rebuilt from the recorded JSON.

const recorded = JSON.parse(
  readFileSync(new URL('../docs/perf/soak.json', import.meta.url), 'utf8'),
) as Soak;

describe('the recorded soak', () => {
  it('fails its checks the way the report says', () => {
    const failed = checksOf(recorded)
      .filter((c) => !c.ok)
      .map((c) => c.name);
    expect(failed).toContain('authority memory level');
    expect(failed).toContain('rows written per player-hour');
    expect(failed).toContain('no socket closed for its rate');
    // Every page check held: heap, resources and frame times stayed level over the hour.
    expect(failed.filter((n) => n.startsWith('page '))).toEqual([]);
  });

  it('builds the committed report byte for byte', () => {
    expect(reportOf(recorded)).toBe(
      readFileSync(new URL('../docs/perf/soak.md', import.meta.url), 'utf8'),
    );
  });
});
