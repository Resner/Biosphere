import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it, vi } from 'vitest';
import { ARCHETYPES, buildBytes } from '../../tests/archetypes';
import { decodeGenome, type Genome } from '../genome/codec';
import { type BodyPlan, type Detail, develop, estimateVertices } from '../genome/develop';
import { express } from '../genome/express';
import { genesisGenome } from '../genome/genesis';
import { GENOME_BYTES, LOCI, MODULE_PARAMS } from '../genome/karyotype';
import { starterGenome } from '../genome/starter';
import { buildCreature } from '../genome/stats';
import { createRng, seedFromString } from '../sim/prng';
import { RULES } from '../sim/rules';
import { CreatureCache, FULL_ABOVE, LOW_BELOW, lodFor } from './creature-cache';
import {
  bodyHalfWidth,
  buildCreatureGeometry,
  PART_APPENDAGE,
  PART_BODY,
  PART_MOUTH,
  PART_PLATE,
  partId,
  partKind,
} from './creature-mesh';

const D = RULES.develop;
const rng = createRng(seedFromString('creature-mesh-tests'), 'bytes');
const plan = (g: Genome): BodyPlan => develop(express(g));

const MODULE_IDS = LOCI.filter((l) => l.kind === 'module').map((l) => l.id);
const allModules = (value: number) => {
  const params = Object.fromEntries(MODULE_PARAMS.map((p) => [p, value]));
  return Object.fromEntries(MODULE_IDS.map((id) => [id, params]));
};

const randomGenome = (): Genome =>
  decodeGenome(Uint8Array.from({ length: GENOME_BYTES }, () => rng.nextU32() & 0xff));

const extremes: Genome[] = [
  new Uint8Array(GENOME_BYTES),
  new Uint8Array(GENOME_BYTES).fill(0xff),
  buildBytes(allModules(0)),
  buildBytes(allModules(255)),
  buildBytes(allModules(255), { segDrive1: 255, segDrive2: 255 }),
].map(decodeGenome);

const named: Genome[] = [
  starterGenome(),
  ...Object.values(ARCHETYPES),
  ...extremes,
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
const DETAILS: Detail[] = ['full', 'low'];

const attr = (g: ReturnType<typeof buildCreatureGeometry>, name: string): Float32Array =>
  g.getAttribute(name).array as Float32Array;

describe('buildCreatureGeometry', () => {
  it('draws exactly the estimated vertices within budget and bounds, with finite attributes and valid indices', () => {
    const NAMES = ['position', 'normal', 'uv', 'aSpine', 'aAttach', 'aWeight', 'aPart'];
    const limit = D.caps.bounds * 1.05;
    for (const genome of [...named, ...randoms]) {
      const p = planOf(genome);
      for (const detail of DETAILS) {
        const geometry = buildCreatureGeometry(p, detail);
        const position = attr(geometry, 'position');
        const count = position.length / 3;
        expect(count).toBe(estimateVertices(p, detail));
        expect(count).toBeLessThanOrEqual(D.vertices[detail].cap);
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
        const index = geometry.getIndex()?.array as Uint32Array | Uint16Array;
        if (index.length % 3 !== 0) bad++;
        for (let i = 0; i < index.length; i++) if ((index[i] as number) >= count) bad++;
        expect(bad).toBe(0);
        expect(reach).toBeLessThanOrEqual(limit);
        geometry.dispose();
      }
    }
  }, 20_000);

  it('is deterministic', () => {
    const hashOf = (g: Genome): string => {
      const geometry = buildCreatureGeometry(planOf(g), 'full');
      return bytesToHex(sha256(new Uint8Array(attr(geometry, 'position').buffer)));
    };
    for (const genome of named) expect(hashOf(genome)).toBe(hashOf(genome));
  });

  it('makes the starter body as wide as the M1 cell', () => {
    const body: BodyPlan = { ...plan(starterGenome()), appendages: [], plates: [] };
    expect(body.segments).toHaveLength(1);
    const geometry = buildCreatureGeometry(body, 'full');
    const position = attr(geometry, 'position');
    let maxY = 0;
    let maxZ = 0;
    let maxX = 0;
    for (let i = 0; i < position.length; i += 3) {
      maxX = Math.max(maxX, Math.abs(position[i] as number));
      maxY = Math.max(maxY, Math.abs(position[i + 1] as number));
      maxZ = Math.max(maxZ, Math.abs(position[i + 2] as number));
    }
    const s = body.segments[0];
    expect(maxY).toBeCloseTo(1, 6);
    expect(maxX).toBeCloseTo(s?.rx as number, 6);
    expect(maxZ).toBeLessThanOrEqual(1);
  });

  it('is one continuous body surface', () => {
    for (const genome of [...named, ...randoms.slice(0, 200)]) {
      const p = planOf(genome);
      const v = D.vertices.full;
      const position = attr(buildCreatureGeometry(p, 'full'), 'position');
      const ringCount = p.segments.length * v.bodyRings;
      let lastX = -Infinity;
      for (let r = 0; r < ringCount; r++) {
        const at = r * v.bodyRing * 3;
        const x = position[at] as number;
        expect(x).toBeGreaterThanOrEqual(lastX);
        lastX = x;
        const w = bodyHalfWidth(p.segments, x);
        for (let j = 0; j < v.bodyRing; j++) {
          const o = at + j * 3;
          expect(position[o]).toBe(x);
          // The ring sits on the union of the segment ellipses; plates only lift it upward.
          expect(Math.abs(position[o + 1] as number)).toBeLessThanOrEqual(w + 1e-6);
        }
      }
      // The first and last rings close to points: nothing is left open at the ends.
      for (const r of [0, ringCount - 1]) {
        for (let j = 0; j < v.bodyRing; j++) {
          expect(
            Math.hypot(
              position[(r * v.bodyRing + j) * 3 + 1] as number,
              position[(r * v.bodyRing + j) * 3 + 2] as number,
            ),
          ).toBeLessThan(1e-6);
        }
      }
    }
  }, 20_000);

  it('roots every appendage on the body surface', () => {
    const { partRing, jointRings, bodyRings, bodyRing } = D.vertices.full;
    for (const genome of randoms.slice(0, 500)) {
      const p = planOf(genome);
      const position = attr(buildCreatureGeometry(p, 'full'), 'position');
      let at = p.segments.length * bodyRings * bodyRing;
      for (const a of p.appendages) {
        let cx = 0;
        let cy = 0;
        for (let j = 0; j < partRing; j++) {
          cx += position[(at + j) * 3] as number;
          cy += position[(at + j) * 3 + 1] as number;
        }
        cx /= partRing;
        cy /= partRing;
        expect(
          Math.abs(Math.abs(cy) - bodyHalfWidth(p.segments, cx)),
          `side ${a.side}`,
        ).toBeLessThanOrEqual(0.02);
        expect(Math.sign(cy)).toBe(a.side);
        at += (1 + a.branches) * ((a.joints * jointRings + 1) * partRing + 1);
      }
    }
  }, 20_000);

  it('winds every surface outward, on both sides of the body', () => {
    const { partRing, jointRings, bodyRings, bodyRing } = D.vertices.full;
    for (const genome of [...named, ...randoms.slice(0, 100)]) {
      const p = planOf(genome);
      const g = buildCreatureGeometry(p, 'full');
      const position = attr(g, 'position');
      const normal = attr(g, 'normal');
      // The middle vertex of a ring: its normal points away from the ring's centre.
      const outward = (first: number, size: number, j: number): number => {
        let cx = 0;
        let cy = 0;
        let cz = 0;
        for (let k = 0; k < size; k++) {
          cx += position[(first + k) * 3] as number;
          cy += position[(first + k) * 3 + 1] as number;
          cz += position[(first + k) * 3 + 2] as number;
        }
        const v = (first + j) * 3;
        return (
          (normal[v] as number) * ((position[v] as number) - cx / size) +
          (normal[v + 1] as number) * ((position[v + 1] as number) - cy / size) +
          (normal[v + 2] as number) * ((position[v + 2] as number) - cz / size)
        );
      };
      const widest = (p.segments.length * bodyRings) >> 1;
      for (let j = 0; j < bodyRing; j++) {
        expect(outward(widest * bodyRing, bodyRing, j)).toBeGreaterThan(0);
      }
      let at = p.segments.length * bodyRings * bodyRing;
      for (const a of p.appendages) {
        const rings = a.joints * jointRings + 1;
        const mid = at + (rings >> 1) * partRing;
        for (let j = 0; j < partRing; j++)
          expect(
            outward(mid, partRing, j),
            `side ${a.side} branches ${a.branches} taper ${a.taper} joint ${j}`,
          ).toBeGreaterThan(0);
        at += (1 + a.branches) * (rings * partRing + 1);
      }
    }
  });

  it('marks body, appendage, plate and mouth vertices, each appendage by its own id', () => {
    const plated = decodeGenome(buildBytes({}, { plating1: 128, plating2: 128 }));
    const p = planOf(plated);
    expect(p.plates.length).toBeGreaterThan(0);
    const part = attr(buildCreatureGeometry(p, 'full'), 'aPart');
    const kinds = new Set(Array.from(part, partKind));
    for (const k of [PART_BODY, PART_APPENDAGE, PART_PLATE, PART_MOUTH])
      expect(kinds.has(k)).toBe(true);
    const ids = new Set(Array.from(part, partId));
    expect(ids.size).toBe(p.appendages.length + 1);
    expect(Math.max(...ids)).toBe(p.appendages.length);
  });

  it('gives appendage vertices a weight that grows from zero at the base', () => {
    for (const genome of named) {
      const p = planOf(genome);
      const g = buildCreatureGeometry(p, 'full');
      const weight = attr(g, 'aWeight');
      const part = attr(g, 'aPart');
      for (let i = 0; i < part.length; i++) {
        if (partKind(part[i] as number) !== PART_APPENDAGE) expect(weight[i]).toBe(0);
      }
      const bodyVertices = p.segments.length * D.vertices.full.bodyRings * D.vertices.full.bodyRing;
      const firstRing = weight.slice(bodyVertices, bodyVertices + D.vertices.full.partRing);
      expect(Math.max(...firstRing)).toBe(0);
    }
  });
});

describe('CreatureCache', () => {
  const creature = (i: number) => buildCreature(genesisGenome(seedFromString(`cache-${i}`)));

  it('builds one asset per genome hash and detail', () => {
    const cache = new CreatureCache();
    const c = creature(0);
    const a = cache.acquire(c, 'full');
    expect(cache.acquire(c, 'full')).toBe(a);
    expect(cache.live()).toBe(1);
    expect(cache.acquire(c, 'low')).not.toBe(a);
    expect(cache.live()).toBe(2);
  });

  it('disposes the geometry and material when the last holder releases', () => {
    const cache = new CreatureCache();
    const c = creature(1);
    const a = cache.acquire(c, 'full');
    cache.acquire(c, 'full');
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
        cache.acquire(
          creatures[(i * 7) % 50] as ReturnType<typeof creature>,
          i % 3 ? 'full' : 'low',
        ),
      );
      if (i % 2) cache.release(held.shift() as (typeof held)[number]);
    }
    expect(cache.live()).toBeGreaterThan(0);
    for (const asset of held) cache.release(asset);
    expect(cache.live()).toBe(0);
  });
});

describe('lodFor', () => {
  it('switches below 12 px and above 16 px, and keeps the current level between', () => {
    expect(LOW_BELOW).toBe(12);
    expect(FULL_ABOVE).toBe(16);
    expect(lodFor(11.9, 'full')).toBe('low');
    expect(lodFor(16.1, 'low')).toBe('full');
    expect(lodFor(14, 'low')).toBe('low');
    expect(lodFor(14, 'full')).toBe('full');
    expect(lodFor(14)).toBe('full');
  });
});
