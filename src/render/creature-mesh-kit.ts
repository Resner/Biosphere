import { readdirSync, readFileSync } from 'node:fs';
import { ARCHETYPES, buildBytes } from '../../tests/archetypes';
import { decodeGenome, type Genome, genomeHash } from '../genome/codec';
import { type BodyPlan, develop } from '../genome/develop';
import { express } from '../genome/express';
import { genesisGenome } from '../genome/genesis';
import { GENOME_BYTES, LOCI, MODULE_EXT, MODULE_PARAMS, SHAPE_LOCI } from '../genome/karyotype';
import { starterGenome } from '../genome/starter';
import { parseSpecimen } from '../lab/gallery';
import { createRng, seedFromString } from '../sim/prng';
import { RULES } from '../sim/rules';
import { type Anatomy, anatomyOf } from './anatomy';
import { type buildCreatureGeometry, type Lod, partId, partKind } from './creature-mesh';

export const D = RULES.develop;
export const LODS: Lod[] = ['high', 'medium', 'low'];
export const rng = createRng(seedFromString('creature-mesh-v2-tests'), 'bytes');
export const plan = (g: Genome): BodyPlan => develop(express(g));

export const MODULE_IDS = LOCI.filter((l) => l.kind === 'module').map((l) => l.id);
export const allModules = (value: number) => {
  const params = Object.fromEntries([...MODULE_PARAMS, ...MODULE_EXT].map((p) => [p, value]));
  return Object.fromEntries(MODULE_IDS.map((id) => [id, params]));
};
export const allShape = (value: number) => Object.fromEntries(SHAPE_LOCI.map((id) => [id, value]));

export const randomGenome = (): Genome =>
  decodeGenome(Uint8Array.from({ length: GENOME_BYTES }, () => rng.nextU32() & 0xff));

export const BRISTLES = new URL('../../tests/fixtures/bristles/shrimp.hex', import.meta.url);

/** The gallery specimens (M6 T5, T9), by file name. */
export const GALLERY_DIR = new URL('../../tests/fixtures/gallery/', import.meta.url);
export const gallery = new Map(
  readdirSync(GALLERY_DIR)
    .filter((f) => f.endsWith('.hex'))
    .sort()
    .map((f) => {
      const s = parseSpecimen(f, readFileSync(new URL(f, GALLERY_DIR), 'utf8'));
      if (!s) throw new Error(`bad specimen ${f}`);
      return [f, s.genome] as const;
    }),
);
/** Gallery specimens that carry bristles. */
export const BRISTLED = ['27-', '31-', '37-', '38-'];
export const specimen = (prefix: string): Genome => {
  for (const [f, g] of gallery) if (f.startsWith(prefix)) return g;
  throw new Error(`no specimen ${prefix}`);
};

export const extremes: Genome[] = [
  new Uint8Array(GENOME_BYTES),
  new Uint8Array(GENOME_BYTES).fill(0xff),
  buildBytes(allModules(0)),
  buildBytes(allModules(255)),
  buildBytes(allModules(255), { segDrive1: 255, segDrive2: 255 }),
  buildBytes(allModules(255), { segDrive1: 255, segDrive2: 255, ...allShape(255) }),
  buildBytes(allModules(255), { segDrive1: 255, segDrive2: 255, ...allShape(128) }),
  buildBytes(allModules(200), { segDrive1: 255, segDrive2: 255, symmetry: 255, drape: 255 }),
  // The costliest body the visible-part budget leaves (ADR 0041): all 14 instances, spread over the
  // regions, jointed, branched, bristled and webbed, on a plated eight-segment body with eyes.
  buildBytes(
    Object.fromEntries(
      MODULE_IDS.map((id, k) => [
        id,
        { ...allModules(255)[id], attachStart: k * 36, attachSpan: 40, angle: 40 + k * 20 },
      ]),
    ),
    { segDrive1: 255, segDrive2: 255, plating1: 255, plating2: 255, eyeSize: 255, eyeStalk: 128 },
  ),
].map(decodeGenome);

export const named: Genome[] = [
  starterGenome(),
  ...Object.values(ARCHETYPES),
  ...extremes,
  ...gallery.values(),
  ...Array.from({ length: 20 }, (_, i) => genesisGenome(seedFromString(`mesh-genesis-${i}`))),
];

export const randoms = Array.from({ length: 1_500 }, randomGenome);
// Development is the slow part of these tests, so every genome is developed once.
export const plans = new Map<Genome, BodyPlan>();
export const planOf = (g: Genome): BodyPlan => {
  let p = plans.get(g);
  if (!p) {
    p = plan(g);
    plans.set(g, p);
  }
  return p;
};

/** Strictly inside one of the plan's segment ellipses (Float32 positions on an outline count as out). */
export const insideBody = (p: BodyPlan, x: number, y: number): boolean =>
  p.segments.some((s) => {
    const [dx, dy] = [x - s.x, y - s.y];
    const u = (dx * Math.cos(s.angle) + dy * Math.sin(s.angle)) / s.rx;
    const v = (-dx * Math.sin(s.angle) + dy * Math.cos(s.angle)) / s.ry;
    return u * u + v * v < 1 - 1e-4;
  });

// The inner anatomy (M6 T12) of each genome, built once like its plan.
export const anatomies = new Map<Genome, Anatomy>();
export const anatomyFor = (g: Genome): Anatomy => {
  let a = anatomies.get(g);
  if (!a) {
    a = anatomyOf(planOf(g), express(g), genomeHash(g));
    anatomies.set(g, a);
  }
  return a;
};

export type Geometry = ReturnType<typeof buildCreatureGeometry>;
export const attr = (g: Geometry, name: string): Float32Array =>
  g.getAttribute(name).array as Float32Array;
export const indexOf = (g: Geometry) => g.getIndex()?.array as Uint32Array | Uint16Array;

/** Vertex numbers grouped by `aPart`'s kind and appendage id. */
export function groups(g: Geometry): Map<string, number[]> {
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
