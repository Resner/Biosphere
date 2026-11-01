import { it } from 'vitest';

/**
 * A unit test that takes seconds: a sweep over thousands of genomes or bodies, a budget over every
 * archetype, a report run. `npm run check` skips it so that every stop stays quick; `npm run
 * check:full` and CI's `unit` job run it on every PR, so it still gates every merge (ADR 0045).
 * Use it for any unit test that takes more than about 2 s; the `heavy` tag gives it 120 s.
 */
export function heavyTest(name: string, fn: () => unknown): void {
  it(name, { tags: ['heavy'] }, fn);
}
