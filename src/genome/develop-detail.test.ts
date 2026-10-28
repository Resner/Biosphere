import { describe, expect, it } from 'vitest';
import { buildBytes, metricsAt, type Params } from '../../tests/archetypes';
import { createRng, seedFromString } from '../sim/prng';
import { RULES } from '../sim/rules';
import { decodeGenome } from './codec';
import {
  type Appendage,
  type BodyPlan,
  bodyViolations,
  develop,
  dirOf,
  type Membrane,
  type PlanSegment,
  planBounds,
  polygonArea,
  rootOf,
} from './develop';
import { express } from './express';
import { mutateGenome } from './inherit';
import { GENOME_BYTES } from './karyotype';
import { buildCreature } from './stats';

// Development v2, fine parts (M6 T8, ADR 0025): webbing, setae, bulbs, chelae and joint beads are
// detail on parts, never parts. The plan keeps them as numbers on each appendage and as membrane
// polygons; the sim sees them only through the stats.

const D = RULES.develop;
const F = D.detail;
const V2 = RULES.stats.v2;

const plan = (modules: Record<string, Params>, set: Record<string, number> = {}): BodyPlan =>
  develop(express(decodeGenome(buildBytes(modules, set))));
const creature = (modules: Record<string, Params>, set: Record<string, number> = {}) =>
  buildCreature(decodeGenome(buildBytes(modules, set)));

const valid = (p: BodyPlan): void => {
  expect(bodyViolations(p)).toEqual([]);
};

const widthOf = (thickness: number): number =>
  (D.width[0] as number) + ((D.width[1] as number) - (D.width[0] as number)) * (thickness / 255);

/** Twice the signed area of the turn at `b` (positive: counter-clockwise). */
const cross = (a: Membrane['points'][number], b: typeof a, c: typeof a): number =>
  (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);

const convex = (m: Membrane): boolean =>
  m.points.every((p, i, ps) => {
    const n = ps.length;
    return cross(p, ps[(i + 1) % n] as typeof p, ps[(i + 2) % n] as typeof p) >= -1e-12;
  });

/** Where the part reaches at `t` of its length, straight along its growth direction. */
const along = (p: BodyPlan, a: Appendage, t: number) => {
  const s = p.segments[a.segment] as PlanSegment;
  const root = rootOf(s, a.angle, a.side);
  const dir = dirOf(s, a);
  return { x: root.x + t * a.length * dir.x, y: root.y + t * a.length * dir.y };
};

/** A broad rowing pair: the propulsion every test body keeps. */
const ROW: Params = { length: 150, thickness: 120, tipShape: 191, beat: 220, angle: 128 };

describe('fine parts: webbing', () => {
  it('spans a membrane from a part to each of its branches, growing with webbing', () => {
    const fork: Params = { ...ROW, branching: 255 };
    expect(plan({ M1: fork }).membranes).toEqual([]);
    const half = plan({ M1: { ...fork, webbing: 128 } });
    const full = plan({ M1: { ...fork, webbing: 255 } });
    for (const p of [half, full]) {
      valid(p);
      // Two branches on each side: one sheet between the part and each branch.
      expect(p.appendages[0]?.branches).toBe(2);
      expect(p.membranes).toHaveLength(4);
      for (const m of p.membranes) {
        expect(m.to).toBe(m.part);
        expect(m.points).toHaveLength(3);
        expect(polygonArea(m.points)).toBeGreaterThan(0);
        expect(convex(m)).toBe(true);
      }
    }
    const area = (p: BodyPlan) => p.membranes.reduce((s, m) => s + polygonArea(m.points), 0);
    // A sheet reaches `webbing` of the way along its rays, so its area grows with the square.
    expect(area(full) / area(half)).toBeCloseTo((255 / 128) ** 2, 6);
    const a = full.appendages[0] as Appendage;
    expect(a.webbing).toBe(1);
    // The sheet starts where the branches leave the part.
    const fork0 = along(full, a, D.branchAt);
    const sheet = full.membranes.find((m) => m.part === 0) as Membrane;
    expect(sheet.points.some((q) => Math.hypot(q.x - fork0.x, q.y - fork0.y) < 1e-12)).toBe(true);
  });

  it('spans a membrane to the next part rearward on the same side (webSpan)', () => {
    // Three pairs on one segment, close together: each webs to the next one behind it.
    const p = plan({ M1: { ...ROW, pairs: 255, webbing: 255 } });
    valid(p);
    const left = p.appendages.map((a, i) => ({ a, i })).filter(({ a }) => a.side === 1);
    expect(left).toHaveLength(3);
    const webs = p.membranes.filter((m) => m.to !== m.part);
    // Each side links its three parts with two sheets.
    expect(webs.filter((m) => p.appendages[m.part]?.side === 1)).toHaveLength(2);
    expect(webs.filter((m) => p.appendages[m.part]?.side === -1)).toHaveLength(2);
    for (const m of webs) {
      const [a, b] = [p.appendages[m.part], p.appendages[m.to]] as [Appendage, Appendage];
      expect(b.side).toBe(a.side);
      const gap = Math.hypot(
        along(p, a, 0).x - along(p, b, 0).x,
        along(p, a, 0).y - along(p, b, 0).y,
      );
      expect(gap).toBeLessThanOrEqual(F.webSpan + 1e-12);
    }
    // Parts too far apart do not web: one at the front, one at the back of a long body.
    const apart = plan(
      {
        M1: { ...ROW, angle: 10, webbing: 255 },
        M2: { ...ROW, angle: 10, attachStart: 255, webbing: 255 },
      },
      { segDrive1: 255, segDrive2: 255, aspect: 255 },
    );
    valid(apart);
    const sameSide = (m: Membrane) =>
      m.to !== m.part && apart.appendages[m.to]?.side === apart.appendages[m.part]?.side;
    expect(apart.membranes.filter(sameSide)).toEqual([]);
  });

  it('forms a tail fan when the rearmost parts are webbed', () => {
    const tail: Params = {
      length: 160,
      thickness: 160,
      tipShape: 191,
      beat: 220,
      angle: 255,
      attachStart: 255,
      webbing: 255,
    };
    const p = plan({ M1: tail }, { segDrive1: 160, segDrive2: 160 });
    valid(p);
    const fan = p.membranes.filter(
      (m) => p.appendages[m.part]?.side === 1 && p.appendages[m.to]?.side === -1,
    );
    expect(fan).toHaveLength(1);
    const m = fan[0] as Membrane;
    expect(m.to).toBe(m.part + 1); // the part's own mirror image
    // It sits behind the body and is symmetric about the axis.
    const rear = Math.min(...p.segments.map((s) => s.x - s.rx));
    const cx = m.points.reduce((s, q) => s + q.x, 0) / m.points.length;
    expect(cx).toBeLessThan(rear + 0.5);
    const ys = m.points.map((q) => q.y).sort((a, b) => a - b);
    expect(ys[0]).toBeCloseTo(-(ys[ys.length - 1] as number), 12);
    // Without webbing there is no fan.
    expect(
      plan({ M1: { ...tail, webbing: 0 } }, { segDrive1: 160, segDrive2: 160 }).membranes,
    ).toEqual([]);
  });

  it('keeps membranes inside the bounds, and the bounds count them', () => {
    const p = plan(
      {
        M1: { length: 255, thickness: 255, tipShape: 191, beat: 220, angle: 128, pairs: 255 },
        M2: { length: 255, thickness: 200, tipShape: 191, beat: 200, branching: 255, angle: 200 },
      },
      { segDrive1: 120, segDrive2: 120 },
    );
    const webbed = plan(
      {
        M1: {
          length: 255,
          thickness: 255,
          tipShape: 191,
          beat: 220,
          angle: 128,
          pairs: 255,
          webbing: 255,
        },
        M2: {
          length: 255,
          thickness: 200,
          tipShape: 191,
          beat: 200,
          branching: 255,
          angle: 200,
          webbing: 255,
        },
      },
      { segDrive1: 120, segDrive2: 120 },
    );
    valid(webbed);
    expect(webbed.membranes.length).toBeGreaterThan(4);
    for (const m of webbed.membranes) {
      for (const q of m.points) expect(Math.hypot(q.x, q.y)).toBeLessThanOrEqual(D.caps.bounds);
    }
    // Webbing is detail: it never adds, drops or moves a part. Under karyotype v2 a sheet keeps
    // its part straighter and must keep its rays in the bounds too, so how a long part sweeps or is
    // cut to fit may differ (M6 T14b); under the v1 rule nothing about the part changes.
    expect(webbed.appendages.map((a) => [a.module, a.segment, a.width, a.angle])).toEqual(
      p.appendages.map((a) => [a.module, a.segment, a.width, a.angle]),
    );
    const v1 = (modules: Record<string, Params>) => {
      const traits = express(decodeGenome(buildBytes(modules, { segDrive1: 120, segDrive2: 120 })));
      return develop({ ...traits, karyotype: 1 }).appendages.map((a) => [
        a.length,
        a.width,
        a.angle,
      ]);
    };
    const bare = {
      M1: { length: 255, thickness: 255, tipShape: 191, beat: 220, angle: 128, pairs: 255 },
      M2: { length: 255, thickness: 200, tipShape: 191, beat: 200, branching: 255, angle: 200 },
    };
    const sheet = {
      M1: { ...bare.M1, webbing: 255 },
      M2: { ...bare.M2, webbing: 255 },
    };
    expect(v1(sheet)).toEqual(v1(bare));
  });
});

describe('fine parts: setae', () => {
  it('gives 0-24 bristles per part by density, each setae length × width × 6 long', () => {
    const one = (setaeDensity: number, setaeLength: number) =>
      plan({ M1: { ...ROW, length: 60, setaeDensity, setaeLength } }).appendages[0] as Appendage;
    expect(one(0, 255).setae).toBe(0);
    expect(one(255, 0).setae).toBe(0); // no length, no bristles
    expect(one(255, 0).setaeLength).toBe(0);
    expect(one(255, 100).setae).toBe(F.setae.perPart);
    expect(one(128, 100).setae).toBe(Math.round((128 / 255) * F.setae.perPart));
    expect(one(255, 100).setaeLength).toBeCloseTo((100 / 255) * widthOf(120) * F.setae.length, 12);
    valid(plan({ M1: { ...ROW, setaeDensity: 255, setaeLength: 255 } }));
  });

  it('shortens bristles that would reach past the bounds, and keeps them inside', () => {
    const p = plan(
      {
        M1: {
          length: 255,
          thickness: 255,
          tipShape: 191,
          beat: 220,
          angle: 128,
          setaeDensity: 255,
          setaeLength: 255,
        },
      },
      { segDrive1: 255, segDrive2: 255, aspect: 255 },
    );
    valid(p);
    const a = p.appendages[0] as Appendage;
    expect(a.setaeLength).toBeLessThan(widthOf(255) * F.setae.length);
    expect(planBounds(p)).toBeLessThanOrEqual(D.caps.bounds);
  });

  it('caps the body at 240, dropping the excess from the shortest parts first', () => {
    const modules: Record<string, Params> = {};
    ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8'].forEach((id, k) => {
      modules[id] = {
        length: 40 + 20 * k,
        thickness: 30,
        tipShape: 255,
        beat: 200,
        angle: 20 + 30 * k,
        pairs: 255,
        attachSpan: 255,
        setaeDensity: 255,
        setaeLength: 40,
      };
    });
    const p = plan(modules, { segDrive1: 255, segDrive2: 255 });
    valid(p);
    const total = p.appendages.reduce((s, a) => s + a.setae, 0);
    expect(p.appendages.length * F.setae.perPart).toBeGreaterThan(F.setae.perBody);
    expect(total).toBe(F.setae.perBody);
    // Longer parts keep their bristles; the cut falls on the shortest (ties: the later part first).
    const byLength = p.appendages
      .map((a, i) => ({ a, i }))
      .sort((x, y) => x.a.length - y.a.length || y.i - x.i)
      .map(({ a }) => a);
    const cut = byLength.findIndex((a) => a.setae === F.setae.perPart);
    expect(cut).toBeGreaterThan(0);
    for (const a of byLength.slice(cut)) expect(a.setae).toBe(F.setae.perPart);
    // Mirror pairs keep the same count.
    for (let i = 0; i < p.appendages.length; i += 2) {
      expect(p.appendages[i]?.setae).toBe(p.appendages[i + 1]?.setae);
    }
    // Deterministic.
    expect(plan(modules, { segDrive1: 255, segDrive2: 255 })).toEqual(p);
  });
});

describe('fine parts: bulbs, beads and chelae', () => {
  it('tips a part with a bead of radius bulb × width × 2 above bulb 0.3', () => {
    expect((plan({ M1: { ...ROW, bulb: 70 } }).appendages[0] as Appendage).bulb).toBe(0);
    const p = plan({ M1: { ...ROW, length: 60, bulb: 200 } });
    valid(p);
    expect((p.appendages[0] as Appendage).bulb).toBeCloseTo(
      (200 / 255) * widthOf(120) * F.bulb.scale,
      12,
    );
    // At the bounds the bulb shrinks and the part makes room for it.
    const far = plan(
      { M1: { length: 255, thickness: 255, tipShape: 191, beat: 220, angle: 128, bulb: 255 } },
      { segDrive1: 255, segDrive2: 255, aspect: 255 },
    );
    valid(far);
    const a = far.appendages[0] as Appendage;
    expect(a.bulb).toBeGreaterThan(0);
    expect(planBounds(far)).toBeLessThanOrEqual(D.caps.bounds);
  });

  it('marks each joint with a swelling by the beads gene', () => {
    const p = plan({ M1: { ...ROW, joints: 255, beads: 255 } });
    valid(p);
    expect((p.appendages[0] as Appendage).beads).toBe(1);
    expect((plan({ M1: ROW }).appendages[0] as Appendage).beads).toBe(0);
  });

  it('gives a hooked or pointed tip an opposable last joint above chela 0.5', () => {
    const hook: Params = { length: 200, thickness: 120, tipShape: 128, stiffness: 255, angle: 30 };
    const claw = (tipShape: number, chela: number) =>
      plan({ M1: ROW, M2: { ...hook, tipShape, chela } }).appendages.find(
        (a) => a.module === 1,
      ) as Appendage;
    expect(claw(128, 200).chela).toBeCloseTo(200 / 255, 12);
    expect(claw(64, 255).chela).toBe(1);
    expect(claw(128, 120).chela).toBe(0);
    expect(claw(255, 255).chela).toBe(0); // a whip
    expect(claw(0, 255).chela).toBe(0); // blunt
    valid(plan({ M1: ROW, M2: { ...hook, chela: 255 } }));
  });
});

describe('fine parts: stats follow form', () => {
  it('makes webbing add paddle thrust that rises with size, plus drag and mass', () => {
    const fork: Params = { ...ROW, branching: 255, pairs: 255 };
    const plain = { M1: fork };
    const webbed = { M1: { ...fork, webbing: 255 } };
    const [p, w] = [creature(plain).stats, creature(webbed).stats];
    expect(w.drag).toBeGreaterThan(p.drag);
    expect(w.mass).toBeGreaterThan(p.mass);
    const gain = (size: number) =>
      (metricsAt(decodeGenome(buildBytes(webbed)), size).acceleration /
        metricsAt(decodeGenome(buildBytes(plain)), size).acceleration) as number;
    expect(gain(30_000)).toBeGreaterThan(gain(100));
    expect(gain(30_000)).toBeGreaterThan(1);
  });

  it('makes setae add drag, widen a filter mouth by up to 25% and widen the detection ring', () => {
    const filter = { mouthSize: 128, mouthType: 0 };
    const bare = creature({ M1: ROW }, filter).stats;
    const hairy = creature(
      { M1: { ...ROW, pairs: 255, setaeDensity: 255, setaeLength: 255 } },
      filter,
    ).stats;
    const rows = creature({ M1: { ...ROW, pairs: 255 } }, filter).stats;
    expect(hairy.drag).toBeGreaterThan(rows.drag);
    expect(hairy.sense).toBeGreaterThan(rows.sense);
    expect(hairy.mouth.radius).toBeGreaterThan(bare.mouth.radius);
    expect(hairy.mouth.radius).toBeLessThanOrEqual(
      bare.mouth.radius * (1 + V2.setae.mouth) + 1e-12,
    );
    // A jaw is no filter: setae leave it as it is.
    const jaw = { mouthSize: 128, mouthType: 255 };
    expect(
      creature({ M1: { ...ROW, setaeDensity: 255, setaeLength: 255 } }, jaw).stats.mouth.radius,
    ).toBe(creature({ M1: ROW }, jaw).stats.mouth.radius);
  });

  it('makes bulbs add contact damage like spines, and chelae weapon power', () => {
    expect(creature({ M1: { ...ROW, bulb: 255 } }).stats.combat.spines).toBeGreaterThan(
      creature({ M1: ROW }).stats.combat.spines,
    );
    const hook: Params = { length: 200, thickness: 120, tipShape: 128, stiffness: 255, angle: 30 };
    const plainHook = creature({ M1: ROW, M2: hook }).stats;
    const chela = creature({ M1: ROW, M2: { ...hook, chela: 255 } }).stats;
    expect(chela.combat.power).toBeGreaterThan(plainHook.combat.power);
    expect(chela.mass).toBeGreaterThan(plainHook.mass);
  });

  it('adds every feature to the basal complexity factor', () => {
    const base = creature({ M1: { ...ROW, branching: 255, joints: 255, tipShape: 128 } }).stats
      .basal;
    for (const ext of ['webbing', 'setaeDensity', 'bulb', 'chela', 'beads'] as const) {
      const extra: Params = { [ext]: 255, ...(ext === 'setaeDensity' ? { setaeLength: 128 } : {}) };
      const s = creature({
        M1: { ...ROW, branching: 255, joints: 255, tipShape: 128, ...extra },
      }).stats;
      expect(s.basal, ext).toBeGreaterThan(base);
    }
  });
});

describe('fine parts: totals and membranes over random and mutated genomes', () => {
  const rng = createRng(seedFromString('genome-develop-detail'), 'bytes');
  const randomBytes = (): Uint8Array =>
    Uint8Array.from({ length: GENOME_BYTES }, () => rng.nextU32() & 0xff);

  const check = (p: BodyPlan, label: string): { webs: number; setae: number } => {
    const bad: string[] = [];
    let total = 0;
    for (const a of p.appendages) {
      total += a.setae;
      if (a.setae > F.setae.perPart || a.setae < 0 || a.setae !== Math.floor(a.setae))
        bad.push('setae');
      for (const v of [a.webbing, a.setaeLength, a.bulb, a.chela, a.beads]) {
        if (!Number.isFinite(v) || v < 0) bad.push('detail');
      }
    }
    if (total > F.setae.perBody) bad.push(`setae total ${total}`);
    for (const m of p.membranes) {
      if (!(polygonArea(m.points) > 0)) bad.push('degenerate membrane');
      if (!convex(m)) bad.push('membrane not convex');
      if (m.points.some((q) => !Number.isFinite(q.x) || !Number.isFinite(q.y))) bad.push('NaN');
      if (m.points.some((q) => Math.hypot(q.x, q.y) > D.caps.bounds)) bad.push('membrane outside');
    }
    bad.push(...bodyViolations(p));
    if (bad.length > 0) expect(bad, label).toEqual([]);
    return { webs: p.membranes.length, setae: total };
  };

  it('holds over 10,000 random genomes', () => {
    let webs = 0;
    let setae = 0;
    for (let i = 0; i < 10_000; i++) {
      const r = check(develop(express(decodeGenome(randomBytes()))), `random ${i}`);
      webs += r.webs > 0 ? 1 : 0;
      setae += r.setae > 0 ? 1 : 0;
    }
    // The property is not vacuous: most random bodies carry both.
    expect(webs).toBeGreaterThan(3_000);
    expect(setae).toBeGreaterThan(3_000);
  });

  it('holds over 10,000 mutated genomes', () => {
    for (let i = 0; i < 10_000; i++) {
      const g = mutateGenome(decodeGenome(randomBytes()), seedFromString(`detail-${i}`), {
        mutation: 4,
      });
      check(develop(express(g)), `mutated ${i}`);
    }
  });
});

describe('bodyViolations: the fine-part rules', () => {
  const base = (): BodyPlan =>
    plan({
      M1: { ...ROW, pairs: 255, branching: 255, webbing: 255, setaeDensity: 255, setaeLength: 80 },
    });

  it('accepts a developed plan with every feature', () => {
    valid(base());
    expect(base().membranes.length).toBeGreaterThan(0);
  });

  it('flags too many setae on a part or on the body', () => {
    const p = base();
    (p.appendages[0] as Appendage).setae = F.setae.perPart + 1;
    expect(bodyViolations(p).join()).toMatch(/setae/);
    const q = base();
    for (const a of q.appendages) a.setae = F.setae.perPart;
    q.appendages.push(...q.appendages.slice(0, 6).map((a) => ({ ...a, segment: 0 })));
    expect(bodyViolations(q).join()).toMatch(/setae: \d+ on the body/);
  });

  it('flags a degenerate, concave, stray or orphaned membrane', () => {
    const p = base();
    const m = p.membranes[0] as Membrane;
    m.points = [m.points[0], m.points[0], m.points[0]] as Membrane['points'];
    expect(bodyViolations(p).join()).toMatch(/membrane/);
    const q = base();
    q.membranes.push({
      part: 0,
      to: 0,
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0.2, y: 0.2 },
        { x: 0, y: 1 },
      ],
    });
    expect(bodyViolations(q).join()).toMatch(/membrane .*not convex/);
    const r = base();
    r.membranes.push({
      part: 0,
      to: 0,
      points: [
        { x: 0, y: 0 },
        { x: 3, y: 0 },
        { x: 0, y: 1 },
      ],
    });
    expect(bodyViolations(r).join()).toMatch(/bounds/);
    const s = base();
    (s.membranes[0] as Membrane).part = 99;
    expect(bodyViolations(s).join()).toMatch(/membrane .*part/);
  });

  it('flags a chela without a weapon tip and bad detail values', () => {
    const p = base();
    (p.appendages[0] as Appendage).chela = 1; // a paddle tip
    expect(bodyViolations(p).join()).toMatch(/chela/);
    const q = base();
    (q.appendages[0] as Appendage).bulb = -1;
    expect(bodyViolations(q).join()).toMatch(/detail/);
  });
});

describe('fine parts: v1 behaviour at zero', () => {
  it('leaves the plan without detail when every extension byte is 0', () => {
    const p = plan({ M1: { ...ROW, pairs: 255, branching: 255 } });
    expect(p.membranes).toEqual([]);
    for (const a of p.appendages) {
      expect([a.webbing, a.setae, a.setaeLength, a.bulb, a.chela, a.beads]).toEqual([
        0, 0, 0, 0, 0, 0,
      ]);
    }
  });

  it('turns a sheet with its part, on a curved body too', () => {
    const p = plan(
      { M1: { ...ROW, pairs: 255, webbing: 255, attachSpan: 255 } },
      { segDrive1: 200, segDrive2: 200, curve: 150 },
    );
    valid(p);
    expect(p.membranes.length).toBeGreaterThan(0);
    // Every sheet keeps a corner on its own part's root or along its ray.
    for (const m of p.membranes) {
      const a = p.appendages[m.part] as Appendage;
      const s = p.segments[a.segment] as PlanSegment;
      const root = rootOf(s, a.angle, a.side);
      const dir = dirOf(s, a);
      const onRay = m.points.some((q) => {
        const [dx, dy] = [q.x - root.x, q.y - root.y];
        return Math.abs(dx * dir.y - dy * dir.x) < 1e-9 && dx * dir.x + dy * dir.y >= -1e-9;
      });
      expect(onRay).toBe(true);
    }
  });
});
