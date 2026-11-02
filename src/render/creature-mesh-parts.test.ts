import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { heavyTest } from '../../tests/heavy';
import { type BodyPlan, type PlanSegment, polygonArea } from '../genome/develop';
import { genesisGenome } from '../genome/genesis';
import { buildCreature } from '../genome/stats';
import { parseSpecimen } from '../lab/gallery';
import { seedFromString } from '../sim/prng';
import { RULES } from '../sim/rules';
import { anatomyOf } from './anatomy';
import { CreatureCache, FULL_ABOVE, LOW_BELOW, lodFor } from './creature-cache';
import {
  buildCreatureGeometry,
  estimateVertices,
  type Lod,
  meshDetail,
  NO_WALL,
  PART_APPENDAGE,
  PART_BODY,
  PART_CHAMBER,
  PART_DROPLET,
  PART_EYE,
  PART_HEART,
  PART_MEMBRANE,
  PART_MOUTH,
  PART_PLATE,
  PART_SETA,
  PART_SETULE,
  PART_STALK,
  partId,
  partKind,
  partRadius,
  wallsAlong,
} from './creature-mesh';
import {
  anatomyFor,
  attr,
  BRISTLED,
  BRISTLES,
  gallery,
  groups,
  indexOf,
  insideBody,
  LODS,
  named,
  planOf,
  randoms,
  specimen,
} from './creature-mesh-kit';
import fragmentShader from './shaders/creature.frag.glsl?raw';
import vertexShader from './shaders/creature.vert.glsl?raw';
import { centreLine } from './spine';

describe('buildCreatureGeometry v2: parts and fine detail', () => {
  heavyTest('roots every appendage on its segment outline', () => {
    for (const genome of [...gallery.values(), ...randoms.slice(0, 300)]) {
      const p = planOf(genome);
      const g = buildCreatureGeometry(p, 'high');
      const position = attr(g, 'position');
      const weight = attr(g, 'aWeight');
      const all = groups(g);
      p.appendages.forEach((a, k) => {
        const base = (all.get(`${PART_APPENDAGE}/${k + 1}`) ?? []).filter((i) => weight[i] === 0);
        expect(base.length).toBeGreaterThan(2);
        const cx = base.reduce((s, i) => s + (position[i * 3] as number), 0) / base.length;
        const cy = base.reduce((s, i) => s + (position[i * 3 + 1] as number), 0) / base.length;
        const s = p.segments[a.segment] as BodyPlan['segments'][number];
        const lx = s.rx * Math.cos(a.angle);
        const ly = a.side * s.ry * Math.sin(a.angle);
        const root = {
          x: s.x + lx * Math.cos(s.angle) - ly * Math.sin(s.angle),
          y: s.y + lx * Math.sin(s.angle) + ly * Math.cos(s.angle),
        };
        expect(Math.hypot(cx - root.x, cy - root.y), `part ${k}`).toBeLessThanOrEqual(0.02);
      });
    }
  });

  heavyTest('attaches every vertex of a part to its root, with weights from 0 at the base', () => {
    for (const genome of [...named, ...randoms.slice(0, 200)]) {
      const p = planOf(genome);
      for (const lod of LODS) {
        const g = buildCreatureGeometry(p, lod);
        const [weight, attach, part] = [attr(g, 'aWeight'), attr(g, 'aAttach'), attr(g, 'aPart')];
        const rootAttach = new Map<number, number>();
        const bad: string[] = [];
        for (let i = 0; i < part.length; i++) {
          const kind = partKind(part[i] as number);
          const id = partId(part[i] as number);
          if (id === 0) {
            if (weight[i] !== 0) bad.push(`kind ${kind} weighs ${weight[i]}`);
            continue;
          }
          const ofPart = [PART_APPENDAGE, PART_SETA, PART_SETULE, PART_MEMBRANE];
          if (!ofPart.includes(kind)) {
            bad.push(`kind ${kind} on part ${id}`);
          }
          const a = rootAttach.get(id);
          if (a === undefined) rootAttach.set(id, attach[i] as number);
          else if (attach[i] !== a) bad.push(`part ${id} hangs from two places`);
        }
        expect(bad.slice(0, 3), lod).toEqual([]);
      }
    }
  });

  it('draws joint beads, bulb tips and chela fingers on the parts that have them', () => {
    const p = planOf(specimen('37-'));
    const chelate = p.appendages.findIndex((a) => a.chela > 0);
    const bulbed = p.appendages.findIndex((a) => a.bulb > 0);
    expect(chelate).toBeGreaterThanOrEqual(0);
    expect(bulbed).toBeGreaterThanOrEqual(0);
    const count = (q: BodyPlan, id: number): number => {
      const part = attr(buildCreatureGeometry(q, 'high'), 'aPart');
      return Array.from(part).filter((v) => partKind(v) === PART_APPENDAGE && partId(v) === id)
        .length;
    };
    const without = (k: number, change: Partial<BodyPlan['appendages'][number]>): BodyPlan => ({
      ...p,
      appendages: p.appendages.map((a, i) => (i === k ? { ...a, ...change } : a)),
    });
    expect(count(p, chelate + 1)).toBeGreaterThan(
      count(without(chelate, { chela: 0 }), chelate + 1),
    );
    expect(count(p, bulbed + 1)).toBeGreaterThan(count(without(bulbed, { bulb: 0 }), bulbed + 1));
    // Beads swell the joints: the part spreads wider across its own path.
    const spread = (q: BodyPlan, id: number): number => {
      const g = buildCreatureGeometry(q, 'high');
      const [position, part] = [attr(g, 'position'), attr(g, 'aPart')];
      let z = 0;
      for (let i = 0; i < part.length; i++) {
        if (partKind(part[i] as number) === PART_APPENDAGE && partId(part[i] as number) === id) {
          z = Math.max(z, position[i * 3 + 2] as number);
        }
      }
      return z;
    };
    const jointed = p.appendages.findIndex((a) => a.joints > 1 && a.bulb === 0 && a.chela === 0);
    expect(jointed).toBeGreaterThanOrEqual(0);
    expect(spread(without(jointed, { beads: 1 }), jointed + 1)).toBeGreaterThan(
      spread(without(jointed, { beads: 0 }), jointed + 1),
    );
  });

  it('draws every bristle as a thin ribbon on high, and fewer on lower levels when they must', () => {
    // Bristled specimens under M6c T4: setae on legs, antennae and tails only, 12 a part at most.
    for (const prefix of BRISTLED) {
      const p = planOf(specimen(prefix));
      const bristles = p.appendages.reduce((n, a) => n + a.setae, 0);
      expect(bristles).toBeGreaterThan(10);
      const drawn = (lod: Lod): number => {
        const g = buildCreatureGeometry(p, lod);
        const part = attr(g, 'aPart');
        const seta = Array.from(part).filter((v) => partKind(v) === PART_SETA).length;
        return seta / meshDetail(p, lod).setaVertices;
      };
      expect(meshDetail(p, 'high').setae).toBe(1);
      expect(drawn('high'), prefix).toBe(bristles);
      expect(drawn('medium')).toBeLessThanOrEqual(bristles);
      expect(drawn('low')).toBeLessThanOrEqual(drawn('medium'));
    }
  });

  it('grows no bristle into the body, not even from a part in the eye of a coil (M6b T5)', () => {
    // Specimen 39's inner parts point into its coil, where either side of a bristle meets the body.
    for (const prefix of ['39-', '27-']) {
      const p = planOf(specimen(prefix));
      const g = buildCreatureGeometry(p, 'high');
      const [position, part] = [attr(g, 'position'), attr(g, 'aPart')];
      const per = meshDetail(p, 'high').setaVertices;
      let bristles = 0;
      for (let i = 0; i < part.length; i++) {
        if (partKind(part[i] as number) !== PART_SETA) continue;
        const tip = i + per - 1;
        const [x, y] = [position[tip * 3] as number, position[tip * 3 + 1] as number];
        expect(insideBody(p, x, y), `${prefix} bristle tip at ${x}, ${y}`).toBe(false);
        bristles++;
        i += per - 1;
      }
      expect(bristles, prefix).toBeGreaterThan(0);
    }
  });

  it("fans each part's bristles out, so their tips stand apart as separate strokes", () => {
    // None grows into the body either: a bristle that would, grows from the part's other side.
    // The bristled shrimp of the gallery before M6c T3 re-picked 27 for its strokes (the rules read
    // the old one's legs shorter): a body whose bristles all fan.
    const bristled = parseSpecimen('shrimp.hex', readFileSync(BRISTLES, 'utf8'));
    if (!bristled) throw new Error('bad bristle fixture');
    const p = planOf(bristled.genome);
    const g = buildCreatureGeometry(p, 'high');
    const [position, part] = [attr(g, 'position'), attr(g, 'aPart')];
    const per = meshDetail(p, 'high').setaVertices;
    // Each bristle is l0, r0, (l1, r1,) tip: its base is the middle of the first two.
    const bristles = new Map<number, { base: [number, number]; tip: [number, number] }[]>();
    for (let i = 0; i < part.length; i++) {
      if (partKind(part[i] as number) !== PART_SETA) continue;
      const xy = (k: number): [number, number] => [
        position[k * 3] as number,
        position[k * 3 + 1] as number,
      ];
      const [l0, r0, tip] = [xy(i), xy(i + 1), xy(i + per - 1)];
      const list = bristles.get(partId(part[i] as number)) ?? [];
      list.push({ base: [(l0[0] + r0[0]) / 2, (l0[1] + r0[1]) / 2], tip });
      bristles.set(partId(part[i] as number), list);
      i += per - 1;
    }
    const ratios: number[] = [];
    for (const list of bristles.values()) {
      // Neighbours on one side of the part (the way it runs, from its first bristle to its last).
      const [first, last] = [list[0], list[list.length - 1]] as [
        (typeof list)[0],
        (typeof list)[0],
      ];
      const [px, py] = [last.base[0] - first.base[0], last.base[1] - first.base[1]];
      for (const sign of [1, -1]) {
        const side = list.filter(
          (b) => sign * (px * (b.tip[1] - b.base[1]) - py * (b.tip[0] - b.base[0])) > 0,
        );
        for (let k = 1; k < side.length; k++) {
          const [a, b] = [side[k - 1], side[k]] as [(typeof list)[0], (typeof list)[0]];
          const base = Math.hypot(a.base[0] - b.base[0], a.base[1] - b.base[1]);
          ratios.push(Math.hypot(a.tip[0] - b.tip[0], a.tip[1] - b.tip[1]) / base);
        }
      }
    }
    // At most 12 bristles a part (M6c T4), half as many as before.
    expect(ratios.length).toBeGreaterThan(10);
    const tips = [...bristles.values()].flat().map((b) => b.tip);
    const inBody = tips.filter(([x, y]) =>
      p.segments.some((seg) => {
        const [dx, dy] = [x - seg.x, y - seg.y];
        const u = (dx * Math.cos(seg.angle) + dy * Math.sin(seg.angle)) / seg.rx;
        const v = (-dx * Math.sin(seg.angle) + dy * Math.cos(seg.angle)) / seg.ry;
        return u * u + v * v <= 1;
      }),
    );
    expect(inBody.length).toBeLessThanOrEqual(tips.length * 0.1);
    // On both sides of a curved part: none converge (they would cross and merge into a sheet).
    ratios.sort((a, b) => a - b);
    expect(ratios[Math.floor(ratios.length * 0.1)]).toBeGreaterThanOrEqual(1.5);
    expect(ratios[ratios.length >> 1]).toBeGreaterThanOrEqual(2);
  });

  it('draws plumose bristles on the 5-vertex rungs: setule pairs of their own kind, within the bounds (look pass 5)', () => {
    for (const prefix of BRISTLED) {
      const p = planOf(specimen(prefix));
      const g = buildCreatureGeometry(p, 'high');
      const [position, part] = [attr(g, 'position'), attr(g, 'aPart')];
      const setule = Array.from(part).filter((v) => partKind(v) === PART_SETULE);
      const seta = Array.from(part).filter((v) => partKind(v) === PART_SETA).length;
      const bristles = seta / meshDetail(p, 'high').setaVertices;
      expect(meshDetail(p, 'high').setaVertices).toBe(5);
      // Three pairs of 3-vertex setules per bristle, but for any a bristle at the bounds drops.
      expect(setule.length, prefix).toBeGreaterThan(bristles * 3 * 2 * 3 * 0.8);
      expect(setule.length).toBeLessThanOrEqual(bristles * 3 * 2 * 3);
      // Each belongs to its bristle's part.
      const ids = new Set(
        Array.from(part)
          .filter((v) => partKind(v) === PART_SETA)
          .map(partId),
      );
      for (const v of setule) expect(ids.has(partId(v))).toBe(true);
      for (let i = 0; i < part.length; i++) {
        if (partKind(part[i] as number) !== PART_SETULE) continue;
        const r = Math.hypot(position[i * 3] as number, position[i * 3 + 1] as number);
        expect(r).toBeLessThanOrEqual(RULES.develop.caps.bounds + 1e-6);
      }
      g.dispose();
    }
    // A 3-vertex rung draws plain bristles.
    const low = planOf(specimen('27-'));
    const g = buildCreatureGeometry(low, 'low');
    expect(Array.from(attr(g, 'aPart')).some((v) => partKind(v) === PART_SETULE)).toBe(false);
  });

  it('draws the plan membranes as double-sided sheets of their full area, with a vein UV', () => {
    const p = planOf(specimen('31-'));
    expect(p.membranes.length).toBeGreaterThan(4);
    const want = p.membranes.reduce((s, m) => s + polygonArea(m.points), 0);
    for (const lod of LODS) {
      const g = buildCreatureGeometry(p, lod);
      const [position, part, uv] = [attr(g, 'position'), attr(g, 'aPart'), attr(g, 'uv')];
      const index = indexOf(g);
      let up = 0;
      let down = 0;
      for (let t = 0; t < index.length; t += 3) {
        const [a, b, c] = [index[t], index[t + 1], index[t + 2]] as [number, number, number];
        if (partKind(part[a] as number) !== PART_MEMBRANE) continue;
        const area =
          ((position[b * 3] as number) - (position[a * 3] as number)) *
            ((position[c * 3 + 1] as number) - (position[a * 3 + 1] as number)) -
          ((position[c * 3] as number) - (position[a * 3] as number)) *
            ((position[b * 3 + 1] as number) - (position[a * 3 + 1] as number));
        if (area > 0) up += area / 2;
        else down -= area / 2;
      }
      expect(up, lod).toBeCloseTo(want, 6);
      expect(down, lod).toBeCloseTo(want, 6);
      // The vein UV runs 0..1 across and out from the root.
      let [uMax, vMax] = [0, 0];
      for (let i = 0; i < part.length; i++) {
        if (partKind(part[i] as number) !== PART_MEMBRANE) continue;
        uMax = Math.max(uMax, uv[i * 2] as number);
        vMax = Math.max(vMax, uv[i * 2 + 1] as number);
      }
      expect([uMax, vMax]).toEqual([1, 1]);
    }
  });

  it('draws a pair of lens eyes where the plan puts them', () => {
    const p = planOf(specimen('21-'));
    expect(p.eyes.count).toBe(2);
    const g = buildCreatureGeometry(p, 'high');
    const position = attr(g, 'position');
    const eye = groups(g).get(`${PART_EYE}/0`) ?? [];
    const e = p.eyes;
    for (const side of [1, -1]) {
      const on = eye.filter(
        (i) =>
          Math.hypot(
            (position[i * 3] as number) - e.x,
            (position[i * 3 + 1] as number) - side * e.y,
          ) <=
          e.size * 1.001,
      );
      expect(on.length).toBeGreaterThan(10);
      const far = Math.max(
        ...on.map((i) =>
          Math.hypot(
            (position[i * 3] as number) - e.x,
            (position[i * 3 + 1] as number) - side * e.y,
          ),
        ),
      );
      expect(far).toBeCloseTo(e.size, 3);
    }
  });
});

describe('buildCreatureGeometry: eyes set into the head (look pass 5)', () => {
  it('draws no stalk for an eye whose stalk the head hides, and keeps a long stalk', () => {
    const set = planOf(specimen('38-'));
    expect(set.eyes.count).toBe(2);
    expect(set.eyes.stalk).toBeLessThanOrEqual(0.05);
    const head = set.segments[0] as PlanSegment;
    // Most of the eye lies inside the head's outline.
    const u = (set.eyes.x - head.x) / head.rx;
    const v = (set.eyes.y - head.y) / head.ry;
    expect(u * u + v * v).toBeLessThan(1);
    const kinds = new Set(Array.from(attr(buildCreatureGeometry(set, 'high'), 'aPart'), partKind));
    expect(kinds.has(PART_EYE)).toBe(true);
    expect(kinds.has(PART_STALK)).toBe(false);
    const stalked = planOf(specimen('25-'));
    expect(stalked.eyes.stalk).toBeGreaterThan(0.3);
    const parts = Array.from(attr(buildCreatureGeometry(stalked, 'high'), 'aPart'), partKind);
    expect(parts.includes(PART_STALK)).toBe(true);
  });
});

describe('CreatureCache', () => {
  const creature = (i: number) => buildCreature(genesisGenome(seedFromString(`cache-${i}`)));

  it('builds one asset per genome hash and level of detail', () => {
    const cache = new CreatureCache();
    const c = creature(0);
    const a = cache.acquire(c, 'high');
    expect(cache.acquire(c, 'high')).toBe(a);
    expect(cache.live()).toBe(1);
    expect(cache.acquire(c, 'medium')).not.toBe(a);
    expect(cache.acquire(c, 'low')).not.toBe(a);
    expect(cache.live()).toBe(3);
    expect(a.vertices).toBe(estimateVertices(c.plan, 'high', anatomyOf(c.plan, c.traits, c.hash)));
  });

  it('disposes the geometry and material when the last holder releases', () => {
    const cache = new CreatureCache();
    const c = creature(1);
    const a = cache.acquire(c, 'high');
    cache.acquire(c, 'high');
    const geometry = vi.spyOn(a.geometry, 'dispose');
    const material = vi.spyOn(a.material, 'dispose');
    cache.release(a);
    expect(geometry).not.toHaveBeenCalled();
    expect(cache.live()).toBe(1);
    cache.release(a);
    expect(geometry).toHaveBeenCalledTimes(1);
    expect(material).toHaveBeenCalledTimes(1);
    expect(cache.live()).toBe(0);
    cache.release(a);
    expect(geometry).toHaveBeenCalledTimes(1);
  });

  it('ends with nothing live after 200 acquire and release cycles over 50 genomes', () => {
    const cache = new CreatureCache();
    const creatures = Array.from({ length: 50 }, (_, i) => creature(i));
    const held: ReturnType<CreatureCache['acquire']>[] = [];
    for (let i = 0; i < 200; i++) {
      held.push(
        cache.acquire(creatures[(i * 7) % 50] as ReturnType<typeof creature>, LODS[i % 3] as Lod),
      );
      if (i % 2) cache.release(held.shift() as (typeof held)[number]);
    }
    expect(cache.live()).toBeGreaterThan(0);
    for (const asset of held) cache.release(asset);
    expect(cache.live()).toBe(0);
  });
});

describe('lodFor', () => {
  it('draws the preset level, drops to low below 12 px and returns above 16 px', () => {
    expect(LOW_BELOW).toBe(12);
    expect(FULL_ABOVE).toBe(16);
    for (const preset of LODS) {
      expect(lodFor(40, preset)).toBe(preset);
      expect(lodFor(11.9, preset, preset)).toBe('low');
      expect(lodFor(16.1, preset, 'low')).toBe(preset);
      expect(lodFor(14, preset, 'low')).toBe('low');
      expect(lodFor(14, preset, preset)).toBe(preset);
      expect(lodFor(14, preset)).toBe(preset);
    }
    // A preset change takes effect at once, whatever the size.
    expect(lodFor(14, 'medium', 'high')).toBe('medium');
  });
});

describe('buildCreatureGeometry: segment walls (look pass 3, M6 T28)', () => {
  it('puts one wall between each pair of overlapping segments, in order along the body', () => {
    for (const prefix of ['26-', '27-', '28-', '30-', '07-']) {
      const p = planOf(specimen(prefix));
      const line = centreLine(p.segments);
      const walls = wallsAlong(p, line);
      expect(walls, prefix).toHaveLength(p.segments.length - 1);
      for (let k = 0; k < walls.length; k++) {
        expect(walls[k] as number).toBeGreaterThan(k > 0 ? (walls[k - 1] as number) : 0);
        expect(walls[k] as number).toBeLessThan(line.length);
      }
    }
  });

  it('gives a lone cell and a radial bell no walls', () => {
    for (const prefix of ['01-', '21-', '24-', '36-']) {
      const p = planOf(specimen(prefix));
      expect(p.segments.length === 1 || p.form.radial === 1).toBe(true);
      expect(wallsAlong(p, centreLine(p.segments)), prefix).toEqual([]);
    }
  });

  heavyTest('marks only the body: whole numbers between its ends, none on any part', () => {
    for (const genome of [...gallery.values(), ...randoms.slice(0, 200)]) {
      const p = planOf(genome);
      const walls = wallsAlong(p, centreLine(p.segments)).length;
      for (const lod of LODS) {
        const g = buildCreatureGeometry(p, lod, anatomyFor(genome));
        const [wall, part] = [attr(g, 'aWall'), attr(g, 'aPart')];
        expect(wall.length).toBe(part.length);
        let lo = Number.POSITIVE_INFINITY;
        let hi = Number.NEGATIVE_INFINITY;
        for (let i = 0; i < part.length; i++) {
          const kind = partKind(part[i] as number);
          const w = wall[i] as number;
          if (kind !== PART_BODY && kind !== PART_PLATE && kind !== PART_MOUTH) {
            expect(w).toBe(NO_WALL);
            continue;
          }
          lo = Math.min(lo, w);
          hi = Math.max(hi, w);
        }
        // The front tip sits half a step before the first wall and the rear half a step past the
        // last, so the shader's whole numbers fall only on walls.
        expect(lo).toBeCloseTo(NO_WALL, 9);
        expect(hi).toBeCloseTo(walls + NO_WALL, 9);
        g.dispose();
      }
    }
  });

  it('declares the wall coordinate in the vertex shader and draws it in the fragment shader', () => {
    expect(vertexShader).toMatch(/attribute float aWall;/);
    expect(vertexShader).toMatch(/vWall = aWall;/);
    expect(fragmentShader).toMatch(/varying float vWall;/);
    // Every wall draws at full width (look pass 4): the mask below the first wall only keeps the
    // front span (from 0.5) clear, and never cuts the first wall's front half.
    expect(fragmentShader).not.toMatch(/step\(1\.0, vWall\)/);
    expect(fragmentShader).toMatch(/step\(0\.75, vWall\)/);
  });

  it('draws a wall where the owner skips a buried segment, between the two that meet (look pass 4)', () => {
    const p = planOf(specimen('27-'));
    // Segment 1 is a small copy of segment 2 inside it, so it owns no point of the line: the
    // owner goes from 0 straight to 2, where those two overlap.
    const segments: PlanSegment[] = [
      { x: 0, y: 0, rx: 1, ry: 0.5, angle: 0 },
      { x: -1.6, y: 0, rx: 0.5, ry: 0.25, angle: 0 },
      { x: -1.6, y: 0, rx: 1, ry: 0.5, angle: 0 },
    ];
    const n = 361;
    const line = { x: [] as number[], y: [] as number[], at: [] as number[], length: 3.6 };
    for (let k = 0; k < n; k++) {
      line.x.push(1 - (3.6 * k) / (n - 1));
      line.y.push(0);
      line.at.push((3.6 * k) / (n - 1));
    }
    const walls = wallsAlong({ ...p, segments }, line);
    expect(walls).toHaveLength(1);
    // Where segments 0 and 2 meet, at x = −0.8.
    expect(walls[0] as number).toBeCloseTo(1.8, 1);
  });
});

describe('pass 1 glass without the haze and the glow (M6b T3, ADR 0034)', () => {
  /** The shader's code for one organ kind: from its `kind == PART_…` branch to the next branch. */
  const branch = (name: string): string => {
    const from = fragmentShader.indexOf(`kind == ${name})`);
    expect(from, name).toBeGreaterThan(0);
    const next = fragmentShader.indexOf('} else', from);
    return fragmentShader.slice(from, next);
  };

  it('draws no organ glows, no scattered band inside the rim and no denser glows on small bodies', () => {
    for (const name of ['HALO', 'SCATTER', 'uOrgan2', 'HALO_SMALL', 'addHalo']) {
      expect(fragmentShader, name).not.toContain(name);
    }
    const g = buildCreatureGeometry(planOf(specimen('07-')), 'high', anatomyFor(specimen('07-')));
    const [uv, part, position, normal] = ['uv', 'aPart', 'position', 'normal'].map((n) =>
      attr(g, n),
    );
    // Every organ vertex belongs to a ball: no flat glow disc lies under the organs.
    let flat = 0;
    for (let i = 0; i < (part as Float32Array).length; i++) {
      const k = partKind(part?.[i] as number);
      if (k !== PART_CHAMBER && k !== PART_DROPLET && k !== PART_HEART) continue;
      const facing = position?.[i * 3 + 2] === 0 && normal?.[i * 3 + 2] === 1;
      if (facing && (uv?.[i * 2 + 1] as number) % 1 === 0) flat++;
    }
    expect(flat).toBe(0);
    g.dispose();
  });

  it("gives chambers pass 1's glassy look: a brighter wall and a clearer centre, not a centre glow", () => {
    const chamber = branch('PART_CHAMBER');
    // Colour and opacity both rise toward the edge (fres), and the centre is not faded in from z.
    expect(chamber).toMatch(/0\.6 \* fres/);
    expect(chamber).toMatch(/alpha = 0\.55 \+ 0\.25 \* z \+ 0\.2 \* fres/);
    expect(chamber).not.toMatch(/smoothstep\(0\.0, 0\.45, z\)/);
    // Organs take the gene hue or, on an accent organ, the complementary accent, nothing else.
    expect(fragmentShader).toMatch(/uniform vec3 uAccent;/);
  });

  it('keeps segment walls faint and joint points dim against the rim colour', () => {
    const constant = (name: string): number =>
      Number(fragmentShader.match(new RegExp(`const float ${name} = ([0-9.]+);`))?.[1]);
    // Walls at most 0.35 and wet joint points at most half of the rim colour's luminance, which the
    // drawn rim (its term is at least 1 at the edge) always reaches.
    expect(constant('WALL')).toBeLessThanOrEqual(0.35);
    expect(fragmentShader).toMatch(/col \+= uRim \* wall \* WALL;/);
    expect(constant('JOINT_SHINE')).toBeLessThanOrEqual(0.5);
    expect(fragmentShader).toMatch(/gloss \* JOINT_SHINE \* dot\(uRim, LUMA\)/);
    expect(constant('RIM')).toBeGreaterThanOrEqual(1);
  });
});

describe('no white clipping (M6b T4, ADR 0034)', () => {
  const constant = (name: string): number =>
    Number(fragmentShader.match(new RegExp(`const float ${name} = ([0-9.]+);`))?.[1]);

  it('caps every fine part short of the bloom-and-shoulder white, setules below setae', () => {
    // Legs, pearls and membranes; setae (often thinner than a pixel) a little brighter; their
    // setules fainter than they are. Stacked, none fills an area brighter than its cap.
    expect(constant('PART_LUMA')).toBeLessThanOrEqual(0.5);
    expect(constant('SETA_LUMA')).toBeLessThanOrEqual(0.75);
    expect(constant('SETULE_LUMA')).toBeLessThan(constant('SETA_LUMA'));
    expect(fragmentShader).toMatch(
      /kind == 1 \|\| kind == 5 \|\| kind == 6 \|\| kind == PART_SETULE\) \{\s*float cap = kind == 5 \? SETA_LUMA : kind == PART_SETULE \? SETULE_LUMA : PART_LUMA;\s*col \*= min\(1\.0, cap \/ max\(dot\(col, LUMA\), 1e-4\)\);/,
    );
    // The cap comes after every light a part takes (its rim, gloss, refraction and caustics).
    expect(fragmentShader.indexOf('float cap =')).toBeGreaterThan(
      fragmentShader.indexOf('causticAt(vWorld, uSunTime)'),
    );
    // A pearl keeps its hot point over the cap.
    expect(fragmentShader).toMatch(/col \+= vec3\(PEARL_HOT\) \* pearlHot;/);
  });
});

describe('thin legs keep their paddles (M6b T7)', () => {
  it('swells a paddle tip into a blade, and tapers every tip to a point (M6c T4)', () => {
    const paddle = RULES.stats.paddleTip;
    for (const taper of [0.6, 0.75, 0.9]) {
      // A thin leg (its drawn radius on a slim trunk) still carries a blade wider than its base.
      expect(partRadius(0.03, taper, paddle, 0.75)).toBeGreaterThan(0.03 * 2);
      expect(partRadius(0.03, taper, paddle, 0)).toBeCloseTo(0.03, 12);
      // Every tip, a paddle's too, ends at most 40% of its root wide (ADR 0041).
      for (const tip of [0, 0.375, paddle, 0.9, 1]) {
        expect(partRadius(0.03, taper, tip, 1)).toBeCloseTo(0.03 * (1 - taper), 12);
        expect(partRadius(0.03, taper, tip, 1)).toBeLessThanOrEqual(0.03 * 0.4 + 1e-12);
      }
    }
  });
});
