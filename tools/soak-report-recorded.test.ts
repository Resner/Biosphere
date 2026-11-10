import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checksOf, reportOf } from './soak-report';
import type { Soak } from './soak-run';

// The committed run (`docs/perf/soak.json`, M14 T14e): the latest full hour played on a runner. It
// fails, and the report says why; the checks and the report are rebuilt from the recorded JSON.

const recorded = JSON.parse(
  readFileSync(new URL('../docs/perf/soak.json', import.meta.url), 'utf8'),
) as Soak;

describe('the recorded soak', () => {
  it('fails its checks the way the report says', () => {
    const failed = checksOf(recorded)
      .filter((c) => !c.ok)
      .map((c) => c.name);
    // What an hour of 200 clients now shows: no socket closed for its rate, the object's heap and CPU
    // per message level, every creature consistent; and what is still open (T14g).
    expect(failed).toEqual([
      'no audit flag but authority-only',
      'no audit flag at any sample',
      'page 1 played and reloaded',
    ]);
  });

  it('builds the committed report byte for byte', () => {
    expect(reportOf(recorded)).toBe(
      readFileSync(new URL('../docs/perf/soak.md', import.meta.url), 'utf8'),
    );
  });
});
