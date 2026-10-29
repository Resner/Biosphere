import { readdirSync, readFileSync } from 'node:fs';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it, vi } from 'vitest';
import { ARCHETYPES, buildBytes } from '../../tests/archetypes';
import { decodeGenome, type Genome, genomeHash } from '../genome/codec';
import { type BodyPlan, develop, type PlanSegment, polygonArea } from '../genome/develop';
import { express } from '../genome/express';
import { genesisGenome } from '../genome/genesis';
import { GENOME_BYTES, LOCI, MODULE_EXT, MODULE_PARAMS, SHAPE_LOCI } from '../genome/karyotype';
import { starterGenome } from '../genome/starter';
import { buildCreature } from '../genome/stats';
import { parseSpecimen } from '../lab/gallery';
import { createRng, seedFromString } from '../sim/prng';
import { RULES } from '../sim/rules';
import { type Anatomy, anatomyOf } from './anatomy';
import { CreatureCache, FULL_ABOVE, LOW_BELOW, lodFor } from './creature-cache';
import {
  buildCreatureGeometry,
  countVertices,
  estimateVertices,
  GLINT_GAP,
  glintSpots,
  LOD_BUDGET,
  LOD_LADDER,
  type Lod,
  type MeshDetail,
  MOTION_BELL,
  MOTION_RIGID,
  meshDetail,
  NO_WALL,
  ORGAN_KINDS,
  ORGAN_RESERVE,
  PART_APPENDAGE,
  PART_BODY,
  PART_CHAMBER,
  PART_DROPLET,
  PART_EYE,
  PART_GLINT,
  PART_GUT,
  PART_HEART,
  PART_KINDS,
  PART_MEMBRANE,
  PART_MOUTH,
  PART_PIGMENT,
  PART_PLATE,
  PART_SETA,
  PART_SHELL,
  partId,
  partKind,
  partPoint,
  wallsAlong,
} from './creature-mesh';
import fragmentShader from './shaders/creature.frag.glsl?raw';
import vertexShader from './shaders/creature.vert.glsl?raw';
import { centreLine } from './spine';
import { glintsFor, MAX_GLINTS } from './surface';

const D = RULES.develop;
const LODS: Lod[] = ['high', 'medium', 'low'];
const rng = createRng(seedFromString('creature-mesh-v2-tests'), 'bytes');
const plan = (g: Genome): BodyPlan => develop(express(g));

const MODULE_IDS = LOCI.filter((l) => l.kind === 'module').map((l) => l.id);
const allModules = (value: number) => {
  const params = Object.fromEntries([...MODULE_PARAMS, ...MODULE_EXT].map((p) => [p, value]));
  return Object.fromEntries(MODULE_IDS.map((id) => [id, params]));
};
const allShape = (value: number) => Object.fromEntries(SHAPE_LOCI.map((id) => [id, value]));

const randomGenome = (): Genome =>
  decodeGenome(Uint8Array.from({ length: GENOME_BYTES }, () => rng.nextU32() & 0xff));

/** The gallery specimens (M6 T5, T9), by file name. */
const GALLERY_DIR = new URL('../../tests/fixtures/gallery/', import.meta.url);
const gallery = new Map(
  readdirSync(GALLERY_DIR)
    .filter((f) => f.endsWith('.hex'))
    .sort()
    .map((f) => {
      const s = parseSpecimen(f, readFileSync(new URL(f, GALLERY_DIR), 'utf8'));
      if (!s) throw new Error(`bad specimen ${f}`);
      return [f, s.genome] as const;
    }),
);
const specimen = (prefix: string): Genome => {
  for (const [f, g] of gallery) if (f.startsWith(prefix)) return g;
  throw new Error(`no specimen ${prefix}`);
};

const extremes: Genome[] = [
  new Uint8Array(GENOME_BYTES),
  new Uint8Array(GENOME_BYTES).fill(0xff),
  buildBytes(allModules(0)),
  buildBytes(allModules(255)),
  buildBytes(allModules(255), { segDrive1: 255, segDrive2: 255 }),
  buildBytes(allModules(255), { segDrive1: 255, segDrive2: 255, ...allShape(255) }),
  buildBytes(allModules(255), { segDrive1: 255, segDrive2: 255, ...allShape(128) }),
  buildBytes(allModules(200), { segDrive1: 255, segDrive2: 255, symmetry: 255, drape: 255 }),
].map(decodeGenome);

const named: Genome[] = [
  starterGenome(),
  ...Object.values(ARCHETYPES),
  ...extremes,
  ...gallery.values(),
  ...Array.from({ length: 20 }, (_, i) => genesisGenome(seedFromString(`mesh-genesis-${i}`))),
];

const randoms = Array.from({ length: 1_500 }, randomGenome);
// Development is the slow part of these tests, so every genome is developed once.
const plans = new Map<Genome, BodyPlan>();
const planOf = (g: Genome): BodyPlan => {
  let p = plans.get(g);
  if (!p) {
    p = plan(g);
    plans.set(g, p);
  }
  return p;
};

// The inner anatomy (M6 T12) of each genome, built once like its plan.
const anatomies = new Map<Genome, Anatomy>();
const anatomyFor = (g: Genome): Anatomy => {
  let a = anatomies.get(g);
  if (!a) {
    a = anatomyOf(planOf(g), express(g), genomeHash(g));
    anatomies.set(g, a);
  }
  return a;
};

type Geometry = ReturnType<typeof buildCreatureGeometry>;
const attr = (g: Geometry, name: string): Float32Array =>
  g.getAttribute(name).array as Float32Array;
const indexOf = (g: Geometry) => g.getIndex()?.array as Uint32Array | Uint16Array;

/** Vertex numbers grouped by `aPart`'s kind and appendage id. */
function groups(g: Geometry): Map<string, number[]> {
  const part = attr(g, 'aPart');
  const out = new Map<string, number[]>();
  for (let i = 0; i < part.length; i++) {
    const key = `${partKind(part[i] as number)}/${partId(part[i] as number)}`;
    const list = out.get(key) ?? [];
    list.push(i);
    out.set(key, list);
  }
  return out;
}

describe('buildCreatureGeometry v2: budgets and validity', () => {
  it('keeps every body within its level-of-detail budget, with finite attributes and valid indices', () => {
    const NAMES = ['position', 'normal', 'uv', 'aSpine', 'aAttach', 'aWeight', 'aPart'];
    const limit = D.caps.bounds * 1.05;
    let built = 0;
    for (const genome of [...named, ...randoms]) {
      const p = planOf(genome);
      const inner = anatomyFor(genome);
      for (const lod of LODS) {
        const geometry = buildCreatureGeometry(p, lod, inner);
        const position = attr(geometry, 'position');
        const count = position.length / 3;
        expect(count).toBe(estimateVertices(p, lod, inner));
        expect(count).toBeLessThanOrEqual(LOD_BUDGET[lod]);
        let reach = 0;
        let bad = 0;
        for (const name of NAMES) {
          const a = attr(geometry, name);
          if (a.length !== count * geometry.getAttribute(name).itemSize) bad++;
          for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) bad++;
        }
        for (const name of ['aSpine', 'aAttach', 'aWeight']) {
          for (const v of attr(geometry, name)) if (v < 0 || v > 1) bad++;
        }
        for (let i = 0; i < position.length; i += 3) {
          const x = position[i] as number;
          const y = position[i + 1] as number;
          const z = position[i + 2] as number;
          reach = Math.max(reach, Math.sqrt(x * x + y * y + z * z));
        }
        const index = indexOf(geometry);
        if (index.length % 3 !== 0) bad++;
        for (let i = 0; i < index.length; i++) if ((index[i] as number) >= count) bad++;
        expect(bad).toBe(0);
        expect(reach).toBeLessThanOrEqual(limit);
        geometry.dispose();
        built++;
      }
    }
    expect(built).toBe((named.length + randoms.length) * 3);
  }, 120_000);

  it('never drops a part: every appendage of the plan is drawn on every level of detail', () => {
    for (const genome of [...named, ...randoms.slice(0, 300)]) {
      const p = planOf(genome);
      for (const lod of LODS) {
        const part = attr(buildCreatureGeometry(p, lod), 'aPart');
        const ids = new Set<number>();
        for (const v of part) if (partKind(v) === PART_APPENDAGE) ids.add(partId(v));
        expect(ids.size, lod).toBe(p.appendages.length);
        if (p.appendages.length > 0) {
          expect(Math.min(...ids)).toBe(1);
          expect(Math.max(...ids)).toBe(p.appendages.length);
        }
      }
    }
  }, 60_000);

  it('picks the richest rung of its ladder that fits, and the ladders get coarser', () => {
    for (const lod of LODS) {
      const ladder = LOD_LADDER[lod];
      expect(ladder.length).toBeGreaterThan(1);
      for (let k = 1; k < ladder.length; k++) {
        const [a, b] = [ladder[k - 1], ladder[k]] as [(typeof ladder)[0], (typeof ladder)[0]];
        for (const key of Object.keys(a) as (keyof typeof a)[]) {
          expect(b[key], `${lod} rung ${k} ${key}`).toBeLessThanOrEqual(a[key]);
        }
      }
    }
    // A simple cell takes the top rung everywhere, and costs less at each lower level.
    const cell = planOf(starterGenome());
    for (const lod of LODS) expect(meshDetail(cell, lod)).toEqual(LOD_LADDER[lod][0]);
    const counts = LODS.map((lod) => estimateVertices(cell, lod));
    expect(counts[0]).toBeGreaterThan(counts[1] as number);
    expect(counts[1]).toBeGreaterThan(counts[2] as number);
    // The costliest bodies step down their ladder rather than break the budget.
    for (const lod of LODS) {
      const big = [...extremes, ...randoms.slice(0, 300)]
        .map(planOf)
        .find((p) => countVertices(p, LOD_LADDER[lod][0] as MeshDetail) > LOD_BUDGET[lod]);
      if (!big) throw new Error(`no body overruns the top ${lod} rung`);
      expect(meshDetail(big, lod)).not.toEqual(LOD_LADDER[lod][0]);
      expect(estimateVertices(big, lod)).toBeLessThanOrEqual(LOD_BUDGET[lod]);
      expect(estimateVertices(big, lod)).toBe(countVertices(big, meshDetail(big, lod)));
    }
  });

  it('has the budgets of ADR 0025: 12,000 high, 6,000 medium, 1,500 low', () => {
    expect(LOD_BUDGET).toEqual({ high: 12_000, medium: 6_000, low: 1_500 });
  });

  it('is deterministic', () => {
    const hashOf = (g: Genome): string => {
      const geometry = buildCreatureGeometry(planOf(g), 'high');
      return bytesToHex(sha256(new Uint8Array(attr(geometry, 'position').buffer)));
    };
    for (const genome of named) expect(hashOf(genome)).toBe(hashOf(genome));
  });
});

describe('buildCreatureGeometry v2: the body', () => {
  it('makes the starter body as wide as the M1 cell', () => {
    const body: BodyPlan = { ...plan(starterGenome()), appendages: [], plates: [], membranes: [] };
    expect(body.segments).toHaveLength(1);
    const position = attr(buildCreatureGeometry(body, 'high'), 'position');
    let [maxX, maxY, maxZ] = [0, 0, 0];
    for (let i = 0; i < position.length; i += 3) {
      maxX = Math.max(maxX, Math.abs(position[i] as number));
      maxY = Math.max(maxY, Math.abs(position[i + 1] as number));
      maxZ = Math.max(maxZ, Math.abs(position[i + 2] as number));
    }
    expect(maxY).toBeCloseTo(1, 6);
    expect(maxX).toBeCloseTo(body.segments[0]?.rx as number, 6);
    expect(maxZ).toBeLessThanOrEqual(1);
  });

  it('lofts one body along the curved spine, over the plan outline and every segment', () => {
    const curved = [...gallery.values(), ...randoms.slice(0, 200)].map(planOf);
    expect(curved.some((p) => p.form.turn > 2)).toBe(true);
    for (const p of curved) {
      const g = buildCreatureGeometry(p, 'high');
      const position = attr(g, 'position');
      const part = attr(g, 'aPart');
      const body: number[] = [];
      for (let i = 0; i < part.length; i++) {
        const k = partKind(part[i] as number);
        if (k === PART_BODY || k === PART_PLATE || k === PART_MOUTH) body.push(i);
      }
      // The loft's upward faces cover the plan outline (the union of the segment ellipses) and
      // every segment's centre; only a coil, which overlaps itself, covers parts of it twice.
      const isBody = (i: number): boolean => {
        const k = partKind(part[i] as number);
        return k === PART_BODY || k === PART_PLATE || k === PART_MOUTH;
      };
      const index = indexOf(g);
      const up: number[][] = [];
      let covered = 0;
      for (let t = 0; t < index.length; t += 3) {
        const [a, b, c] = [index[t], index[t + 1], index[t + 2]] as [number, number, number];
        if (!isBody(a)) continue;
        const tri = [a, b, c].flatMap((i) => [
          position[i * 3] as number,
          position[i * 3 + 1] as number,
        ]);
        const [ax, ay, bx, by, cx, cy] = tri as [number, number, number, number, number, number];
        const area = ((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2;
        if (area > 0) {
          covered += area;
          up.push(tri);
        }
      }
      const inEllipse = (x: number, y: number) =>
        p.segments.some((s) => {
          const [dx, dy] = [x - s.x, y - s.y];
          const u = (dx * Math.cos(s.angle) + dy * Math.sin(s.angle)) / s.rx;
          const v = (-dx * Math.sin(s.angle) + dy * Math.cos(s.angle)) / s.ry;
          return u * u + v * v <= 1;
        });
      const step = 0.02;
      let outline = 0;
      for (let x = -2.5; x < 2.5; x += step) {
        for (let y = -2.5; y < 2.5; y += step) if (inEllipse(x + step / 2, y + step / 2)) outline++;
      }
      outline *= step * step;
      expect(covered).toBeGreaterThanOrEqual(outline * 0.9);
      if (p.form.turn < Math.PI) expect(covered).toBeLessThanOrEqual(outline * 1.1);
      const inTriangle = (x: number, y: number, t: number[]): boolean => {
        const [ax, ay, bx, by, cx, cy] = t as [number, number, number, number, number, number];
        const s1 = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
        const s2 = (cx - bx) * (y - by) - (cy - by) * (x - bx);
        const s3 = (ax - cx) * (y - cy) - (ay - cy) * (x - cx);
        return s1 >= -1e-6 && s2 >= -1e-6 && s3 >= -1e-6;
      };
      p.segments.forEach((s, k) => {
        expect(
          up.some((t) => inTriangle(s.x, s.y, t)),
          `segment ${k} of ${p.segments.length}, turn ${p.form.turn}`,
        ).toBe(true);
      });
      // No body vertex leaves the union of the segment ellipses (plates only lift it upward).
      for (const i of body) {
        const [x, y] = [position[i * 3] as number, position[i * 3 + 1] as number];
        const inside = p.segments.some((s) => {
          const [dx, dy] = [x - s.x, y - s.y];
          const u = (dx * Math.cos(s.angle) + dy * Math.sin(s.angle)) / s.rx;
          const v = (-dx * Math.sin(s.angle) + dy * Math.cos(s.angle)) / s.ry;
          // Float32 positions: a tip on the outline of a small segment rounds a hair outside.
          return u * u + v * v <= 1 + 1e-4;
        });
        expect(inside, `${x}, ${y}`).toBe(true);
      }
    }
  }, 60_000);

  it('winds every closed surface outward, on both sides of the body', () => {
    for (const genome of [...named, ...randoms.slice(0, 100)]) {
      const p = planOf(genome);
      const g = buildCreatureGeometry(p, 'high');
      const position = attr(g, 'position');
      const normal = attr(g, 'normal');
      // Plates and the mouth are marked body vertices: one closed surface with the body.
      const merged = new Map<string, number[]>();
      for (const [key, list] of groups(g)) {
        const kind = Number(key.split('/')[0]);
        const id = key.split('/')[1];
        const at = kind === PART_PLATE || kind === PART_MOUTH ? `${PART_BODY}/${id}` : key;
        merged.set(at, [...(merged.get(at) ?? []), ...list]);
      }
      for (const [key, list] of merged) {
        const kind = Number(key.split('/')[0]);
        if (kind === PART_SETA || kind === PART_MEMBRANE) continue;
        // The topmost vertex of a closed surface faces up, and its leftmost and rightmost face out.
        const top = list.reduce((a, b) =>
          (position[b * 3 + 2] as number) > (position[a * 3 + 2] as number) ? b : a,
        );
        expect(normal[top * 3 + 2], key).toBeGreaterThan(0);
        if (kind === PART_BODY) {
          const left = list.reduce((a, b) =>
            (position[b * 3 + 1] as number) > (position[a * 3 + 1] as number) ? b : a,
          );
          const right = list.reduce((a, b) =>
            (position[b * 3 + 1] as number) < (position[a * 3 + 1] as number) ? b : a,
          );
          expect(normal[left * 3 + 1], key).toBeGreaterThan(0);
          expect(normal[right * 3 + 1], key).toBeLessThan(0);
        }
      }
    }
  });

  it('adds a thin outer shell over the fused segments, on the plan carapace', () => {
    const p = planOf(specimen('30-'));
    expect(p.carapace.count).toBeGreaterThan(1);
    const g = buildCreatureGeometry(p, 'high');
    const position = attr(g, 'position');
    const shell = groups(g).get(`${PART_SHELL}/0`) ?? [];
    expect(shell.length).toBeGreaterThan(20);
    const c = p.carapace;
    let far = 0;
    for (const i of shell) {
      const [dx, dy] = [(position[i * 3] as number) - c.x, (position[i * 3 + 1] as number) - c.y];
      const u = (dx * Math.cos(c.angle) + dy * Math.sin(c.angle)) / c.rx;
      const v = (-dx * Math.sin(c.angle) + dy * Math.cos(c.angle)) / c.ry;
      far = Math.max(far, Math.hypot(u, v));
    }
    expect(far).toBeLessThanOrEqual(1 + 1e-6);
    expect(far).toBeGreaterThan(0.99);
    expect(
      groups(buildCreatureGeometry(planOf(starterGenome()), 'high')).has(`${PART_SHELL}/0`),
    ).toBe(false);
  });

  it('marks body, appendage, plate and mouth vertices, each appendage by its own id', () => {
    const plated = decodeGenome(buildBytes({}, { plating1: 128, plating2: 128 }));
    const p = planOf(plated);
    expect(p.plates.length).toBeGreaterThan(0);
    const part = attr(buildCreatureGeometry(p, 'high'), 'aPart');
    const kinds = new Set(Array.from(part, partKind));
    for (const k of [PART_BODY, PART_APPENDAGE, PART_PLATE, PART_MOUTH])
      expect(kinds.has(k)).toBe(true);
  });

  it('shares the part kinds with both shaders', () => {
    expect(PART_KINDS).toBe(16);
    for (const shader of [vertexShader, fragmentShader]) {
      expect(shader).toMatch(new RegExp(`const float PART_KINDS = ${PART_KINDS}\\.0;`));
    }
  });
});

describe('buildCreatureGeometry v2: the inner anatomy', () => {
  const organKind = (v: number): boolean => ORGAN_KINDS.includes(partKind(v));

  it('keeps the organs within 20% of each level-of-detail budget, and the whole body within its budget', () => {
    for (const lod of LODS) expect(ORGAN_RESERVE[lod]).toBeLessThanOrEqual(0.2 * LOD_BUDGET[lod]);
    for (const genome of [...named, ...randoms.slice(0, 100)]) {
      const p = planOf(genome);
      const inner = anatomyFor(genome);
      for (const lod of LODS) {
        const part = attr(buildCreatureGeometry(p, lod, inner), 'aPart');
        let organs = 0;
        for (const v of part) if (organKind(v)) organs++;
        expect(organs, lod).toBeGreaterThan(0);
        expect(organs, lod).toBeLessThanOrEqual(ORGAN_RESERVE[lod]);
        expect(estimateVertices(p, lod, inner)).toBe(estimateVertices(p, lod) + organs);
        expect(part.length).toBeLessThanOrEqual(LOD_BUDGET[lod]);
      }
    }
  }, 60_000);

  it('draws the gut, the chambers and droplets, the heart and the eye pigment with their own part kinds', () => {
    expect(ORGAN_KINDS).toEqual([PART_GUT, PART_CHAMBER, PART_DROPLET, PART_HEART, PART_PIGMENT]);
    expect(new Set([...ORGAN_KINDS, PART_BODY, PART_SHELL, PART_EYE]).size).toBe(8);
    for (const kind of ORGAN_KINDS) expect(kind).toBeLessThan(PART_KINDS);
    const body = gallery.values().next().value as Genome;
    const kinds = new Set(
      Array.from(
        attr(buildCreatureGeometry(planOf(body), 'high', anatomyFor(body)), 'aPart'),
        partKind,
      ),
    );
    for (const kind of [PART_GUT, PART_HEART, PART_PIGMENT]) expect(kinds.has(kind)).toBe(true);
    expect(kinds.has(PART_CHAMBER) || kinds.has(PART_DROPLET)).toBe(true);
    // A body built without anatomy has no organs.
    const bare = attr(buildCreatureGeometry(planOf(body), 'high'), 'aPart');
    expect(Array.from(bare).some(organKind)).toBe(false);
    // The shader knows each organ kind by the same number.
    const names = { PART_GUT, PART_CHAMBER, PART_DROPLET, PART_HEART, PART_PIGMENT };
    for (const [name, value] of Object.entries(names)) {
      expect(fragmentShader).toMatch(new RegExp(`const int ${name} = ${value};`));
    }
  });

  it('draws the organs inside the shell: over the body and under the carapace and the eyes, within the hull', () => {
    for (const genome of [...gallery.values(), ...randoms.slice(0, 100)]) {
      const p = planOf(genome);
      const g = buildCreatureGeometry(p, 'high', anatomyFor(genome));
      const part = attr(g, 'aPart');
      const position = attr(g, 'position');
      const index = indexOf(g);
      // Draw order is index order (one draw call, no depth test): the first triangle of each kind.
      const firstTriangle = new Map<string, number>();
      const lastTriangle = new Map<string, number>();
      const tag = (v: number) => {
        const k = partKind(v);
        return organKind(v)
          ? 'organ'
          : k === PART_SHELL
            ? 'shell'
            : k === PART_EYE
              ? 'eye'
              : k <= PART_MOUTH && partId(v) === 0
                ? 'body'
                : 'other';
      };
      for (let t = 0; t < index.length; t += 3) {
        const key = tag(part[index[t] as number] as number);
        if (!firstTriangle.has(key)) firstTriangle.set(key, t);
        lastTriangle.set(key, t);
      }
      const organFirst = firstTriangle.get('organ') as number;
      expect(organFirst).toBeGreaterThan(lastTriangle.get('body') as number);
      for (const later of ['shell', 'eye']) {
        if (firstTriangle.has(later)) {
          expect(firstTriangle.get(later) as number).toBeGreaterThan(
            lastTriangle.get('organ') as number,
          );
        }
      }
      // Every organ vertex lies inside the body's outline (balls flatten to their disc).
      for (let i = 0; i < part.length; i++) {
        if (!organKind(part[i] as number)) continue;
        const [x, y] = [position[i * 3] as number, position[i * 3 + 1] as number];
        const inside = p.segments.some((s) => {
          const [dx, dy] = [x - s.x, y - s.y];
          const u = (dx * Math.cos(s.angle) + dy * Math.sin(s.angle)) / s.rx;
          const v = (-dx * Math.sin(s.angle) + dy * Math.cos(s.angle)) / s.ry;
          return u * u + v * v <= 1 + 1e-6;
        });
        expect(inside).toBe(true);
      }
    }
  });

  it('moves the organs with the body: rigid on a bilateral body, pulsing on a bell, never turning like a part', () => {
    for (const genome of [...gallery.values(), ...randoms.slice(0, 100)]) {
      const p = planOf(genome);
      const g = buildCreatureGeometry(p, 'high', anatomyFor(genome));
      const part = attr(g, 'aPart');
      const motion = attr(g, 'aMotion');
      const weight = attr(g, 'aWeight');
      for (let i = 0; i < part.length; i++) {
        if (!organKind(part[i] as number)) continue;
        expect(partId(part[i] as number)).toBe(0);
        expect(motion[i * 4]).toBe(p.form.radial ? MOTION_BELL : MOTION_RIGID);
        expect(motion[i * 4 + 2]).toBe(0);
        expect(weight[i]).toBe(0);
      }
    }
  }, 60_000);
});

describe('buildCreatureGeometry v2: rare glints (M6 T13)', () => {
  const exotic = { ...glintsFor('exotic', 1), seed: 'glint-seed' };
  const hashOf = (g: Genome): string => genomeHash(g);

  /** Where glints may sit: organ centres (not the eye pigment) and the joints of each part's main tube. */
  const candidates = (p: BodyPlan, a: Anatomy) => {
    const out = a.organs.filter((o) => o.kind !== 'pigment').map((o) => ({ x: o.x, y: o.y }));
    p.appendages.forEach((part) => {
      for (let i = 1; i <= part.joints; i++) out.push(partPoint(p, part, i / part.joints));
    });
    return out;
  };

  it('places the glints on joints and organs, apart from each other, deterministic per seed', () => {
    let full = 0;
    for (const genome of [...gallery.values(), ...randoms.slice(0, 200)]) {
      const p = planOf(genome);
      const inner = anatomyFor(genome);
      const seed = hashOf(genome);
      const spots = glintSpots(p, inner, MAX_GLINTS, seed);
      expect(spots).toEqual(glintSpots(p, inner, MAX_GLINTS, seed));
      expect(spots.length).toBeLessThanOrEqual(MAX_GLINTS);
      if (spots.length === MAX_GLINTS) full++;
      const where = candidates(p, inner);
      for (const s of spots) {
        expect(where.some((c) => Math.hypot(c.x - s.x, c.y - s.y) < 1e-9)).toBe(true);
        if (s.part >= 0) expect(s.part).toBeLessThan(p.appendages.length);
      }
      for (let i = 0; i < spots.length; i++) {
        for (let j = i + 1; j < spots.length; j++) {
          const [a, b] = [spots[i], spots[j]] as [(typeof spots)[0], (typeof spots)[0]];
          expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(GLINT_GAP - 1e-9);
        }
      }
      // Fewer glints are the first of more, so a rarer relative only adds to them.
      expect(glintSpots(p, inner, 3, seed)).toEqual(spots.slice(0, 3));
      expect(glintSpots(p, inner, 0, seed)).toEqual([]);
    }
    // Most bodies have room for the exotic's full count.
    expect(full).toBeGreaterThan(100);
    const g = gallery.values().next().value as Genome;
    expect(glintSpots(planOf(g), anatomyFor(g), 8, 'a')).not.toEqual(
      glintSpots(planOf(g), anatomyFor(g), 8, 'b'),
    );
  });

  it('draws each glint as one quad of its own part kind, last, within every budget', () => {
    expect(PART_GLINT).toBeLessThan(PART_KINDS);
    expect(fragmentShader).toMatch(new RegExp(`const int PART_GLINT = ${PART_GLINT};`));
    for (const genome of [...named, ...randoms.slice(0, 100)]) {
      const p = planOf(genome);
      const inner = anatomyFor(genome);
      const glints = { ...exotic, seed: hashOf(genome) };
      const spots = glintSpots(p, inner, glints.count, glints.seed);
      for (const lod of LODS) {
        const geometry = buildCreatureGeometry(p, lod, inner, glints);
        const part = attr(geometry, 'aPart');
        const count = part.length;
        expect(count).toBe(estimateVertices(p, lod, inner, glints));
        expect(count).toBe(estimateVertices(p, lod, inner) + 4 * spots.length);
        expect(count, lod).toBeLessThanOrEqual(LOD_BUDGET[lod]);
        const index = indexOf(geometry);
        const glinted = (t: number) => partKind(part[index[t] as number] as number) === PART_GLINT;
        let first = -1;
        for (let t = 0; t < index.length; t += 3) {
          if (glinted(t) && first < 0) first = t;
          if (first >= 0) expect(glinted(t)).toBe(true);
        }
        if (spots.length > 0) expect((index.length - first) / 3).toBe(2 * spots.length);
        // A glint on a part rides that part: its id, root and weight; one on an organ rides the body.
        const position = attr(geometry, 'position');
        const weight = attr(geometry, 'aWeight');
        const motion = attr(geometry, 'aMotion');
        const quads: number[] = [];
        for (let i = 0; i < count; i++)
          if (partKind(part[i] as number) === PART_GLINT) quads.push(i);
        expect(quads.length).toBe(4 * spots.length);
        spots.forEach((s, k) => {
          const quad = quads.slice(4 * k, 4 * k + 4);
          const mean = (axis: number) =>
            quad.reduce((sum, i) => sum + (position[i * 3 + axis] as number), 0) / 4;
          expect(mean(0)).toBeCloseTo(s.x, 6);
          expect(mean(1)).toBeCloseTo(s.y, 6);
          for (const i of quad) {
            expect(Math.abs((position[i * 3] as number) - s.x)).toBeCloseTo(glints.size, 6);
            expect(partId(part[i] as number)).toBe(s.part + 1);
            if (s.part < 0) {
              expect(weight[i]).toBe(0);
              expect(motion[i * 4]).toBe(p.form.radial ? MOTION_BELL : MOTION_RIGID);
            } else expect(weight[i]).toBeCloseTo(s.t, 6);
          }
        });
        geometry.dispose();
      }
    }
  }, 60_000);

  it("keeps the glints out of a part's reach, so the part moves as without them", () => {
    const genome = specimen('36-specimen-tier-exotic');
    const p = planOf(genome);
    const inner = anatomyFor(genome);
    const bare = buildCreatureGeometry(p, 'high', inner);
    const glinted = buildCreatureGeometry(p, 'high', inner, { ...exotic, seed: hashOf(genome) });
    const gains = (g: Geometry) => {
      const part = attr(g, 'aPart');
      const motion = attr(g, 'aMotion');
      const out = new Map<number, number>();
      for (let i = 0; i < part.length; i++) {
        if (partKind(part[i] as number) === PART_APPENDAGE)
          out.set(partId(part[i] as number), motion[i * 4 + 2] as number);
      }
      return out;
    };
    expect(gains(glinted)).toEqual(gains(bare));
  });
});

describe('buildCreatureGeometry v2: parts and fine detail', () => {
  it('roots every appendage on its segment outline', () => {
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
  }, 30_000);

  it('attaches every vertex of a part to its root, with weights from 0 at the base', () => {
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
          if (kind !== PART_APPENDAGE && kind !== PART_SETA && kind !== PART_MEMBRANE) {
            bad.push(`kind ${kind} on part ${id}`);
          }
          const a = rootAttach.get(id);
          if (a === undefined) rootAttach.set(id, attach[i] as number);
          else if (attach[i] !== a) bad.push(`part ${id} hangs from two places`);
        }
        expect(bad.slice(0, 3), lod).toEqual([]);
      }
    }
  }, 30_000);

  it('draws joint beads, bulb tips and chela fingers on the parts that have them', () => {
    const p = planOf(specimen('29-'));
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
    for (const prefix of ['23-', '24-', '27-', '31-']) {
      const p = planOf(specimen(prefix));
      const bristles = p.appendages.reduce((n, a) => n + a.setae, 0);
      expect(bristles).toBeGreaterThan(20);
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

  it("fans each part's bristles out, so their tips stand apart as separate strokes", () => {
    // None grows into the body either: a bristle that would, grows from the part's other side.
    const p = planOf(specimen('27-'));
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
    expect(ratios.length).toBeGreaterThan(20);
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

  it('marks only the body: whole numbers between its ends, and none on any other part', () => {
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
  }, 60_000);

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
