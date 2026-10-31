import { describe, expect, it } from 'vitest';
import { diversityReport, parseArgs } from './diversity-report';

describe('diversity report', () => {
  const text = diversityReport({ genesis: 60, bred: 60, generations: 3 });

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

  it('bristles at least half of the bred parts but the whip with 6 or more setae (M6b T7)', () => {
    const line = text.split('\n').find((l) => l.startsWith('- Bred parts but the whip')) as string;
    const share = Number(/([\d.]+)% with 6\+ bristles/.exec(line)?.[1]);
    expect(share).toBeGreaterThanOrEqual(50);
  });

  it('is deterministic apart from the timings', () => {
    const strip = (t: string): string => t.split('## Development time')[0] as string;
    expect(strip(diversityReport({ genesis: 60, bred: 60, generations: 3 }))).toBe(strip(text));
  });

  it('reads the command line', () => {
    expect(parseArgs(['--genesis', '2000', '--bred', '2000', '--generations', '6'])).toEqual({
      genesis: 2000,
      bred: 2000,
      generations: 6,
    });
    expect(parseArgs([])).toEqual({ genesis: 2000, bred: 2000, generations: 6 });
    expect(() => parseArgs(['--genesis', 'x'])).toThrow();
  });
});
