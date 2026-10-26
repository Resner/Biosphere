import { describe, expect, it } from 'vitest';
import { ARCHETYPES, buildBytes } from '../../tests/archetypes';
import { decodeGenome, type Genome } from '../genome/codec';
import { develop } from '../genome/develop';
import { express } from '../genome/express';
import { GENOME_BYTES, LOCI, MODULE_PARAMS } from '../genome/karyotype';
import { starterGenome } from '../genome/starter';
import { createRng, seedFromString } from '../sim/prng';
import { advanceBeatPhase } from './beat';
import { buildCreatureGeometry, PART_APPENDAGE, partKind } from './creature-mesh';
import {
  BREATH,
  GAIT_REST,
  type GaitUniforms,
  type GaitVertex,
  gaitOf,
  gaitOffset,
  spineOffset,
} from './gait';

const rng = createRng(seedFromString('gait-tests'), 'bytes');
const randomGenome = (): Genome =>
  decodeGenome(Uint8Array.from({ length: GENOME_BYTES }, () => rng.nextU32() & 0xff));

const MODULE_IDS = LOCI.filter((l) => l.kind === 'module').map((l) => l.id);
const allModules = (value: number) => {
  const params = Object.fromEntries(MODULE_PARAMS.map((p) => [p, value]));
  return Object.fromEntries(MODULE_IDS.map((id) => [id, params]));
};

const genomes: Genome[] = [
  starterGenome(),
  ...Object.values(ARCHETYPES),
  ...[
    new Uint8Array(GENOME_BYTES),
    new Uint8Array(GENOME_BYTES).fill(0xff),
    buildBytes(allModules(0)),
    buildBytes(allModules(255)),
    buildBytes(allModules(255), { segDrive1: 255, segDrive2: 255 }),
  ].map(decodeGenome),
  ...Array.from({ length: 495 }, randomGenome),
];

interface Sample {
  verts: GaitVertex[];
  genes: Pick<GaitUniforms, 'amp' | 'freq' | 'bend'>;
}

const samples: Sample[] = genomes.map((g) => {
  const traits = express(g);
  const plan = develop(traits);
  const geo = buildCreatureGeometry(plan, 'full');
  const attr = (name: string) => geo.getAttribute(name).array as Float32Array;
  const pos = attr('position');
  const [spine, attach, weight, part] = [
    attr('aSpine'),
    attr('aAttach'),
    attr('aWeight'),
    attr('aPart'),
  ];
  const verts: GaitVertex[] = [];
  for (let i = 0; i < part.length; i++) {
    verts.push({
      y: pos[i * 3 + 1] as number,
      spine: spine[i] as number,
      attach: attach[i] as number,
      weight: weight[i] as number,
      part: part[i] as number,
    });
  }
  geo.dispose();
  return { verts, genes: gaitOf(traits, plan) };
});

const PHASES = Array.from({ length: 8 }, (_, k) => (k * Math.PI) / 4);
const out = { x: 0, y: 0 };
const uniforms = (s: Sample, phase: number, beat: number): GaitUniforms => ({
  ...s.genes,
  phase,
  beat,
});
const reach = (s: Sample, u: GaitUniforms): number => {
  let m = 0;
  for (const v of s.verts) {
    gaitOffset(out, v, u);
    m = Math.max(m, Math.hypot(out.x, out.y));
  }
  return m;
};

describe('gaitOffset', () => {
  it('keeps the base ring of every part on the spine at its attach position', () => {
    let worst = 0;
    let rings = 0;
    for (const s of samples) {
      for (const phase of PHASES) {
        const u = uniforms(s, phase, 1);
        for (const v of s.verts) {
          if (partKind(v.part) !== PART_APPENDAGE || v.weight !== 0) continue;
          gaitOffset(out, v, u);
          rings++;
          worst = Math.max(worst, Math.abs(out.y - spineOffset(v.attach, u)), Math.abs(out.x));
        }
      }
    }
    expect(rings).toBeGreaterThan(1_000);
    expect(worst).toBeLessThan(0.01);
  });

  it('moves no vertex more than 0.6 core radii, whatever the genes', () => {
    for (const s of samples) {
      for (const phase of PHASES) {
        // The swing grows with the beat, so full beat is the worst case.
        expect(reach(s, uniforms(s, phase, 1))).toBeLessThanOrEqual(0.6);
        expect(reach(s, { amp: 1, freq: 2, bend: 1, phase, beat: 1 })).toBeLessThanOrEqual(0.6);
      }
    }
  });

  it('only breathes at throttle 0', () => {
    for (const s of samples) {
      let moving = 0;
      let resting = 0;
      for (const phase of PHASES) {
        moving = Math.max(moving, reach(s, uniforms(s, phase, 1)));
        resting = Math.max(resting, reach(s, uniforms(s, phase, 0)));
      }
      expect(resting).toBeLessThanOrEqual(moving * 0.15 + 1e-9);
    }
    expect(BREATH).toBeLessThan(0.15);
  });

  it('swims: a starter cell moves its tail clearly at full beat', () => {
    const s = samples[0] as Sample;
    let moving = 0;
    for (const phase of PHASES) moving = Math.max(moving, reach(s, uniforms(s, phase, 1)));
    expect(moving).toBeGreaterThan(0.05);
  });

  it('does nothing for a creature with no amplitude', () => {
    expect(Math.abs(spineOffset(1, { ...GAIT_REST, beat: 1, phase: 1 }))).toBe(0);
  });

  it('does not jump the pose when the frequency rises mid-run', () => {
    // The phase is integrated: after an hour, one 60 fps step with a higher frequency changes the
    // pose by a frame's worth of motion, not by the hour times the change of rate.
    let worst = 0;
    for (const s of samples.slice(0, 120)) {
      let phase = 0;
      for (let i = 0; i < 216_000; i += 36)
        phase = advanceBeatPhase(phase, 1, 36 / 60, s.genes.freq);
      const before = uniforms(s, phase, 1);
      const after = uniforms(s, advanceBeatPhase(phase, 1, 1 / 60, s.genes.freq + 0.5), 1);
      const keep = uniforms(s, advanceBeatPhase(phase, 1, 1 / 60, s.genes.freq), 1);
      for (const v of s.verts) {
        gaitOffset(out, v, after);
        const [ax, ay] = [out.x, out.y];
        gaitOffset(out, v, keep);
        worst = Math.max(worst, Math.hypot(ax - out.x, ay - out.y));
        gaitOffset(out, v, before);
      }
    }
    expect(worst).toBeLessThanOrEqual(0.05);
  });
});
