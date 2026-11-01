import { describe, expect, it } from 'vitest';
import { buildGenome, type Params } from '../../tests/archetypes';
import { PI } from '../sim/math';
import { RULES } from '../sim/rules';
import { type BodyPlan, bodyViolations, develop } from './develop';
import { express } from './express';
import { HEAD_CONE, type Region, regionOf, rolesOf, spineShare, visibleCount } from './organism';

// A body plan reads as an organism (M6c T3, ADR 0041): hand-built bodies for the region rules and
// the visible-part budget. The properties over random and mutated genomes are in
// `develop-curl.test.ts`, on the shared plan cache.

const ANTENNA: Params = {
  length: 240,
  thickness: 20,
  angle: 30,
  beat: 40,
  attachStart: 0,
  tipShape: 255,
};
const FEELER: Params = { ...ANTENNA, length: 90, angle: 80 };
/** Three leg pairs from the front of the trunk and two more behind them. */
const LEGS: Params = {
  length: 110,
  thickness: 60,
  angle: 128,
  beat: 220,
  pairs: 255,
  attachStart: 40,
  attachSpan: 150,
  tipShape: 190,
};
const LEGS2: Params = { ...LEGS, angle: 150, pairs: 128, attachStart: 120, attachSpan: 120 };
const FURCA: Params = {
  length: 100,
  thickness: 40,
  angle: 235,
  beat: 120,
  attachStart: 255,
  tipShape: 200,
};
/** Eight segments, the front half under a carapace: a copepod. */
const BODY = { segDrive1: 255, segDrive2: 200, fusion: 140, aspect: 180 };

const plan = (modules: Record<string, Params>, set = BODY): BodyPlan =>
  develop(express(buildGenome(modules, set)));
const left = (p: BodyPlan) => p.appendages.filter((a) => a.side === 1);
const shownIn = (p: BodyPlan, region: Region) =>
  left(p).filter((a) => !a.fringe && regionOf(a, p) === region);

describe('parts by region (M6c T3, ADR 0041)', () => {
  it('reads a root by where it lies along the spine and its angle', () => {
    const p = plan({ M1: ANTENNA, M2: LEGS, M3: LEGS2, M4: FURCA });
    const at = (module: number) => left(p).filter((a) => a.module === module);
    expect(at(0).map((a) => regionOf(a, p))).toEqual(['head']);
    for (const a of [...at(1), ...at(2)]) expect(regionOf(a, p)).toBe('trunk');
    expect(at(3).map((a) => regionOf(a, p))).toEqual(['rear']);
    // The head's cone: a front root pointing sideways is a leg.
    expect(HEAD_CONE).toBeCloseTo((70 * PI) / 180, 12);
    expect(regionOf({ segment: 0, angle: HEAD_CONE + 0.01 }, p)).toBe('trunk');
  });

  it('keeps a copepod with long antennae, 5 leg pairs and a furca whole: 14 instances', () => {
    const p = plan({ M1: ANTENNA, M2: LEGS, M3: LEGS2, M4: FURCA });
    expect(bodyViolations(p)).toEqual([]);
    expect(p.appendages).toHaveLength(14);
    expect(visibleCount(p)).toBe(14);
    expect(shownIn(p, 'head')).toHaveLength(1);
    expect(shownIn(p, 'trunk')).toHaveLength(5);
    expect(shownIn(p, 'rear')).toHaveLength(1);
  });

  it('turns its rearmost leg pair to fringe when it also has a short antenna pair', () => {
    const whole = plan({ M1: ANTENNA, M2: LEGS, M3: LEGS2, M4: FURCA });
    const p = plan({ M1: ANTENNA, M2: LEGS, M3: LEGS2, M4: FURCA, M5: FEELER });
    expect(bodyViolations(p)).toEqual([]);
    expect(visibleCount(p)).toBe(14);
    expect(shownIn(p, 'head')).toHaveLength(2);
    const legs = shownIn(whole, 'trunk');
    // The rearmost leg of the whole copepod, by where its root lies along the spine.
    const along = (a: BodyPlan['appendages'][number]) =>
      spineShare(whole.segments, a.segment, a.angle);
    const rearmost = legs.reduce((a, b) => (along(b) > along(a) ? b : a));
    const fringe = left(p).filter((a) => a.fringe);
    expect(fringe).toHaveLength(1);
    expect(fringe[0]).toMatchObject({ module: rearmost.module, segment: rearmost.segment });
    // Fringe is short cilia: no longer than 0.3 body widths, with no branches or detail.
    const f = fringe[0] as BodyPlan['appendages'][number];
    expect(f.length).toBeLessThan(rearmost.length);
    expect(f.branches + f.setae + f.bulb + f.webbing).toBe(0);
  });

  it('turns everything past 14 instances to fringe on a duplicate-heavy body', () => {
    // Eight slots of three pairs each, spread from the head to the tail.
    const modules = Object.fromEntries(
      Array.from({ length: 8 }, (_, k) => [
        `M${k + 1}`,
        { ...LEGS, attachStart: k * 36, attachSpan: 40, angle: 20 + k * 30, length: 160 },
      ]),
    );
    const p = plan(modules, { segDrive1: 255, segDrive2: 255, fusion: 0, aspect: 128 });
    expect(bodyViolations(p)).toEqual([]);
    expect(visibleCount(p)).toBe(14);
    expect(p.appendages.length).toBeGreaterThan(14);
    expect(p.appendages.length).toBeLessThanOrEqual(RULES.develop.caps.appendages);
    expect(shownIn(p, 'head').length).toBeLessThanOrEqual(2);
    expect(shownIn(p, 'trunk').length).toBeLessThanOrEqual(6);
    expect(shownIn(p, 'rear').length).toBeLessThanOrEqual(1);
  });

  it('orders the budget: tail, long antennae, short antennae, then legs from the front', () => {
    const regions: Region[] = ['trunk', 'head', 'rear', 'trunk', 'head', 'rear', 'head'];
    const lengths = [1, 0.5, 0.4, 1, 2, 0.9, 0.3];
    const along = [0.5, 0.05, 0.9, 0.3, 0.02, 0.95, 0.1];
    // The longer head pair is the long antennae, the next the short, the third fringe; the longer
    // rear pair is the tail; legs keep front to back.
    expect(rolesOf(regions, lengths, along)).toEqual([
      'leg',
      'feeler',
      'fringe',
      'leg',
      'antenna',
      'tail',
      'fringe',
    ]);
    // Past seven pairs, the rearmost legs go first.
    const trunk = Array.from({ length: 6 }, (): Region => 'trunk');
    const roles = rolesOf(
      ['head', 'head', 'rear', ...trunk],
      [2, 1, 1, 1, 1, 1, 1, 1, 1],
      [0, 0, 1, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
    );
    expect(roles).toEqual([
      'antenna',
      'feeler',
      'tail',
      'leg',
      'leg',
      'leg',
      'leg',
      'fringe',
      'fringe',
    ]);
  });
});
