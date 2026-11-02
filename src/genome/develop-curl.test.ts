import { describe, expect, it } from 'vitest';
import { buildBytes, locus, type Params, withLoci } from '../../tests/archetypes';
import {
  galleryGenome,
  isChain,
  links,
  sArcs,
  spine,
  spineTurn,
  straightPlan,
} from '../../tests/body-outline';

import { heavyTest } from '../../tests/heavy';
import { cos, PI, sin } from '../sim/math';

import { createRng, seedFromString } from '../sim/prng';
import { RULES } from '../sim/rules';
import { decodeGenome, type Genome } from './codec';
import {
  type Appendage,
  type BodyPlan,
  bodyViolations,
  develop,
  planBounds,
  rootOf,
} from './develop';
import { capAndBend } from './develop-parts';
import { express } from './express';
import { mutateGenome } from './inherit';
import { GENOME_BYTES, HAPLOTYPE_BYTES } from './karyotype';
import { LEG_DIR, measure, regionOf, SPOKE_PAIRS, VISIBLE_PAIRS, visibleCount } from './organism';
import { silhouetteOf } from './silhouette';
import { statsAt } from './stats';

// Spirals and S-worms (M6b T6, #177 option 2a): a curled karyotype v2 chain fits the bounds along
// its curve, not laid straight, so it may be longer than the straight reach while its curled pose
// stays inside 2.5 core radii. A coil turns at least 1.25 times, its links shrinking toward the
// inner end; an S bends two opposite arcs; and no segment overlaps one that is not its neighbour.
// This file holds the shared plan cache (10,000 random genomes and a mutated descendant of each),
// so the region rules of M6c T3 (ADR 0041) are checked here too, without a second 10,000 loop.

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

/**
 * 2,000 coil candidates: random genomes curved past 0.8, about 5 to 8 segments by their genes, bilateral,
 * with only the first one or two module slots present. The coil's gate (ADR 0041) leaves random
 * genomes almost no coils (they carry too many legs), so the spiral's properties are checked here.
 */
const SLOTS = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8'];
const COIL_PLANS: typeof PLANS = Array.from({ length: 2_000 }, () => {
  const bytes = withLoci(
    Uint8Array.from({ length: GENOME_BYTES }, () => rng.nextU32() & 0xff),
    {
      curve: 205 + (rng.nextU32() % 51),
      segDrive1: 128 + (rng.nextU32() % 128),
      segDrive2: 128 + (rng.nextU32() % 128),
      symmetry: rng.nextU32() % 128,
    },
  );
  const keep = 1 + (rng.nextU32() % 2);
  SLOTS.slice(keep).forEach((id) => {
    bytes[locus(id).offset] = 0;
    bytes[HAPLOTYPE_BYTES + locus(id).offset] = 0;
  });
  const traits = express(decodeGenome(bytes));
  return { traits, plan: develop(traits) };
});
const ALL = [...PLANS, ...COIL_PLANS];

const isCoil = (p: BodyPlan): boolean => isChain(p) && p.form.mode === 2;
const isS = (p: BodyPlan, traits: ReturnType<typeof express>): boolean =>
  p.form.radial === 0 && p.form.mode === 1 && traits.shape.curve >= 0.5 && p.segments.length >= 5;

const SWIM: Record<string, Params> = {
  M1: { length: 120, thickness: 60, tipShape: 255, beat: 220, angle: 200, pairs: 255 },
};
/** An eight-segment chain (both segment drives full) with `set` loci. */
const chain = (set: Record<string, number>, modules = SWIM): BodyPlan =>
  develop(express(decodeGenome(buildBytes(modules, { segDrive1: 255, segDrive2: 255, ...set }))));
/** The swimmer with two pairs, which the coil's gate lets coil (ADR 0041). */
const SWIM2: Record<string, Params> = { M1: { ...SWIM.M1, pairs: 100 } };

describe('spirals and S-worms (M6b T6)', () => {
  it('coils every gated chain past 0.8 at least 2.5π, links shrinking inward', () => {
    let coils = 0;
    for (const { plan } of ALL) {
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
      const p = chain({ curve }, SWIM2);
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

  heavyTest('keeps segments that are not neighbours apart, over random and mutated genomes', () => {
    for (const { plan } of ALL) expect(bodyViolations(plan)).toEqual([]);
    // The check itself: fold a curled chain's tail back onto its head.
    const p = chain({ curve: 60 });
    const folded = {
      ...p,
      segments: p.segments.map((s, i) => (i === 3 ? { ...s, x: 0, y: 0 } : s)),
    };
    expect(bodyViolations(folded)).toContain('segments 0 and 3 overlap');
  });

  heavyTest('lets a curled chain grow longer than its straight twin, inside the bounds', () => {
    const gains: number[] = [];
    let coils = 0;
    for (const { plan, traits } of ALL) {
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

  heavyTest('weighs the longer chain by its girth', () => {
    /** The body's area as the water meets it: each segment's length by its girth (ADR 0031). */
    const bulk = (p: BodyPlan): number =>
      p.segments.reduce((sum, s) => sum + PI * s.rx * (s.ry / p.form.slim), 0);
    const girth = (p: BodyPlan): number[] => p.segments.map((s) => s.ry / p.form.slim);
    let same = 0;
    let longer = 0;
    let coils = 0;
    const ratios: number[] = [];
    for (const { plan, traits } of ALL) {
      if (!isChain(plan) || plan.form.turn === 0) continue;
      const twin = straightPlan(traits);
      const size = traits.body.maxBiomass;
      if (plan.form.mode === 2) {
        coils++;
        ratios.push(statsAt(plan, traits, size).mass / statsAt(twin, traits, size).mass);
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
    // A coil's chambers are its own. Under the coil's gate (ADR 0041) a coil comes from five or
    // more segment genes, whose straight twin is already long and slim, so it weighs about what its
    // twin does (before the gate, most coils came from shorter chains and outweighed theirs).
    expect(coils).toBeGreaterThan(300);
    ratios.sort((a, b) => a - b);
    const median = ratios[ratios.length >> 1] as number;
    expect(median).toBeGreaterThan(0.8);
    expect(median).toBeLessThan(1.2);
    expect(ratios[0]).toBeGreaterThan(0.5);
    expect(ratios[ratios.length - 1]).toBeLessThan(2);
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

/** The left instances of a bilateral plan that show (not fringe), with their region. */
const shown = (plan: BodyPlan) =>
  plan.appendages
    .filter((a) => a.side === 1 && !a.fringe)
    .map((a) => ({ a, region: regionOf(a, plan) }));

/**
 * A list of what broke, so the loops over the plan cache call `expect` once, not per part (an
 * `expect` per part made these tests the slowest in the cache).
 */
function breaks() {
  const bad: string[] = [];
  return {
    check: (ok: boolean, what: () => string): void => {
      if (!ok && bad.length < 5) bad.push(what());
    },
    bad,
  };
}

describe('parts by region and a visible-part budget (M6c T3, ADR 0041)', () => {
  it('shows at most 14 instances: 2 head pairs, 6 trunk pairs and 1 rear structure', () => {
    expect(VISIBLE_PAIRS).toBe(7);
    const { check, bad } = breaks();
    let fringed = 0;
    ALL.forEach(({ plan }, i) => {
      check(visibleCount(plan) <= 2 * VISIBLE_PAIRS, () => `${i}: ${visibleCount(plan)} shown`);
      if (plan.appendages.some((a) => a.fringe && a.module >= 0)) fringed++;
      if (plan.form.radial === 1) return;
      const parts = shown(plan);
      const count = (r: string) => parts.filter((p) => p.region === r).length;
      check(count('head') <= 2, () => `${i}: ${count('head')} head pairs`);
      check(count('trunk') <= 6, () => `${i}: ${count('trunk')} trunk pairs`);
      check(count('rear') <= 1, () => `${i}: ${count('rear')} rear structures`);
    });
    expect(bad).toEqual([]);
    // Random bytes carry many parts, so the budget turns many to fringe.
    expect(fringed).toBeGreaterThan(5_000);
  });

  it("keeps each part to its region: lengths, the legs' sweep, and fringe as short cilia", () => {
    const { check, bad } = breaks();
    const [lo, hi] = LEG_DIR as [number, number];
    let legs = 0;
    ALL.forEach(({ plan }, i) => {
      const { length, width } = measure(plan.segments);
      for (const a of plan.appendages) {
        if (!a.fringe || a.module < 0) continue;
        check(a.length <= 0.3 * width + 1e-9, () => `${i}: fringe ${a.length} long`);
        check(
          a.branches + a.setae + a.bulb + a.webbing + a.chela === 0,
          () => `${i}: dressed fringe`,
        );
      }
      if (plan.form.radial === 1) return;
      const parts = shown(plan);
      const head = parts.filter((p) => p.region === 'head').map((p) => p.a.length);
      head.sort((x, y) => y - x);
      const [antenna = 0, feeler = 0] = head;
      check(antenna <= 2.2 * length + 1e-9, () => `${i}: antenna ${antenna} of ${length}`);
      check(feeler <= 0.6 * length + 1e-9, () => `${i}: short antenna ${feeler} of ${length}`);
      for (const { a, region } of parts) {
        if (region === 'rear')
          check(a.length <= 1.5 * length + 1e-9, () => `${i}: tail ${a.length}`);
        if (region !== 'trunk') continue;
        legs++;
        check(a.length <= 0.9 * width + 1e-9, () => `${i}: leg ${a.length} of width ${width}`);
        // Swept back 25-70° from the side.
        check(a.dir >= lo - 1e-9 && a.dir <= hi + 1e-9, () => `${i}: leg growing at ${a.dir}`);
      }
    });
    expect(bad).toEqual([]);
    expect(legs).toBeGreaterThan(20_000);
    expect(lo).toBeCloseTo(PI / 2 + (25 * PI) / 180, 12);
    expect(hi).toBeCloseTo(PI / 2 + (70 * PI) / 180, 12);
  });

  it('roots the legs on a carapace under its shell', () => {
    const { check, bad } = breaks();
    let legs = 0;
    PLANS.forEach(({ plan }, i) => {
      const c = plan.carapace;
      if (plan.form.radial === 1 || c.count === 0) return;
      for (const a of plan.appendages) {
        if (a.fringe || a.segment >= c.count || regionOf(a, plan) !== 'trunk') continue;
        const s = plan.segments[a.segment] as BodyPlan['segments'][number];
        const root = rootOf(s, a.angle, a.side);
        const [dx, dy] = [root.x - c.x, root.y - c.y];
        const u = (dx * cos(c.angle) + dy * sin(c.angle)) / c.rx;
        const v = (dy * cos(c.angle) - dx * sin(c.angle)) / c.ry;
        check(u * u + v * v < 1, () => `${i}: leg root outside the shell (${u * u + v * v})`);
        legs++;
      }
    });
    expect(bad).toEqual([]);
    expect(legs).toBeGreaterThan(5_000);
  });

  it('rings a radial body with 5-9 spokes of lengths varied by a hash', () => {
    expect(SPOKE_PAIRS).toEqual([3, 4]);
    const { check, bad } = breaks();
    let radial = 0;
    let varied = 0;
    PLANS.forEach(({ plan }, i) => {
      if (plan.form.radial !== 1 || !plan.appendages.some((a) => a.module >= 0)) return;
      radial++;
      const n = visibleCount(plan);
      check(n >= 5 && n <= 9, () => `${i}: ${n} spokes`);
      const lengths = plan.appendages.filter((a) => !a.fringe).map((a) => a.length);
      if (Math.max(...lengths) > 1.1 * Math.min(...lengths)) varied++;
    });
    expect(bad).toEqual([]);
    expect(radial).toBeGreaterThan(5_000);
    expect(varied / radial).toBeGreaterThan(0.5);
  });

  it('coils only on genes that pass the gate, with its legs outside the curve', () => {
    let coils = 0;
    let curled = 0;
    for (const { plan, traits } of ALL) {
      if (plan.form.radial === 1) continue;
      if (plan.form.mode !== 2) {
        if (traits.shape.curve > RULES.develop.curve.coilStart && plan.segments.length > 1)
          curled++;
        continue;
      }
      coils++;
      expect(traits.body.segments).toBeGreaterThanOrEqual(5);
      const legs = plan.appendages.filter((a) => !a.fringe && regionOf(a, plan) === 'trunk');
      expect(legs.filter((a) => a.side === 1).length).toBeLessThanOrEqual(2);
      // The curl turns left, so the outer side of the curve is the left: no leg shows on the right.
      expect(plan.form.turn).toBeGreaterThan(0);
      for (const a of legs) expect(a.side).toBe(1);
    }
    expect(coils).toBeGreaterThan(300);
    expect(curled).toBeGreaterThan(300);
    // The gate itself: two leg pairs coil, three take the C-curl, and so does a 4-segment trait.
    expect(chain({ curve: 255 }, SWIM2).form.mode).toBe(2);
    const legs3 = { M1: { ...SWIM2.M1, pairs: 255, angle: 128, attachStart: 30, attachSpan: 150 } };
    expect(chain({ curve: 255 }, legs3).form).toMatchObject({ mode: 0, turn: PI });
    const short = chain({ curve: 255, segDrive1: 100, segDrive2: 100 }, SWIM2);
    expect(short.segments.length).toBeLessThan(5);
    expect(short.form).toMatchObject({ mode: 0, turn: PI });
  });
});

/** The instances of a plan in mirrored pairs: left then right. */
const pairsOf = (plan: BodyPlan): [Appendage, Appendage][] => {
  const out: [Appendage, Appendage][] = [];
  for (let i = 0; i + 1 < plan.appendages.length; i += 2)
    out.push([plan.appendages[i] as Appendage, plan.appendages[i + 1] as Appendage]);
  return out;
};
const deg = (d: number): number => (d * PI) / 180;

describe('parts that curve, taper and vary (M6c T4, ADR 0041)', () => {
  it('tapers every part to at most 40% of its root and bends it backward', () => {
    const { check, bad } = breaks();
    let bent = 0;
    ALL.forEach(({ plan }, i) => {
      for (const a of plan.appendages) {
        check(1 - a.taper <= 0.4 + 1e-9, () => `${i}: tip ${1 - a.taper} of the root`);
        check(a.curvature >= 0.15 - 1e-9, () => `${i}: curvature ${a.curvature}`);
        if (a.fringe) continue;
        // Drawn, the bend turns toward the tail on the left (anticlockwise) and mirrors on the right:
        // legs and tails curve back, antennae outward and back.
        const { bend } = capAndBend(a);
        check(bend >= 0, () => `${i}: a ${regionOf(a, plan)} part bends forward (${bend})`);
        if (bend > 0) bent++;
      }
    });
    expect(bad).toEqual([]);
    expect(bent).toBeGreaterThan(50_000);
  });

  it('branches only antennae and tails, once, at most half as long, fanned back at most 35°', () => {
    const D = RULES.develop;
    expect(D.branchScale).toBeLessThanOrEqual(0.5);
    expect(D.branchFan).toBeGreaterThan(0);
    expect(D.branchFan).toBeLessThanOrEqual(deg(35));
    const { check, bad } = breaks();
    let branched = 0;
    ALL.forEach(({ plan }, i) => {
      for (const a of plan.appendages) {
        if (a.branches === 0) continue;
        branched++;
        const region = plan.form.radial === 1 ? 'spoke' : regionOf(a, plan);
        check(
          !a.fringe && (region === 'head' || region === 'rear'),
          () => `${i}: ${region} branch`,
        );
        // One branch, the backward one (it fans toward the tail on its side).
        check(a.branches === 1, () => `${i}: ${a.branches} branches`);
      }
    });
    expect(bad).toEqual([]);
    expect(branched).toBeGreaterThan(2_000);
  });

  it('tips a bulb only on one pair whose gene passes 0.6', () => {
    const { check, bad } = breaks();
    let bulbs = 0;
    ALL.forEach(({ plan, traits }, i) => {
      const tipped = plan.appendages.filter((a) => a.bulb > 0);
      check(tipped.length <= 2, () => `${i}: ${tipped.length} bulbs`);
      if (tipped.length === 0) return;
      bulbs++;
      // One pair: a coil's inner leg is fringe, so its outer instance may carry the bulb alone.
      const l = tipped[0] as Appendage;
      check(
        tipped.every(
          (a) => a.module === l.module && a.segment === l.segment && a.angle === l.angle,
        ),
        () => `${i}: bulbs on more than one pair`,
      );
      const gene = (traits.modules[l.module] as (typeof traits.modules)[number]).ext.bulb;
      check(gene > 0.6, () => `${i}: bulb gene ${gene}`);
    });
    expect(bad).toEqual([]);
    expect(bulbs).toBeGreaterThan(1_000);
  });

  it('keeps setae to legs, antennae and tails: at most 3× the part wide, 12 a part', () => {
    const { check, bad } = breaks();
    let bristled = 0;
    ALL.forEach(({ plan }, i) => {
      for (const a of plan.appendages) {
        if (a.setae === 0) continue;
        bristled++;
        check(plan.form.radial === 0 && !a.fringe, () => `${i}: setae on a spoke or fringe`);
        check(a.setae <= 12, () => `${i}: ${a.setae} setae`);
        check(
          a.setaeLength <= 3 * a.girth + 1e-9,
          () => `${i}: setae ${a.setaeLength} on ${a.girth}`,
        );
      }
    });
    expect(bad).toEqual([]);
    expect(bristled).toBeGreaterThan(20_000);
  });

  it('jitters each mirrored pair by a hash: angle ±6°, length ±5%, the beat a little apart', () => {
    const J = RULES.develop.organism.jitter;
    expect(J).toMatchObject({ angle: 6, length: 0.05 });
    const { check, bad } = breaks();
    let pairs = 0;
    let turned = 0;
    let longer = 0;
    ALL.forEach(({ plan }, i) => {
      for (const [l, r] of pairsOf(plan)) {
        if (l.fringe || r.fringe) continue;
        pairs++;
        const dDir = r.dir - l.dir;
        const dLength = r.length / l.length - 1;
        check(Math.abs(dDir) <= deg(6) + 1e-9, () => `${i}: pair ${dDir} apart`);
        check(Math.abs(dLength) <= 0.05 + 1e-9, () => `${i}: pair ${dLength} longer`);
        const offset = (((r.phase - l.phase) % 1) + 1) % 1;
        check(
          offset >= (J.phase[0] as number) - 1e-9 && offset <= (J.phase[1] as number) + 1e-9,
          () => `${i}: beat ${offset} apart`,
        );
        if (Math.abs(dDir) > deg(1)) turned++;
        if (Math.abs(dLength) > 0.01) longer++;
      }
    });
    expect(bad).toEqual([]);
    // The bounds and the region limits may hold a jitter back, but most pairs vary.
    expect(turned / pairs).toBeGreaterThan(0.6);
    expect(longer / pairs).toBeGreaterThan(0.6);
  });
});
