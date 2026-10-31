import { describe, expect, it } from 'vitest';
import {
  galleryGenome as gallery,
  insideShare,
  median,
  straightPlan,
  trunkLegs,
} from '../../tests/body-outline';
import { createRng, seedFromString } from '../sim/prng';
import { RULES } from '../sim/rules';
import { decodeGenome, type Genome } from './codec';
import {
  type BodyPlan,
  bladeAt,
  bladeWidth,
  bodyViolations,
  develop,
  type PlanSegment,
  paddleShare,
} from './develop';
import { express, type Traits } from './express';
import { GENOME_BYTES } from './karyotype';

// Thin, bristled legs that keep off the body (M6b T7): under rules 7 a v2 part's base width is at
// most half its root segment's girth half-width, so legs on a slim trunk are thin, and a part fitted
// into the bounds turns outward or shortens instead of lying over the trunk.

const rng = createRng(seedFromString('develop-legs'), 'bytes');
const randomV2 = (): Genome =>
  decodeGenome(Uint8Array.from({ length: GENOME_BYTES }, () => rng.nextU32() & 0xff));
const TRAITS = Array.from({ length: 10_000 }, () => express(randomV2()));
const PLANS = TRAITS.map(develop);
/** A coil: its chambers are as wide as its whorls leave room for, so its parts scale with its straight twin's segments. */
const isCoil = (plan: BodyPlan): boolean =>
  plan.form.radial === 0 && plan.form.mode === 2 && plan.segments.length === 8;
const LEGS = RULES.develop.legs;

describe('thin legs (M6b T7)', () => {
  it('caps every v2 gene part at half its root segment half-width, and the band keeps its own', () => {
    let coils = 0;
    PLANS.forEach((plan, i) => {
      const twin = isCoil(plan) ? straightPlan(TRAITS[i] as Traits) : undefined;
      if (twin) coils++;
      const widest = twin ? Math.max(...twin.segments.map((s) => s.ry)) : 0;
      for (const a of plan.appendages) {
        if (a.module < 0) {
          expect(a.width).toBe(RULES.develop.band.width);
          continue;
        }
        const ry = twin ? widest : (plan.segments[a.segment] as PlanSegment).ry;
        expect(a.width).toBeLessThanOrEqual(LEGS.width * ry + 1e-12);
        // A paddle widens toward its blade, at most to its root's whole half-width.
        expect(a.blade).toBeGreaterThanOrEqual(1);
        expect(a.width * a.blade).toBeLessThanOrEqual(LEGS.bladeMax * ry + 1e-12);
      }
    });
    expect(coils).toBeGreaterThan(300);
  });

  it('widens a thinned paddle toward its blade, and no other tip', () => {
    let paddles = 0;
    for (const plan of PLANS) {
      for (const a of plan.appendages) {
        if (paddleShare(a.tip) === 0) expect(a.blade).toBe(1);
        else if (a.blade > 1.2) paddles++;
      }
    }
    expect(paddles).toBeGreaterThan(5_000);
    const blade = { width: 0.1, blade: 2 };
    expect(bladeAt(blade, 0)).toBe(1);
    expect(bladeAt(blade, 1)).toBe(2);
    expect(bladeWidth(blade)).toBeGreaterThan(0.1);
  });

  it('keeps the median trunk leg of random bodies of 3+ segments at most 0.12 core radii', () => {
    const widths = PLANS.flatMap((p) => trunkLegs(p).map((a) => a.width));
    expect(widths.length).toBeGreaterThan(2_000);
    expect(median(widths)).toBeLessThanOrEqual(0.12);
  });

  it('gives the long gallery specimens thin trunk legs', () => {
    for (const n of ['26', '27', '30', '37', '38']) {
      const plan = develop(express(gallery(n)));
      expect(bodyViolations(plan), n).toEqual([]);
      const legs = trunkLegs(plan);
      expect(legs.length, n).toBeGreaterThan(0);
      expect(median(legs.map((a) => a.width)), n).toBeLessThanOrEqual(0.12);
    }
  });
});

describe('legs off the body (M6b T7)', () => {
  it('keeps 95% of parts with at most a quarter of their centre line inside the body', () => {
    let parts = 0;
    let over = 0;
    for (const plan of PLANS) {
      for (const a of plan.appendages) {
        parts++;
        if (insideShare(plan, a) > 0.25) over++;
      }
    }
    expect(parts).toBeGreaterThan(50_000);
    expect(over / parts, `${over} of ${parts}`).toBeLessThanOrEqual(0.05);
  });

  it('keeps the long gallery specimens legs off their bodies', () => {
    for (const n of ['26', '27', '28', '30', '37', '38', '40']) {
      const plan = develop(express(gallery(n)));
      const over = plan.appendages.filter((a) => insideShare(plan, a) > 0.25);
      expect(over.length, n).toBeLessThanOrEqual(Math.floor(0.05 * plan.appendages.length));
    }
  });
});
