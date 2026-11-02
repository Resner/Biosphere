import { describe, expect, it } from 'vitest';
import { heavyTest } from '../tests/heavy';
import { BRISTLED, diversityReport, parseArgs } from './diversity-report';

describe('diversity report', () => {
  const text = diversityReport({ genesis: 60, bred: 60, generations: 3, evolved: 1 });

  it('has every section', () => {
    for (const heading of [
      '# Diversity report',
      '## Bodies',
      '## Segments',
      '## Appendages',
      '## Silhouettes',
      '## Genesis silhouettes',
      '## Size tiers',
      '## Rarity',
      '## Looks',
      '## Legs',
      '## Evolved Lab grids',
      '## Evolved silhouettes',
      '## Mesh vertices',
      '## Development time',
    ]) {
      expect(text, heading).toContain(heading);
    }
  });

  it('reports zero invalid bodies out of the whole sample', () => {
    expect(text).toContain('Valid bodies: 120 of 120 (0 invalid)');
    expect(text).toContain('Genesis: 60');
    expect(text).toContain('Bred: 60 over 3 generations');
  });

  it('bristles at least half of the bred legs with a quarter of the most setae (M6b T7)', () => {
    const report = diversityReport({ genesis: 200, bred: 600, generations: 6, evolved: 1 });
    const line = report.split('\n').find((l) => l.startsWith('- Bred legs')) as string;
    expect(BRISTLED).toBe(3);
    const share = Number(/([\d.]+)% with 3 or more bristles/.exec(line)?.[1]);
    expect(Number(/: (\d+),/.exec(line)?.[1])).toBeGreaterThan(500);
    expect(share).toBeGreaterThanOrEqual(50);
  });

  it('is deterministic apart from the timings', () => {
    const strip = (t: string): string => t.split('## Development time')[0] as string;
    expect(strip(diversityReport({ genesis: 60, bred: 60, generations: 3, evolved: 1 }))).toBe(
      strip(text),
    );
  });

  it('reads the command line', () => {
    expect(
      parseArgs(['--genesis', '2000', '--bred', '2000', '--generations', '6', '--evolved', '3']),
    ).toEqual({ genesis: 2000, bred: 2000, generations: 6, evolved: 3 });
    expect(parseArgs([])).toEqual({ genesis: 2000, bred: 2000, generations: 6, evolved: 10 });
    expect(() => parseArgs(['--genesis', 'x'])).toThrow();
  });

  heavyTest('shows five or more silhouette classes in 9 of 10 Evolved grids (M6c T5)', () => {
    const report = diversityReport({ genesis: 1, bred: 1, generations: 1, evolved: 10 });
    const line = report.split('\n').find((l) => l.startsWith('- Grids with')) as string;
    expect(line).toMatch(/^- Grids with 5 or more classes: \d+ of 10$/);
    expect(Number(/: (\d+) of/.exec(line)?.[1])).toBeGreaterThanOrEqual(9);
  });
});
