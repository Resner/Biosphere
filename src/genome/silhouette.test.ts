import { describe, expect, it } from 'vitest';
import { ARCHETYPES, buildGenome } from '../../tests/archetypes';
import { createRng, seedFromString } from '../sim/prng';
import { decodeGenome, type Genome } from './codec';
import { type BodyPlan, develop } from './develop';
import { express } from './express';
import { GENOME_BYTES } from './karyotype';
import { SILHOUETTES, type Silhouette, silhouetteOf } from './silhouette';
import { starterGenome } from './starter';

// Silhouettes (M6 T8): one hand-built body per class, made through the karyotype, and the classifier
// is total.

const MID = { mouthSize: 255, mouthType: 128, digestion: 128 };
const ROW = { length: 150, thickness: 120, tipShape: 191, beat: 220, angle: 128 };

const BODIES: Record<Exclude<Silhouette, 'other'>, Genome> = {
  // The reference cell: one segment and a whip.
  cell: starterGenome(),
  // One cell with a fringe of three short beating pairs.
  ciliate: ARCHETYPES.ciliate as Genome,
  // Radial, the parts standing straight out, bead-tipped spines among them.
  'spiny-larva': buildGenome(
    {
      M1: { length: 150, thickness: 40, tipShape: 230, beat: 200, pairs: 255 },
      M2: {
        length: 200,
        thickness: 30,
        tipShape: 64,
        stiffness: 255,
        angle: 128,
        pairs: 255,
        bulb: 255,
      },
    },
    { ...MID, symmetry: 255 },
  ),
  // Radial with the ring draped rearward: tentacles.
  bell: ARCHETYPES.radial as Genome,
  // A big head, a stretched tail and a whip at the back.
  tadpole: buildGenome(
    { M1: { length: 200, thickness: 60, tipShape: 255, beat: 220, angle: 255, attachStart: 255 } },
    { ...MID, segDrive1: 80, segDrive2: 80, headScale: 255, tailLength: 255, eyeSize: 200 },
  ),
  // A shell over the front half, a free tapering tail and long antennae.
  copepod: buildGenome(
    {
      M1: { ...ROW, pairs: 255, attachSpan: 128 },
      M2: {
        length: 255,
        thickness: 20,
        tipShape: 255,
        angle: 15,
        setaeDensity: 128,
        setaeLength: 60,
      },
    },
    { ...MID, segDrive1: 180, segDrive2: 180, fusion: 128, tailTaper: 200 },
  ),
  // A long straight body with legs all along it and antennae.
  shrimp: buildGenome(
    {
      M1: {
        length: 120,
        thickness: 40,
        tipShape: 191,
        beat: 200,
        angle: 128,
        pairs: 255,
        attachSpan: 255,
      },
      M2: { length: 255, thickness: 15, tipShape: 255, angle: 10 },
    },
    { ...MID, segDrive1: 230, segDrive2: 230, aspect: 200, tailLength: 200 },
  ),
  // Eight segments in an S, with short cilia.
  worm: buildGenome(
    {
      M1: {
        length: 60,
        thickness: 40,
        tipShape: 230,
        beat: 220,
        angle: 128,
        pairs: 128,
        attachSpan: 255,
      },
    },
    { ...MID, segDrive1: 255, segDrive2: 255, curve: 160, curveMode: 255, flexibility: 255 },
  ),
  // The chain coiled past a full turn.
  coil: buildGenome(
    { M1: { ...ROW, pairs: 255, attachSpan: 255 } },
    { ...MID, segDrive1: 255, segDrive2: 255, curve: 255, tailTaper: 200 },
  ),
  // One carapace over the whole body, legs out.
  crab: ARCHETYPES.carapaced as Genome,
  // Forked paddles webbed into sheets as large as the body.
  winged: ARCHETYPES.winged as Genome,
  // The rearmost pair splayed back and webbed across the tail.
  'fan-tail': buildGenome(
    {
      M1: {
        length: 200,
        thickness: 160,
        tipShape: 191,
        beat: 220,
        angle: 180,
        attachStart: 255,
        webbing: 255,
        branching: 255,
      },
    },
    { ...MID, segDrive1: 160, segDrive2: 160 },
  ),
};

const planOf = (g: Genome): BodyPlan => develop(express(g));

describe('silhouetteOf', () => {
  it('classifies a hand-built body of every class', () => {
    expect(Object.keys(BODIES).sort()).toEqual(SILHOUETTES.filter((s) => s !== 'other').sort());
    for (const [name, g] of Object.entries(BODIES)) {
      expect(silhouetteOf(planOf(g)), name).toBe(name);
    }
  });

  it('reads geometry only: module labels and beat phases do not matter', () => {
    for (const g of Object.values(BODIES)) {
      const p = planOf(g);
      const relabelled: BodyPlan = {
        ...p,
        appendages: p.appendages.map((a) => ({ ...a, module: 7 - a.module, phase: 0.5 })),
      };
      expect(silhouetteOf(relabelled)).toBe(silhouetteOf(p));
    }
  });

  it('is total: every plan, even a broken one, gets a class', () => {
    const rng = createRng(seedFromString('genome-silhouette'), 'bytes');
    const seen = new Set<Silhouette>();
    for (let i = 0; i < 10_000; i++) {
      const bytes = Uint8Array.from({ length: GENOME_BYTES }, () => rng.nextU32() & 0xff);
      const s = silhouetteOf(planOf(decodeGenome(bytes)));
      expect(SILHOUETTES).toContain(s);
      seen.add(s);
    }
    // Random genomes reach most of the classes.
    expect(seen.size).toBeGreaterThanOrEqual(8);
    const p = planOf(starterGenome());
    expect(silhouetteOf({ ...p, segments: [] })).toBe('other');
    expect(silhouetteOf({ ...p, appendages: [] })).toBe('cell');
    // Two even segments without a big head are none of the classes.
    const two = planOf(
      buildGenome({ M1: ROW }, { ...MID, segDrive1: 40, segDrive2: 40, taper: 0 }),
    );
    expect(two.segments).toHaveLength(2);
    expect(
      silhouetteOf({ ...two, segments: two.segments.map((s) => ({ ...s, rx: 1, ry: 1 })) }),
    ).toBe('other');
  });

  it('is deterministic', () => {
    const p = planOf(BODIES.copepod);
    expect(silhouetteOf(structuredClone(p))).toBe(silhouetteOf(p));
  });
});
