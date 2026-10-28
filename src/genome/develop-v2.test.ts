import { describe, expect, it } from 'vitest';
import { buildBytes, type Params } from '../../tests/archetypes';
import { cos, PI, sin } from '../sim/math';
import { RULES } from '../sim/rules';
import { decodeGenome } from './codec';
import { type BodyPlan, bodyViolations, develop, type PlanSegment, ringAngle } from './develop';
import { express } from './express';

// Development v2 (M6 T7, ADR 0025): the shape loci bend, profile and fuse the chain, ring a radial
// body's parts and add eyes. Each test sets one locus on an otherwise plain body.

const D = RULES.develop;

const plan = (modules: Record<string, Params>, set: Record<string, number>): BodyPlan =>
  develop(express(decodeGenome(buildBytes(modules, set))));

const SWIM: Record<string, Params> = {
  M1: { length: 150, thickness: 60, tipShape: 255, beat: 220, angle: 200, pairs: 255 },
};
/** Eight even segments (no taper), round enough that rx ≈ ry. */
const EIGHT = { segDrive1: 255, segDrive2: 255, aspect: 128 };
const body = (set: Record<string, number>) => plan(SWIM, { ...EIGHT, ...set });

/** The ellipse's own coordinates of body point `p`, scaled to the unit circle. */
const inside = (
  e: { x: number; y: number; rx: number; ry: number; angle: number },
  p: number[],
) => {
  const [dx, dy] = [(p[0] as number) - e.x, (p[1] as number) - e.y];
  const [c, s] = [cos(e.angle), sin(e.angle)];
  return Math.hypot((dx * c + dy * s) / e.rx, (dy * c - dx * s) / e.ry);
};

const outline = (s: PlanSegment): number[][] =>
  Array.from({ length: D.fusion.samples }, (_, j) => {
    const a = (2 * PI * j) / D.fusion.samples;
    const [lx, ly] = [s.rx * cos(a), s.ry * sin(a)];
    const [c, n] = [cos(s.angle), sin(s.angle)];
    return [s.x + lx * c - ly * n, s.y + lx * n + ly * c];
  });

const valid = (p: BodyPlan): void => {
  expect(bodyViolations(p)).toEqual([]);
};

describe('development v2: spine curve', () => {
  it('bends one C arc with a total turn of curve × π', () => {
    const straight = body({});
    const curved = body({ curve: 128 });
    valid(curved);
    const angles = curved.segments.map((s) => s.angle);
    expect(angles[0]).toBe(0);
    expect(angles[7]).toBeCloseTo((128 / 255) * PI, 9);
    for (let i = 1; i < 8; i++) expect(angles[i]).toBeGreaterThan(angles[i - 1] as number);
    expect(curved.form).toEqual({ turn: (128 / 255) * PI, mode: 0, radial: 0 });
    // Every link keeps its straight length, so the curl only folds the body.
    for (let i = 1; i < 8; i++) {
      const [a, b] = [curved.segments[i - 1], curved.segments[i]] as [PlanSegment, PlanSegment];
      const [s, t] = [straight.segments[i - 1], straight.segments[i]] as [PlanSegment, PlanSegment];
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeLessThanOrEqual(s.x - t.x + 1e-12);
    }
    const tail = curved.segments[7] as PlanSegment;
    expect(Math.hypot(tail.x, tail.y)).toBeLessThan(
      Math.abs((straight.segments[7] as PlanSegment).x),
    );
    expect(Math.abs(tail.y)).toBeGreaterThan(0.3);
  });

  it('splits the turn into two opposite arcs in S mode', () => {
    const s = body({ curve: 200, curveMode: 255 });
    valid(s);
    const angles = s.segments.map((x) => x.angle);
    const turn = (200 / 255) * PI;
    expect(s.form.mode).toBe(1);
    expect(Math.max(...angles)).toBeLessThanOrEqual(turn / 2 + 1e-12);
    expect(Math.max(...angles)).toBeGreaterThan(turn / 3);
    expect(angles[7]).toBeCloseTo(0, 9);
    // The heading rises, then falls: one change of direction.
    const steps = angles
      .slice(1)
      .map((a, i) => Math.sign(a - (angles[i] as number)))
      .filter((x) => x !== 0);
    expect(steps.filter((x, i) => i > 0 && x !== steps[i - 1])).toHaveLength(1);
  });

  it('coils above 0.8: more than a full turn, tightening toward the tail', () => {
    const c = body({ curve: 255, tailTaper: 255 });
    valid(c);
    expect(c.form.mode).toBe(2);
    expect(c.form.turn).toBeCloseTo(D.curve.coilTurn * PI, 9);
    const angles = c.segments.map((s) => s.angle);
    expect(angles[7]).toBeCloseTo(D.curve.coilTurn * PI, 9);
    const turns = angles.slice(1).map((a, i) => a - (angles[i] as number));
    for (let i = 1; i < turns.length; i++) {
      expect(turns[i]).toBeGreaterThan(turns[i - 1] as number);
    }
    const links = c.segments
      .slice(1)
      .map((s, i) =>
        Math.hypot(s.x - (c.segments[i] as PlanSegment).x, s.y - (c.segments[i] as PlanSegment).y),
      );
    for (let i = 1; i < links.length; i++) {
      expect(links[i]).toBeLessThan(links[i - 1] as number);
    }
    // Just below the threshold the C arc still has its plain turn.
    expect(body({ curve: 204 }).form).toEqual({ turn: (204 / 255) * PI, mode: 0, radial: 0 });
  });

  it('keeps neighbours overlapping and puts the colliders on the curve', () => {
    for (const set of [{ curve: 128 }, { curve: 230, curveMode: 255 }, { curve: 255 }]) {
      const p = body(set);
      valid(p); // bodyViolations checks that every neighbour pair overlaps along its link
      for (let i = 1; i < p.segments.length; i++) {
        const s = p.segments[i] as PlanSegment;
        expect(p.colliders[i]).toEqual({ x: s.x, y: s.y, r: expect.any(Number) });
      }
    }
  });

  it('leaves a single cell straight', () => {
    const p = plan(SWIM, { curve: 255 });
    expect(p.segments).toEqual([expect.objectContaining({ x: 0, y: 0, angle: 0 })]);
    expect(p.form.turn).toBe(0);
  });
});

describe('development v2: tagmata', () => {
  const T = D.tagmata;
  const radii = (set: Record<string, number>): number[] => body(set).segments.map((s) => s.ry);
  const plain = radii({});

  it('keeps an even chain without them', () => {
    for (const r of plain.slice(2)) expect(r).toBeCloseTo(plain[1] as number, 12);
  });

  it('pins the head-scale extreme: the v1 head, and the chain narrows by 1 ÷ (1 + head)', () => {
    // Without head scale the head in front of a chain is `chain.head` of the v1 head (ADR 0028).
    expect(plain[0]).toBeCloseTo(D.chain.head, 12);
    const r = radii({ headScale: 255 });
    expect(r[0]).toBe(1);
    for (const x of r.slice(2)) expect(x).toBeCloseTo(r[1] as number, 12);
    // The head is the unit: the narrowing comes after the chain is fitted to its reach, so the
    // trunk ends up far narrower next to the head than without head scale.
    expect((r[1] as number) / (r[0] as number)).toBeLessThan(
      ((plain[1] as number) / (plain[0] as number)) * (1 / (1 + T.head)),
    );
    expect(r).toEqual([1, ...Array(7).fill(0.200092)].map((x) => expect.closeTo(x, 5)));
  });

  it('pins the trunk-swell extreme: the middle widens most', () => {
    const r = radii({ trunkSwell: 255 });
    const rear = r.slice(1);
    const widest = rear.indexOf(Math.max(...rear)) + 1;
    expect(widest / 7).toBeCloseTo(T.trunkAt, 0);
    expect((r[3] as number) / (r[7] as number)).toBeCloseTo(
      (1 + T.trunk * (1 - Math.abs(3 / 7 - T.trunkAt) / T.trunkSpread)) /
        (1 + T.trunk * (1 - Math.abs(1 - T.trunkAt) / T.trunkSpread)),
      9,
    );
    expect(r).toEqual(
      [0.65, 0.470172, 0.52019, 0.550201, 0.500183, 0.450164, 0.400146, 0.350128].map((x) =>
        expect.closeTo(x, 5),
      ),
    );
  });

  it('pins the tail extremes: tail length stretches the rear, tail taper narrows it', () => {
    const long = body({ tailLength: 255 }).segments;
    const aspect = (s: PlanSegment) => s.rx / s.ry;
    expect(aspect(long[7] as PlanSegment) / aspect(long[1] as PlanSegment)).toBeCloseTo(
      1 + T.tailLength,
      9,
    );
    expect(aspect(long[3] as PlanSegment)).toBeCloseTo(aspect(long[1] as PlanSegment), 12);
    const r = radii({ tailTaper: 255 });
    expect((r[7] as number) / (r[1] as number)).toBeCloseTo(1 - T.tailTaper, 9);
    expect((r[3] as number) / (r[1] as number)).toBeCloseTo(1, 12);
    expect(r).toEqual(
      [0.65, 0.646116, 0.646116, 0.646116, 0.581504, 0.452281, 0.323058, 0.193835].map((x) =>
        expect.closeTo(x, 5),
      ),
    );
  });
});

describe('development v2: fusion', () => {
  it('fuses the front round(fusion × segments) segments under one shell', () => {
    const half = body({ fusion: 128 });
    expect(half.carapace.count).toBe(Math.round((128 / 255) * 8));
    expect(half.segments).toHaveLength(8);
    expect(body({}).carapace.count).toBe(0);
    expect(body({ fusion: 255 }).carapace.count).toBe(8);
    expect(plan(SWIM, { fusion: 200 }).carapace.count).toBe(1);
  });

  it('holds every fused segment inside the hull, straight or curved', () => {
    for (const set of [{ fusion: 128 }, { fusion: 255 }, { fusion: 160, curve: 150 }]) {
      const p = body(set);
      valid(p);
      const c = p.carapace;
      for (const s of p.segments.slice(0, c.count)) {
        for (const q of outline(s)) expect(inside(c, q)).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });

  it('moves the fused colliders onto the shell and the plates off it', () => {
    const p = body({ fusion: 160, curve: 150, plating1: 255, plating2: 255 });
    const c = p.carapace;
    expect(c.count).toBe(5);
    for (let i = 1; i < c.count; i++) {
      // On the shell's axis, as wide as the shell there.
      const k = p.colliders[i] as { x: number; y: number; r: number };
      const [ca, sa] = [cos(c.angle), sin(c.angle)];
      const [u, v] = [(k.x - c.x) * ca + (k.y - c.y) * sa, (k.y - c.y) * ca - (k.x - c.x) * sa];
      expect(v).toBeCloseTo(0, 12);
      expect(k.r).toBeCloseTo(c.ry * Math.sqrt(1 - (u / c.rx) ** 2), 9);
      expect(k.r).toBeGreaterThan((p.segments[i] as PlanSegment).ry);
    }
    expect(p.plates.map((x) => x.segment)).toEqual([5, 6, 7]);
    expect(c.thickness).toBeCloseTo(D.plateThickness[1] as number, 9);
    expect(body({ fusion: 160 }).carapace.thickness).toBeCloseTo(D.fusion.thickness, 9);
    // Fused segments do not bend.
    const flexible = body({ flexibility: 255 });
    const stiff = body({ flexibility: 255, fusion: 255 });
    expect(stiff.flexibility).toBeCloseTo(flexible.flexibility * (1 - D.fusion.stiffen), 9);
  });
});

describe('development v2: symmetry', () => {
  const MANY: Record<string, Params> = {
    M1: { length: 150, thickness: 60, tipShape: 255, beat: 220, angle: 40, pairs: 255 },
    M2: { length: 100, thickness: 40, tipShape: 96, stiffness: 200, angle: 250, pairs: 128 },
  };

  it('rings the parts round the core at even angles at symmetry ≥ 0.5', () => {
    const p = plan(MANY, { symmetry: 255, aspect: 255 });
    valid(p);
    expect(p.form.radial).toBe(1);
    const left = p.appendages.filter((a) => a.side === 1);
    expect(left).toHaveLength(5);
    left.forEach((a, k) => {
      expect(a.segment).toBe(0);
      expect(a.angle).toBeCloseTo(((2 * k + 1) * PI) / 10, 12);
      expect(a.dir).toBeCloseTo(a.angle, 12); // straight out without drape
    });
    expect(ringAngle(0, 5)).toBeCloseTo(PI / 10, 12);
    // Round: the core's aspect goes to 1.
    expect(p.segments[0]?.rx).toBeCloseTo(1, 9);
    const bilateral = plan(MANY, { symmetry: 127, aspect: 255 });
    expect(bilateral.form.radial).toBe(0);
    expect(bilateral.segments[0]?.rx).toBeGreaterThan(1.05);
  });

  it('trails the ring rearward with drape, like tentacles, and keeps it a ring', () => {
    const p = plan(MANY, { symmetry: 255, drape: 255 });
    valid(p);
    const left = p.appendages.filter((a) => a.side === 1);
    for (const a of left) {
      // A ring drapes `ringDrape` as far as a bilateral body: the front parts turn sideways and
      // the rear ones back, so the tips stay spread round the body (M6 T14b).
      const draped = a.angle + D.radial.drapeSweep * D.radial.ringDrape * (PI - a.angle);
      expect(a.dir).toBeGreaterThanOrEqual(draped - 1e-12);
      expect(a.dir).toBeLessThanOrEqual(PI);
      expect(a.dir).toBeGreaterThan(a.angle);
    }
    expect(left[0]?.dir).toBeLessThan(PI / 2 + 0.3);
    expect(left[left.length - 1]?.dir).toBeGreaterThan(PI * 0.9);
  });

  it('puts a radial body’s mouth at the centre', () => {
    const jaw = { mouthType: 255, mouthSize: 255 };
    expect(plan(MANY, jaw).mouth.offset).toBeGreaterThan(0.5);
    expect(plan(MANY, { ...jaw, symmetry: 255 }).mouth.offset).toBe(0);
  });

  it('keeps a radial body swimming: the ciliary band joins the ring', () => {
    const still: Record<string, Params> = { M1: { length: 200, thickness: 200, angle: 0 } };
    const p = plan(still, { symmetry: 255 });
    valid(p);
    expect(p.appendages.some((a) => a.module === -1)).toBe(true);
  });
});

describe('development v2: eyes', () => {
  it('gives a pair on the head above size 0.15, with the stalk', () => {
    expect(body({ eyeSize: 30 }).eyes.count).toBe(0);
    const p = body({ eyeSize: 255, eyeStalk: 255 });
    valid(p);
    const e = p.eyes;
    expect(e.count).toBe(2);
    expect(e.size).toBeCloseTo(D.eyes.size[1] as number, 12);
    expect(e.stalk).toBeCloseTo(D.eyes.stalk[1] as number, 12);
    expect(e.y).toBeGreaterThan(0);
    const head = p.segments[0] as PlanSegment;
    const root = [head.rx * cos(e.angle), head.ry * sin(e.angle)];
    expect(Math.hypot(e.x - (root[0] as number), e.y - (root[1] as number))).toBeCloseTo(
      e.stalk + e.size,
      12,
    );
    const small = body({ eyeSize: 60 }).eyes;
    expect(small.count).toBe(2);
    expect(small.size).toBeGreaterThan(D.eyes.size[0] as number);
    expect(small.size).toBeLessThan(e.size);
    expect(small.stalk).toBe(0);
  });
});

describe('bodyViolations: the v2 rules', () => {
  const base = (): BodyPlan => body({ curve: 128, fusion: 128, eyeSize: 200 });

  it('accepts a developed v2 plan', () => {
    valid(base());
  });

  it('flags neighbours that came apart', () => {
    const p = base();
    (p.segments[5] as PlanSegment).x -= 1;
    expect(bodyViolations(p).join()).toMatch(/do not overlap/);
  });

  it('flags a bad carapace and plates under it', () => {
    const p = base();
    p.carapace.count = 9;
    expect(bodyViolations(p).join()).toMatch(/carapace: 9/);
    const q = base();
    q.carapace.rx = 0;
    expect(bodyViolations(q).join()).toMatch(/carapace with no size/);
    const r = base();
    r.plates.push({ segment: 0, coverage: 1, thickness: 0.1 });
    expect(bodyViolations(r).join()).toMatch(/plate under the carapace/);
  });

  it('flags bad eyes', () => {
    const p = base();
    p.eyes.count = 1;
    expect(bodyViolations(p).join()).toMatch(/eyes: 1/);
    const q = base();
    q.eyes.size = 0.9;
    expect(bodyViolations(q).join()).toMatch(/eyes: radius/);
    const r = base();
    r.eyes.x = -2.5;
    expect(bodyViolations(r).join()).toMatch(/bounds/);
  });

  it('flags an uneven radial ring and an offset radial mouth', () => {
    const p = plan(
      { M1: { length: 150, thickness: 60, tipShape: 255, beat: 220, pairs: 255 } },
      { symmetry: 255, mouthType: 255 },
    );
    valid(p);
    (p.appendages[0] as BodyPlan['appendages'][number]).angle += 0.1;
    (p.appendages[1] as BodyPlan['appendages'][number]).angle += 0.1;
    expect(bodyViolations(p).join()).toMatch(/evenly spaced/);
    const q = plan({}, { symmetry: 255 });
    q.mouth = { ...q.mouth, offset: 0.4 };
    expect(bodyViolations(q).join()).toMatch(/mouth is not central/);
  });
});
