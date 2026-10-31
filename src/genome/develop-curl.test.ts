import { describe, expect, it } from 'vitest';
import { buildBytes, type Params } from '../../tests/archetypes';
import {
  galleryGenome,
  isChain,
  links,
  sArcs,
  spine,
  spineTurn,
  straightPlan,
} from '../../tests/body-outline';
import { PI } from '../sim/math';
import { createRng, seedFromString } from '../sim/prng';
import { RULES } from '../sim/rules';
import { decodeGenome, type Genome } from './codec';
import { type BodyPlan, bodyViolations, develop, planBounds } from './develop';
import { express } from './express';
import { mutateGenome } from './inherit';
import { GENOME_BYTES } from './karyotype';
import { silhouetteOf } from './silhouette';
import { statsAt } from './stats';

// Spirals and S-worms (M6b T6, #177 option 2a): a curled karyotype v2 chain fits the bounds along
// its curve, not laid straight, so it may be longer than the straight reach while its curled pose
// stays inside 2.5 core radii. A coil turns at least 1.25 times, its links shrinking toward the
// inner end; an S bends two opposite arcs; and no segment overlaps one that is not its neighbour.

const C = RULES.develop.curve;
const COIL = 2.5 * PI;
const S_ARC = 0.6 * PI;

const rng = createRng(seedFromString('develop-curl'), 'bytes');
const randomV2 = (): Genome =>
  decodeGenome(Uint8Array.from({ length: GENOME_BYTES }, () => rng.nextU32() & 0xff));

/** 10,000 random v2 genomes and a mutated descendant of each. */
const BODIES: Genome[] = Array.from({ length: 10_000 }, (_, i) => {
  const g = randomV2();
  return [g, mutateGenome(g, seedFromString(`curl-${i}`), { mutation: 4 })];
}).flat();

const PLANS: { traits: ReturnType<typeof express>; plan: BodyPlan }[] = BODIES.map((g) => {
  const traits = express(g);
  return { traits, plan: develop(traits) };
});

const isCoil = (p: BodyPlan): boolean => isChain(p) && p.form.mode === 2;
const isS = (p: BodyPlan, traits: ReturnType<typeof express>): boolean =>
  p.form.radial === 0 && p.form.mode === 1 && traits.shape.curve >= 0.5 && p.segments.length >= 5;

const SWIM: Record<string, Params> = {
  M1: { length: 120, thickness: 60, tipShape: 255, beat: 220, angle: 200, pairs: 255 },
};
/** An eight-segment chain (both segment drives full) with `set` loci. */
const chain = (set: Record<string, number>): BodyPlan =>
  develop(express(decodeGenome(buildBytes(SWIM, { segDrive1: 255, segDrive2: 255, ...set }))));

describe('spirals and S-worms (M6b T6)', () => {
  it('coils every chain of 3+ segments past 0.8 at least 2.5π, links shrinking inward', () => {
    let coils = 0;
    for (const { plan } of PLANS) {
      if (!isCoil(plan)) continue;
      coils++;
      expect(spineTurn(plan)).toBeGreaterThanOrEqual(COIL - 1e-9);
      expect(plan.form.turn).toBeGreaterThanOrEqual(COIL - 1e-9);
      const l = links(plan);
      for (let i = 2; i < l.length; i++) expect(l[i]).toBeLessThan(l[i - 1] as number);
    }
    expect(coils).toBeGreaterThan(300);
    // The threshold itself: just past 0.8 a coil already turns 2.5π.
    for (const curve of [205, 230, 255]) {
      const p = chain({ curve });
      expect(p.form.mode, `${curve}`).toBe(2);
      expect(spineTurn(p), `${curve}`).toBeGreaterThanOrEqual(COIL - 1e-9);
      expect(bodyViolations(p), `${curve}`).toEqual([]);
    }
  });

  it('bends an S of 5+ segments past 0.5 into two opposite arcs of at least 0.6π', () => {
    let esses = 0;
    for (const { plan, traits } of PLANS) {
      if (!isS(plan, traits)) continue;
      esses++;
      const [rise, fall] = sArcs(plan);
      expect(rise).toBeGreaterThanOrEqual(S_ARC - 1e-9);
      expect(fall).toBeGreaterThanOrEqual(S_ARC - 1e-9);
    }
    expect(esses).toBeGreaterThan(300);
    for (const segDrive1 of [100, 180, 255]) {
      const p = chain({ segDrive1, curve: 128, curveMode: 255 });
      expect(p.segments.length).toBeGreaterThanOrEqual(5);
      const [rise, fall] = sArcs(p);
      expect(Math.min(rise, fall), `${segDrive1}`).toBeGreaterThanOrEqual(S_ARC - 1e-9);
      expect(bodyViolations(p)).toEqual([]);
    }
  });

  it('keeps segments that are not neighbours apart, over random and mutated genomes', () => {
    for (const { plan } of PLANS) expect(bodyViolations(plan)).toEqual([]);
    // The check itself: fold a curled chain's tail back onto its head.
    const p = chain({ curve: 60 });
    const folded = {
      ...p,
      segments: p.segments.map((s, i) => (i === 3 ? { ...s, x: 0, y: 0 } : s)),
    };
    expect(bodyViolations(folded)).toContain('segments 0 and 3 overlap');
  });

  it('lets a curled chain grow longer than its straight twin, inside the bounds', () => {
    const gains: number[] = [];
    let coils = 0;
    for (const { plan, traits } of PLANS) {
      if (!isChain(plan) || plan.form.turn === 0) continue;
      expect(planBounds(plan)).toBeLessThanOrEqual(RULES.develop.caps.bounds);
      const gain = spine(plan).length / spine(straightPlan(traits)).length;
      if (plan.form.mode === 2) {
        // A coil winds a longer chain into the bounds, up to `curve.coiled` times as long.
        coils++;
        expect(gain).toBeGreaterThanOrEqual(1.3);
        expect(gain).toBeLessThanOrEqual(C.coiled + 1e-9);
      } else if (plan.form.turn >= 0.5 * PI) gains.push(gain);
    }
    expect(coils).toBeGreaterThan(300);
    // A C or S bent by half a turn or more gains length too, less as its arc still reaches out.
    gains.sort((a, b) => a - b);
    expect(gains.length).toBeGreaterThan(1_000);
    expect(gains[gains.length >> 1]).toBeGreaterThanOrEqual(1.05);
  });

  it('weighs the longer chain by its girth', () => {
    /** The body's area as the water meets it: each segment's length by its girth (ADR 0031). */
    const bulk = (p: BodyPlan): number =>
      p.segments.reduce((sum, s) => sum + PI * s.rx * (s.ry / p.form.slim), 0);
    const girth = (p: BodyPlan): number[] => p.segments.map((s) => s.ry / p.form.slim);
    let same = 0;
    let longer = 0;
    let coils = 0;
    let heavier = 0;
    for (const { plan, traits } of PLANS) {
      if (!isChain(plan) || plan.form.turn === 0) continue;
      const twin = straightPlan(traits);
      const size = traits.body.maxBiomass;
      if (plan.form.mode === 2) {
        coils++;
        if (statsAt(plan, traits, size).mass > statsAt(twin, traits, size).mass) heavier++;
        continue;
      }
      // A C or an S keeps its twin's girth (a worm is evener than its straight twin, M6b T5) and
      // only grows longer, so it weighs at least as much.
      const [g, t] = [girth(plan), girth(twin)];
      if (g.length !== t.length || g.some((x, i) => Math.abs(x - (t[i] as number)) > 1e-9))
        continue;
      same++;
      expect(bulk(plan)).toBeGreaterThanOrEqual(bulk(twin) - 1e-9);
      if (bulk(plan) > bulk(twin) * 1.01) longer++;
    }
    expect(same).toBeGreaterThan(1_000);
    expect(longer / same).toBeGreaterThan(0.5);
    // A coil's chambers are its own, but most of them outweigh the straight twin.
    expect(coils).toBeGreaterThan(300);
    expect(heavier / coils).toBeGreaterThan(0.7);
  });

  it('turns the gallery coil (29) and spiral (39) at least 2.5π, and bends the worms', () => {
    for (const n of ['29', '39']) {
      const plan = develop(express(galleryGenome(n)));
      expect(silhouetteOf(plan), n).toBe('coil');
      expect(spineTurn(plan), n).toBeGreaterThanOrEqual(COIL - 1e-9);
      expect(bodyViolations(plan), n).toEqual([]);
    }
    // 28's genes curl it into a C (its curve mode is below 0.5); the S-worm specimen is 40.
    const worm = develop(express(galleryGenome('28')));
    expect(silhouetteOf(worm)).toBe('worm');
    expect(worm.form.mode).toBe(0);
    const s = develop(express(galleryGenome('40')));
    expect(silhouetteOf(s)).toBe('worm');
    expect(s.form.mode).toBe(1);
    expect(Math.min(...sArcs(s))).toBeGreaterThanOrEqual(S_ARC - 1e-9);
    expect(bodyViolations(s)).toEqual([]);
  });
});
