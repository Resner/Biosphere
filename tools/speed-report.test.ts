import { describe, expect, it } from 'vitest';
import { genesisGenome } from '../src/genome/genesis';
import { starterGenome } from '../src/genome/starter';
import { buildCreature } from '../src/genome/stats';
import { seedFromString } from '../src/sim/prng';
import { parseArgs, speedReport, speedsOf } from './speed-report';

describe('speed report', () => {
  const text = speedReport({ bodies: 40, generations: 2 });

  it('has the starter line and the four sets', () => {
    for (const heading of [
      '# Speed report',
      '## M1 starter at hatch',
      '## Genesis bodies at hatch (biomass 80)',
      '## Genesis bodies as adults',
      '## Bred bodies at hatch (2 generations)',
      '## Bred bodies as adults (2 generations)',
    ]) {
      expect(text, heading).toContain(heading);
    }
  });

  it('shows every measure at every percentile', () => {
    for (const row of [
      'Top speed (wu/s)',
      'Top speed (body radii/s)',
      'Top speed (screen heights/s)',
      'Dash speed (wu/s)',
      'Turning (rad/s)',
    ]) {
      expect(text.split(row).length - 1, row).toBe(4);
    }
    expect(text).toContain('| Measure | p1 | p10 | median | p90 | p99 | max |');
  });

  it('is deterministic', () => {
    expect(speedReport({ bodies: 40, generations: 2 })).toBe(text);
  });

  it('reproduces the starter: 63.6 wu/s at 100 biomass, dash 120', () => {
    const c = buildCreature(starterGenome());
    const s = speedsOf(c.phys, 100, c.traits.body.maxBiomass);
    expect(s.top).toBeCloseTo(63.6, 1);
    expect(s.dash).toBeCloseTo(120, 5);
    expect(s.turn).toBeCloseTo(5, 5);
  });

  it('keeps every genesis body under 0.8 screen heights per second at every size (camera check)', () => {
    let worst = 0;
    for (let i = 0; i < 300; i++) {
      const c = buildCreature(genesisGenome(seedFromString(`speed-camera-${i}`)));
      const max = c.traits.body.maxBiomass;
      // From the hatchling to the adult, the zoom follows the creature out as it grows.
      for (const b of [80, max * 0.1, max * 0.25, max * 0.5, max]) {
        if (b >= 80 && b <= max) worst = Math.max(worst, speedsOf(c.phys, b, max).screens);
      }
    }
    expect(worst).toBeLessThan(0.8);
  });

  it('reads the command line', () => {
    expect(parseArgs(['--bodies', '500', '--generations', '3'])).toEqual({
      bodies: 500,
      generations: 3,
    });
    expect(parseArgs([])).toEqual({ bodies: 1000, generations: 6 });
    expect(() => parseArgs(['--bodies', 'x'])).toThrow();
  });
});
