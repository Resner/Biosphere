import { describe, expect, it } from 'vitest';
import { buildBytes, type Params } from '../../tests/archetypes';
import { cos, PI, sin } from '../sim/math';
import { createRng, seedFromString } from '../sim/prng';
import { RULES } from '../sim/rules';
import { decodeGenome } from './codec';
import { type BodyPlan, bodyViolations, develop, type PlanSegment, ringAngle } from './develop';
import { express } from './express';
import { GENOME_BYTES } from './karyotype';

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
    // Below a worm's curl (M6b T5), so the straight twin is the same body laid straight.
    const curve = 85;
    expect(curve / 255).toBeLessThan(D.chain.trunk.worm.curl);
    const straight = body({});
    const curved = body({ curve });
    valid(curved);
    const angles = curved.segments.map((s) => s.angle);
    expect(angles[0]).toBe(0);
    expect(angles[7]).toBeCloseTo((curve / 255) * PI, 9);
    for (let i = 1; i < 8; i++) expect(angles[i]).toBeGreaterThan(angles[i - 1] as number);
    expect(curved.form).toEqual({
      turn: (curve / 255) * PI,
      mode: 0,
      radial: 0,
      slim: expect.any(Number),
    });
    // The curled chain fits the bounds along its curve (M6b T6): its links grow by at most
    // `curve.longer`, it keeps its girth, and it reaches no farther than laid straight.
    for (let i = 1; i < 8; i++) {
      const [a, b] = [curved.segments[i - 1], curved.segments[i]] as [PlanSegment, PlanSegment];
      const [s, t] = [straight.segments[i - 1], straight.segments[i]] as [PlanSegment, PlanSegment];
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeLessThanOrEqual(D.curve.longer * (s.x - t.x));
      expect(b.ry / curved.form.slim).toBeCloseTo(t.ry / straight.form.slim, 9);
    }
    const far = (p: BodyPlan) =>
      Math.max(...p.segments.map((s) => Math.hypot(s.x, s.y) + Math.max(s.rx, s.ry)));
    expect(far(curved)).toBeLessThanOrEqual(far(straight) + 1e-9);
    const tail = curved.segments[7] as PlanSegment;
    expect(Math.hypot(tail.x, tail.y)).toBeLessThan(
      Math.abs((straight.segments[7] as PlanSegment).x),
    );
    expect(Math.abs(tail.y)).toBeGreaterThan(0.3);
  });

  it('splits the turn into two opposite arcs in S mode', () => {
    const s = body({ curve: 120, curveMode: 255 });
    valid(s);
    const angles = s.segments.map((x) => x.angle);
    // Each arc turns `sArc` × curve × π (M6b T6), peaking on the middle segment.
    const arc = D.curve.sArc * (120 / 255) * PI;
    expect(s.form).toEqual({ turn: 2 * arc, mode: 1, radial: 0, slim: expect.any(Number) });
    expect(Math.max(...angles)).toBeCloseTo(arc, 9);
    expect(angles[7]).toBeCloseTo(0, 9);
    // The heading rises, then falls: one change of direction.
    const steps = angles
      .slice(1)
      .map((a, i) => Math.sign(a - (angles[i] as number)))
      .filter((x) => x !== 0);
    expect(steps.filter((x, i) => i > 0 && x !== steps[i - 1])).toHaveLength(1);
    // A deep S keeps each arc within `sMax` × π, and a short chain's S stays shallow.
    expect(body({ curve: 200, curveMode: 255 }).form.turn).toBeCloseTo(2 * D.curve.sMax * PI, 9);
    const short = plan(SWIM, { segDrive1: 128, aspect: 128, curve: 120, curveMode: 255 });
    expect(short.segments.length).toBeLessThan(D.curve.sFrom);
    expect(short.form.turn).toBeCloseTo((120 / 255) * PI, 9);
  });

  it('coils above 0.8: a chambered spiral of 1.25 turns or more, tightening toward the tail', () => {
    const c = body({ curve: 255, tailTaper: 255 });
    valid(c);
    const [lo, hi] = D.curve.coilTurn as readonly [number, number];
    expect(c.form.mode).toBe(2);
    expect(c.form.turn).toBeCloseTo(hi * PI, 9);
    expect(c.segments).toHaveLength(D.caps.segments);
    const angles = c.segments.map((s) => s.angle);
    expect(angles[7]).toBeCloseTo(hi * PI, 9);
    // Every link turns alike, and each is shorter than the one in front (the head's is its own).
    const turns = angles.slice(1).map((a, i) => a - (angles[i] as number));
    for (const t of turns) expect(t).toBeCloseTo(hi * (PI / 7), 9);
    const links = c.segments
      .slice(1)
      .map((s, i) =>
        Math.hypot(s.x - (c.segments[i] as PlanSegment).x, s.y - (c.segments[i] as PlanSegment).y),
      );
    for (let i = 2; i < links.length; i++) {
      expect(links[i]).toBeLessThan(links[i - 1] as number);
    }
    // Just past the threshold it turns `coilTurn[0]` × π, whatever its segment genes say.
    const few = plan(SWIM, { segDrive1: 128, aspect: 128, curve: 205 });
    expect(few.form.turn).toBeCloseTo(PI * (lo + ((205 / 255 - 0.8) / 0.2) * (hi - lo)), 9);
    expect(few.segments).toHaveLength(D.caps.segments);
    valid(few);
    // Just below the threshold the C arc still has its plain turn.
    expect(body({ curve: 204 }).form).toEqual({
      turn: (204 / 255) * PI,
      mode: 0,
      radial: 0,
      slim: expect.any(Number),
    });
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
  const K = D.chain.trunk;
  /**
   * Each segment's girth: its half-width before the chain was slimmed to read long (look pass 4,
   * ADR 0031). Slimming narrows every segment by one factor, so the tagma profile holds in it.
   */
  const radii = (set: Record<string, number>): number[] => {
    const p = body(set);
    return p.segments.map((s) => s.ry / p.form.slim);
  };
  /** The trunk profile without the tagma loci (M6b T5): it rises to `trunk.at`, then drops. */
  const bare = (i: number): number => {
    const t = i / 7;
    return (
      (1 - K.rise * Math.max(0, 1 - t / K.at)) * (1 - K.drop * Math.max(0, (t - K.at) / (1 - K.at)))
    );
  };
  const tail = (i: number): number => Math.max(0, (i / 7 - (1 - T.tailShare)) / T.tailShare);
  const plain = radii({});
  const widest = (r: number[]): number => r.indexOf(Math.max(...r.slice(1)));

  it('draws one body widest at the trunk without them (M6b T5)', () => {
    expect(body({}).form.slim).toBeLessThan(1);
    // Behind the head the chain rises to its peak near `trunk.at` and narrows to the tail.
    expect(widest(plain) / 7).toBeCloseTo(K.at, 0);
    for (let i = 2; i < 8; i++) {
      expect((plain[i] as number) / (plain[1] as number)).toBeCloseTo(bare(i) / bare(1), 12);
    }
    // The head is the low end of `trunk.head` of the widest trunk segment.
    expect((plain[0] as number) / Math.max(...plain.slice(1))).toBeCloseTo(K.head[0] as number, 12);
  });

  it('pins the head-scale extreme: a larger head share, and the chain narrows by 1 ÷ (1 + head)', () => {
    const r = radii({ headScale: 255 });
    expect((r[0] as number) / Math.max(...r.slice(1))).toBeCloseTo(K.head[1] as number, 12);
    expect(K.head[1]).toBeLessThanOrEqual(0.9);
    // Every trunk segment narrows by one factor: 1 ÷ (1 + head), eased a little where the shorter
    // chain need not narrow to fit its reach.
    const k = (r[1] as number) / (plain[1] as number);
    for (let i = 2; i < 8; i++) expect((r[i] as number) / (plain[i] as number)).toBeCloseTo(k, 12);
    expect(k).toBeGreaterThanOrEqual(1 / (1 + T.head));
    expect(k).toBeLessThan(0.6);
  });

  it('pins the trunk-swell extreme: the peak widens most', () => {
    const r = radii({ trunkSwell: 255 });
    expect(widest(r) / 7).toBeCloseTo(K.at, 0);
    const swell = (i: number): number =>
      1 + T.trunk * Math.max(0, 1 - Math.abs(i / 7 - K.at) / T.trunkSpread);
    for (let i = 2; i < 8; i++) {
      expect((r[i] as number) / (r[1] as number)).toBeCloseTo(
        (bare(i) * swell(i)) / (bare(1) * swell(1)),
        12,
      );
    }
  });

  it('pins the tail extremes: tail length stretches the rear, tail taper narrows it', () => {
    const long = body({ tailLength: 255 }).segments;
    const flat = body({}).segments;
    const rx = (s: PlanSegment[], i: number) => (s[i] as PlanSegment).rx;
    expect(rx(long, 7) / rx(long, 1) / (rx(flat, 7) / rx(flat, 1))).toBeCloseTo(
      1 + T.tailLength,
      9,
    );
    const r = radii({ tailTaper: 255 });
    for (let i = 1; i < 8; i++) {
      expect((r[i] as number) / (r[1] as number)).toBeCloseTo(
        (bare(i) * (1 - T.tailTaper * tail(i))) / bare(1),
        12,
      );
    }
    expect((r[7] as number) / (plain[7] as number)).toBeCloseTo(
      ((1 - T.tailTaper) * (r[1] as number)) / (plain[1] as number),
      12,
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

  it('sets a stalkless eye into the head, as reference 05 draws big dark eyes (look pass 5)', () => {
    const p = body({ eyeSize: 255, eyeStalk: 0 });
    valid(p);
    const e = p.eyes;
    expect(e.stalk).toBe(0);
    const head = p.segments[0] as PlanSegment;
    const root = { x: head.rx * cos(e.angle), y: head.ry * sin(e.angle) };
    // Its centre lies `set` of its radius in from where a stalked eye would start: inside the
    // head's outline, toward its middle, so most of the eye is within the head.
    const inward = Math.hypot(e.x - head.x, e.y - head.y) < Math.hypot(root.x, root.y);
    expect(inward).toBe(true);
    expect(Math.hypot(e.x - root.x, e.y - root.y)).toBeCloseTo(e.size * (2 * D.eyes.set - 1), 12);
    expect(D.eyes.set).toBeGreaterThan(0.5);
    // A half-length stalk sinks it half as far.
    const half = body({ eyeSize: 255, eyeStalk: 128 }).eyes;
    const sink = D.eyes.set * (1 - half.stalk / (D.eyes.stalk[1] as number));
    const r2 = { x: head.rx * cos(half.angle), y: head.ry * sin(half.angle) };
    expect(Math.hypot(half.x - r2.x, half.y - r2.y)).toBeCloseTo(
      Math.abs(half.stalk + half.size * (1 - 2 * sink)),
      12,
    );
  });

  it('keeps a stalkless pair inside the head and apart, so a small trunk head has smaller eyes (ADR 0037)', () => {
    // A stalkless eye lies wholly inside the head, its edge on the outline, so the rim runs round it.
    expect(D.eyes.set).toBe(1);
    const p = body({ eyeSize: 255, eyeStalk: 0 });
    valid(p);
    const e = p.eyes;
    expect(e.size).toBeLessThan(D.eyes.size[1] as number);
    expect(e.y).toBeGreaterThanOrEqual(e.size - 1e-12);
    // The rule only ever shrinks an eye down to the gene range's floor, over random v2 genomes.
    const r = createRng(seedFromString('develop-v2-eye-pair'), 'bytes');
    let capped = 0;
    for (let i = 0; i < 2_000; i++) {
      const bytes = Uint8Array.from({ length: GENOME_BYTES }, () => r.nextU32() & 0xff);
      const q = develop(express(decodeGenome(bytes)));
      const eye = q.eyes;
      if (eye.count === 0) continue;
      expect(eye.size).toBeGreaterThanOrEqual(D.eyes.size[0] as number);
      if (eye.size > (D.eyes.size[0] as number)) {
        expect(eye.y).toBeGreaterThanOrEqual(eye.size - 1e-12);
      }
      if (eye.size < (D.eyes.size[1] as number) - 1e-9) capped++;
    }
    expect(capped).toBeGreaterThan(0);
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
