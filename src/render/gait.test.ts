import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ARCHETYPES, buildBytes } from '../../tests/archetypes';
import { decodeGenome, type Genome } from '../genome/codec';
import { type BodyPlan, develop } from '../genome/develop';
import { express } from '../genome/express';
import { GENOME_BYTES, LOCI, MODULE_PARAMS } from '../genome/karyotype';
import { starterGenome } from '../genome/starter';
import { parseSpecimen } from '../lab/gallery';
import { createRng, seedFromString } from '../sim/prng';
import { advanceBeatPhase } from './beat';
import {
  buildCreatureGeometry,
  type Lod,
  METACHRONAL,
  MOTION_ANTENNA,
  MOTION_BEAT,
  MOTION_BELL,
  MOTION_RIGID,
  MOTION_TENTACLE,
  MOTION_WING,
  PART_BODY,
  PART_SETA,
  partId,
  partKind,
} from './creature-mesh';
import {
  attachPoint,
  bellPulse,
  effort,
  GAIT_CONSTANTS,
  GAIT_WRAP,
  type GaitUniforms,
  type GaitVertex,
  gaitOf,
  gaitPosition,
  partAngle,
  TURN_LAG_S,
  trailHeading,
  turnLag,
  wingFlap,
} from './gait';
import vertexShader from './shaders/creature.vert.glsl?raw';

const TAU = Math.PI * 2;
const rng = createRng(seedFromString('gait-tests'), 'bytes');
const randomGenome = (): Genome =>
  decodeGenome(Uint8Array.from({ length: GENOME_BYTES }, () => rng.nextU32() & 0xff));

const MODULE_IDS = LOCI.filter((l) => l.kind === 'module').map((l) => l.id);
const allModules = (value: number) => {
  const params = Object.fromEntries(MODULE_PARAMS.map((p) => [p, value]));
  return Object.fromEntries(MODULE_IDS.map((id) => [id, params]));
};

const DIR = 'tests/fixtures/gallery/';
const gallery = new Map<string, Genome>();
for (const file of readdirSync(DIR).sort()) {
  const parsed = parseSpecimen(file, readFileSync(DIR + file, 'utf8'));
  if (parsed) gallery.set(file, parsed.genome);
}
const specimenGenome = (prefix: string): Genome => {
  for (const [file, genome] of gallery) if (file.startsWith(prefix)) return genome;
  throw new Error(`no specimen ${prefix}`);
};

const fixed: Genome[] = [
  starterGenome(),
  ...Object.values(ARCHETYPES),
  ...gallery.values(),
  ...[
    new Uint8Array(GENOME_BYTES),
    new Uint8Array(GENOME_BYTES).fill(0xff),
    buildBytes(allModules(0)),
    buildBytes(allModules(255)),
    buildBytes(allModules(255), { segDrive1: 255, segDrive2: 255 }),
  ].map(decodeGenome),
];
// 500 plans, the size of the M3 gait test.
const genomes: Genome[] = [...fixed, ...Array.from({ length: 500 - fixed.length }, randomGenome)];

interface Sample {
  plan: BodyPlan;
  verts: GaitVertex[];
  /** `aPart` per vertex. */
  parts: number[];
  genes: ReturnType<typeof gaitOf>;
}

function sampleOf(genome: Genome, lod: Lod = 'medium'): Sample {
  const traits = express(genome);
  const plan = develop(traits);
  const geo = buildCreatureGeometry(plan, lod);
  const attr = (name: string) => geo.getAttribute(name).array as Float32Array;
  const [pos, normal, frame, motion] = [
    attr('position'),
    attr('normal'),
    attr('aFrame'),
    attr('aMotion'),
  ];
  const [attach, weight, part, flutter] = [
    attr('aAttach'),
    attr('aWeight'),
    attr('aPart'),
    attr('aFlutter'),
  ];
  const verts: GaitVertex[] = [];
  const parts: number[] = [];
  const at = (a: Float32Array, i: number) => a[i] as number;
  for (let i = 0; i < part.length; i++) {
    verts.push({
      x: at(pos, i * 3),
      y: at(pos, i * 3 + 1),
      z: at(pos, i * 3 + 2),
      normalX: at(normal, i * 3),
      normalY: at(normal, i * 3 + 1),
      attach: at(attach, i),
      weight: at(weight, i),
      spineX: at(frame, i * 4),
      spineY: at(frame, i * 4 + 1),
      rootX: at(frame, i * 4 + 2),
      rootY: at(frame, i * 4 + 3),
      motion: at(motion, i * 4),
      offset: at(motion, i * 4 + 1),
      gain: at(motion, i * 4 + 2),
      row: at(motion, i * 4 + 3),
      flutter: at(flutter, i),
    });
    parts.push(at(part, i));
  }
  geo.dispose();
  return { plan, verts, parts, genes: gaitOf(traits, plan) };
}

// The named bodies at the game's default detail, the random ones at low detail (the same parts and
// roots, fewer rings), which keeps the property tests quick.
const samples: Sample[] = genomes.map((g, i) => sampleOf(g, i < fixed.length ? 'medium' : 'low'));
const sampleOfSpecimen = (prefix: string): Sample => sampleOf(specimenGenome(prefix));

// Spread over the whole wrap, so the half- and quarter-rate cycles are sampled too, and off the
// multiples of π, where every full-rate wave crosses zero at once.
const PHASES = Array.from({ length: 8 }, (_, k) => (k * GAIT_WRAP) / 8 + 0.3 * k + 0.1);
const out = { x: 0, y: 0 };
const anchor = { x: 0, y: 0 };
const uniforms = (s: Sample, phase: number, beat: number, turn = 0): GaitUniforms => ({
  ...s.genes,
  phase,
  beat,
  turn,
});
const isPart = (v: GaitVertex): boolean => v.motion !== MOTION_RIGID && v.motion !== MOTION_BELL;
/** The furthest any vertex moves from its rest position. */
const reach = (s: Sample, u: GaitUniforms): number => {
  let m = 0;
  for (const v of s.verts) {
    gaitPosition(out, v, u);
    m = Math.max(m, Math.hypot(out.x - v.x, out.y - v.y));
  }
  return m;
};

describe('gaitPosition: guarantees', () => {
  it('detaches no part: every part vertex stays within 1.15 × its rest distance of its moved root', () => {
    let checked = 0;
    let worst = 0;
    for (const s of samples) {
      const extremes = [
        (phase: number) => uniforms(s, phase, 1),
        (phase: number) => ({ amp: 1, bend: 1, phase, beat: 1, turn: GAIT_CONSTANTS.TURN_MAX }),
        (phase: number) => uniforms(s, phase, 0, -GAIT_CONSTANTS.TURN_MAX),
      ];
      for (const phase of PHASES) {
        for (const make of extremes) {
          const u = make(phase);
          for (const v of s.verts) {
            if (!isPart(v)) continue;
            gaitPosition(out, v, u);
            attachPoint(anchor, v, u);
            const rest = Math.hypot(v.x - v.rootX, v.y - v.rootY, v.z);
            const moved = Math.hypot(out.x - anchor.x, out.y - anchor.y, v.z);
            worst = Math.max(worst, moved / Math.max(rest, 1e-6));
            if (moved > rest * 1.15 + 1e-6) expect.fail(`part vertex at ${moved} from ${rest}`);
            checked++;
          }
        }
      }
    }
    expect(samples).toHaveLength(500);
    expect(checked).toBeGreaterThan(1_000_000);
    expect(worst).toBeLessThanOrEqual(1.15);
  }, 60_000);

  it('roots every part on the body: a part base moves with the body vertex nearest it', () => {
    // The root a part turns about is carried exactly as the body is at that spine position.
    let worst = 0;
    for (const s of samples.slice(0, 60)) {
      for (const phase of PHASES) {
        const u = uniforms(s, phase, 1);
        for (const v of s.verts) {
          if (!isPart(v)) continue;
          attachPoint(anchor, v, u);
          const body = { ...v, x: v.rootX, y: v.rootY, weight: 0, flutter: 0 };
          body.motion = v.motion === MOTION_TENTACLE ? MOTION_BELL : MOTION_RIGID;
          gaitPosition(out, body, u);
          worst = Math.max(worst, Math.hypot(out.x - anchor.x, out.y - anchor.y));
        }
      }
    }
    expect(worst).toBeLessThan(1e-9);
  }, 30_000);

  it('moves no vertex more than 0.6 core radii, whatever the genes', () => {
    const { TURN_MAX } = GAIT_CONSTANTS;
    for (const s of samples) {
      PHASES.forEach((phase, k) => {
        // The swing grows with the beat, so full beat is the worst case.
        expect(reach(s, uniforms(s, phase, 1))).toBeLessThanOrEqual(0.6);
        if (k % 2 === 0) {
          for (const turn of [TURN_MAX, -TURN_MAX]) {
            expect(reach(s, { amp: 1, bend: 1, phase, beat: 1, turn })).toBeLessThanOrEqual(0.6);
          }
        }
      });
    }
  }, 60_000);

  it('only breathes at throttle 0: a slow idle at 20% of the moving amplitude', () => {
    expect(GAIT_CONSTANTS.BREATH).toBe(0.2);
    expect(effort(0)).toBe(0.2);
    let worst = 0;
    for (const s of samples) {
      let moving = 0;
      let resting = 0;
      for (const phase of PHASES) {
        const [go, rest] = [uniforms(s, phase, 1), uniforms(s, phase, 0)];
        moving = Math.max(moving, reach(s, go));
        resting = Math.max(resting, reach(s, rest));
        // Every amplitude is exactly a fifth: a part's angle and the body's wave or pulse.
        for (const v of s.verts) {
          if (isPart(v)) {
            worst = Math.max(worst, Math.abs(partAngle(v, rest) - partAngle(v, go) * 0.2));
          } else {
            gaitPosition(out, v, go);
            const [gx, gy] = [out.x - v.x, out.y - v.y];
            gaitPosition(out, v, rest);
            worst = Math.max(worst, Math.hypot(out.x - v.x - gx * 0.2, out.y - v.y - gy * 0.2));
          }
        }
      }
      // Turning a part by a fifth of the angle moves it by slightly more than a fifth of the chord.
      expect(resting).toBeLessThanOrEqual(moving * 0.2 * 1.05 + 1e-9);
      if (moving > 0.01) expect(resting).toBeGreaterThan(moving * 0.15);
    }
    expect(worst).toBeLessThan(1e-12);
    // At rest the phase runs at half the swimming rate: a slow idle.
    expect(advanceBeatPhase(0, 0, 0.1)).toBeCloseTo(advanceBeatPhase(0, 1, 0.1) / 2);
  }, 60_000);

  it('swims: a starter cell moves its tail clearly at full beat', () => {
    const s = samples[0] as Sample;
    let moving = 0;
    for (const phase of PHASES) moving = Math.max(moving, reach(s, uniforms(s, phase, 1)));
    expect(moving).toBeGreaterThan(0.05);
  });

  it('keeps the body still for a creature with no amplitude', () => {
    const s = samples[0] as Sample;
    for (const v of s.verts) {
      if (isPart(v)) continue;
      gaitPosition(out, v, { amp: 0, bend: 1, beat: 1, phase: 1, turn: 0 });
      expect(Math.hypot(out.x - v.x, out.y - v.y)).toBe(0);
    }
  });

  it('does not jump the pose when the frequency rises mid-run', () => {
    // The phase is integrated: after an hour, one 60 fps step with a higher frequency changes the
    // pose by a frame's worth of motion, not by the hour times the change of rate.
    let worst = 0;
    const second = { x: 0, y: 0 };
    for (const s of samples.slice(0, 120)) {
      let phase = 0;
      for (let i = 0; i < 216_000; i += 36)
        phase = advanceBeatPhase(phase, 1, 36 / 60, s.genes.freq, GAIT_WRAP);
      const after = uniforms(
        s,
        advanceBeatPhase(phase, 1, 1 / 60, s.genes.freq + 0.5, GAIT_WRAP),
        1,
      );
      const keep = uniforms(s, advanceBeatPhase(phase, 1, 1 / 60, s.genes.freq, GAIT_WRAP), 1);
      for (const v of s.verts) {
        gaitPosition(out, v, after);
        gaitPosition(second, v, keep);
        worst = Math.max(worst, Math.hypot(out.x - second.x, out.y - second.y));
      }
    }
    expect(worst).toBeLessThanOrEqual(0.05);
  }, 30_000);

  it('wraps the phase where every slower and faster cycle is continuous', () => {
    // Wings and bells run at half the beat, antenna sway at a quarter, setae at three times it.
    for (const s of samples.slice(0, 60)) {
      for (const v of s.verts) {
        const a = { x: 0, y: 0 };
        gaitPosition(a, v, uniforms(s, 1e-9, 1, 0.2));
        gaitPosition(out, v, uniforms(s, GAIT_WRAP - 1e-9, 1, 0.2));
        expect(Math.hypot(out.x - a.x, out.y - a.y)).toBeLessThan(1e-6);
      }
    }
  });

  it('repeats the tuning of the shader exactly', () => {
    const found = Object.fromEntries(
      [...vertexShader.matchAll(/const float (\w+) = ([\d.]+);/g)].map((m) => [m[1], Number(m[2])]),
    );
    for (const [name, value] of Object.entries(GAIT_CONSTANTS)) expect(found[name]).toBe(value);
    const classes = {
      MOTION_RIGID,
      MOTION_BEAT,
      MOTION_ANTENNA,
      MOTION_WING,
      MOTION_TENTACLE,
      MOTION_BELL,
    };
    for (const [name, value] of Object.entries(classes)) expect(found[name]).toBe(value);
  });
});

describe('gaitPosition: flexible bodies', () => {
  it('gives every kind of part its motion', () => {
    const seen = new Set<number>();
    for (const s of samples) for (const v of s.verts) seen.add(v.motion);
    for (const m of [
      MOTION_RIGID,
      MOTION_BEAT,
      MOTION_ANTENNA,
      MOTION_WING,
      MOTION_TENTACLE,
      MOTION_BELL,
    ]) {
      expect(seen.has(m), `motion ${m}`).toBe(true);
    }
  });

  it('runs the travelling wave along the curved spine: a worm undulates across its own normal', () => {
    const s = sampleOfSpecimen('28-');
    expect(s.plan.form.turn).toBeGreaterThan(1);
    const body = s.verts.filter((_v, i) => partKind(s.parts[i] as number) === PART_BODY);
    const u = uniforms(s, 1, 1);
    const directions: number[] = [];
    for (const v of body) {
      gaitPosition(out, v, u);
      const [dx, dy] = [out.x - v.x, out.y - v.y];
      const length = Math.hypot(dx, dy);
      if (length < 1e-3) continue;
      // Across the spine's normal where the vertex hangs, never along the spine.
      expect(Math.abs(dx * v.spineY - dy * v.spineX) / length).toBeLessThan(1e-6);
      directions.push(Math.atan2(v.spineY, v.spineX));
    }
    // The normal turns with the curve, so the wave is not a straight body's sideways sway.
    expect(Math.max(...directions) - Math.min(...directions)).toBeGreaterThan(1);
    // The crest travels rearward as the phase runs.
    const crest = (phase: number) => {
      let best = 0;
      let at = 0;
      for (const v of body) {
        gaitPosition(out, v, uniforms(s, phase, 1));
        const d = (out.x - v.x) * v.spineX + (out.y - v.y) * v.spineY;
        if (d > best) [best, at] = [d, v.attach];
      }
      return at;
    };
    expect(crest(1.3)).toBeGreaterThan(crest(1));
  });

  it('breathes a coil: its body swells and shrinks as the wave runs round it', () => {
    const s = sampleOfSpecimen('29-');
    expect(s.plan.form.mode).toBe(2);
    const body = s.verts.filter((_v, i) => partKind(s.parts[i] as number) === PART_BODY);
    const cx = body.reduce((a, v) => a + v.x, 0) / body.length;
    const cy = body.reduce((a, v) => a + v.y, 0) / body.length;
    const spread = (phase: number) => {
      let sum = 0;
      for (const v of body) {
        gaitPosition(out, v, uniforms(s, phase, 1));
        sum += Math.hypot(out.x - cx, out.y - cy);
      }
      return sum / body.length;
    };
    const values = Array.from({ length: 32 }, (_, k) => spread((k * TAU) / 32));
    const rest = body.reduce((a, v) => a + Math.hypot(v.x - cx, v.y - cy), 0) / body.length;
    expect((Math.max(...values) - Math.min(...values)) / rest).toBeGreaterThan(0.02);
  });

  it('rows legs in a metachronal wave: one module’s legs beat a fixed phase apart per segment', () => {
    // The phase of the tip's swing, from its first Fourier term over one beat.
    const phaseOf = (s: Sample, v: GaitVertex): number => {
      let [re, im] = [0, 0];
      for (let k = 0; k < 64; k++) {
        const phase = (k * TAU) / 64;
        const a = partAngle(v, uniforms(s, phase, 1));
        re += a * Math.cos(phase);
        im += a * Math.sin(phase);
      }
      return Math.atan2(im, re);
    };
    let pairs = 0;
    for (const s of samples.slice(0, 120)) {
      // The tip vertex of each left beating part.
      const tips = new Map<number, GaitVertex>();
      s.verts.forEach((v, i) => {
        const id = partId(s.parts[i] as number);
        const kind = partKind(s.parts[i] as number);
        if (v.motion !== MOTION_BEAT || kind === PART_SETA || v.weight !== 1 || v.gain <= 0) return;
        if (!tips.has(id)) tips.set(id, v);
      });
      const ids = [...tips.keys()];
      for (const a of ids) {
        for (const b of ids) {
          const [pa, pb] = [s.plan.appendages[a - 1], s.plan.appendages[b - 1]];
          const [va, vb] = [tips.get(a), tips.get(b)] as [GaitVertex, GaitVertex];
          if (!pa || !pb || a >= b || pa.module !== pb.module || pa.segment === pb.segment)
            continue;
          if (Math.abs(va.row - vb.row) > 1e-6) continue;
          const expected = -METACHRONAL * (pb.segment - pa.segment);
          const diff = phaseOf(s, vb) - phaseOf(s, va) - expected;
          expect(Math.abs(Math.atan2(Math.sin(diff), Math.cos(diff)))).toBeLessThan(1e-3);
          pairs++;
        }
      }
    }
    expect(pairs).toBeGreaterThan(20);
    // Sideways legs row from the base; a part along the axis whips from it.
    const rows = samples
      .flatMap((s) => s.verts.filter((v) => v.motion === MOTION_BEAT))
      .map((v) => v.row);
    expect(Math.max(...rows)).toBeGreaterThan(0.95);
    expect(Math.min(...rows)).toBeLessThan(0.2);
  });

  it('pulses a radial bell: a fast contraction, a slow recovery, and tentacles that lag', () => {
    const s = sampleOfSpecimen('24-');
    expect(s.plan.form.radial).toBe(1);
    expect(s.verts.every((v) => v.motion === MOTION_BELL || v.motion === MOTION_TENTACLE)).toBe(
      true,
    );
    const bell = s.verts.filter((v) => v.motion === MOTION_BELL);
    const size = (phase: number) => {
      let sum = 0;
      let rest = 0;
      for (const v of bell) {
        gaitPosition(out, v, uniforms(s, phase, 1));
        sum += Math.hypot(out.x, out.y);
        rest += Math.hypot(v.x, v.y);
      }
      return sum / rest;
    };
    // One bell cycle is two beats.
    const N = 200;
    const cycle = Array.from({ length: N }, (_, k) => size((k * 2 * TAU) / N));
    const least = Math.min(...cycle);
    expect(least).toBeLessThan(0.97);
    expect(Math.max(...cycle)).toBeCloseTo(1, 6);
    const squeezed = cycle.indexOf(least);
    // It contracts in under half the time it takes to recover.
    expect(squeezed).toBeLessThan((N - squeezed) / 2);
    expect(bellPulse(0)).toBe(0);
    // A tentacle's tip folds after the bell has contracted.
    const tip = s.verts.find((v) => v.motion === MOTION_TENTACLE && v.weight === 1) as GaitVertex;
    const fold = Array.from({ length: N }, (_, k) =>
      Math.abs(partAngle(tip, uniforms(s, (k * 2 * TAU) / N, 1))),
    );
    const folded = fold.indexOf(Math.max(...fold));
    expect(folded).toBeGreaterThan(squeezed + N / 20);
  });

  it('beats wings in a slow flap-and-glide cycle', () => {
    const s = sampleOfSpecimen('31-');
    const wing = s.verts.find((v) => v.motion === MOTION_WING && v.weight === 1) as GaitVertex;
    expect(wing).toBeDefined();
    const N = 200;
    // One wing cycle is two beats: slower than the parts that beat every cycle.
    const angles = Array.from({ length: N }, (_, k) =>
      partAngle(wing, uniforms(s, (k * 2 * TAU) / N, 1)),
    );
    const gliding = angles.filter((a) => Math.abs(a) < 1e-9).length;
    expect(gliding / N).toBeGreaterThanOrEqual(0.5);
    expect(Math.max(...angles.map(Math.abs))).toBeGreaterThan(0.05);
    const at = (phase: number) => partAngle(wing, uniforms(s, phase, 1));
    expect(at(0.5)).not.toBeCloseTo(at(0.5 + TAU), 3);
    expect(at(0.5)).toBeCloseTo(at(0.5 + 2 * TAU), 12);
    expect(wingFlap(0)).toBe(0);
  });

  it('flutters setae: a small, fast wiggle, shifted from bristle to bristle', () => {
    const s = sampleOf(ARCHETYPES.setose as Genome);
    const setae = s.verts.filter(
      (v, i) => partKind(s.parts[i] as number) === PART_SETA && v.flutter > 0,
    );
    expect(setae.length).toBeGreaterThan(20);
    const still = { x: 0, y: 0 };
    const wiggle = (v: GaitVertex, phase: number): number => {
      const u = uniforms(s, phase, 1);
      gaitPosition(out, v, u);
      gaitPosition(still, { ...v, flutter: 0 }, u);
      // Along the bristle's normal (its part turns it by well under a right angle).
      return (out.x - still.x) * v.normalX + (out.y - still.y) * v.normalY;
    };
    for (const v of setae.slice(0, 40)) {
      const series = Array.from({ length: 96 }, (_, k) => wiggle(v, (k * TAU) / 96));
      const peak = Math.max(...series.map(Math.abs));
      // Small: at most the flutter share of the bristle.
      expect(peak).toBeLessThanOrEqual(GAIT_CONSTANTS.FLUTTER * v.flutter + 1e-9);
      expect(peak).toBeGreaterThan(0);
      // Fast: three wiggles a beat.
      let crossings = 0;
      for (let k = 1; k < series.length; k++)
        if ((series[k - 1] as number) * (series[k] as number) < 0) crossings++;
      expect(crossings).toBeGreaterThanOrEqual(5);
    }
    const shifts = new Set(setae.map((v) => v.weight.toFixed(3)));
    expect(shifts.size).toBeGreaterThan(3);
  });

  it('trails antennae behind a turn by about 0.3 s', () => {
    // A heading step of 0.4 rad: the trailing heading closes 63% of it in 0.3 s at 60 fps.
    let trail = 0;
    const heading = 0.4;
    for (let t = 0; t < 18; t++) trail = trailHeading(trail, heading, 1 / 60);
    expect(TURN_LAG_S).toBe(0.3);
    expect(turnLag(trail, heading)).toBeCloseTo(-0.4 * Math.exp(-1), 6);
    // Across the ±π seam it goes the short way round.
    expect(trailHeading(3, -3, 10)).toBeCloseTo(-3, 6);
    // A full-gain antenna's tip turns by the lag, so it points where the heading was.
    const s = samples.find((x) => x.verts.some((v) => v.motion === MOTION_ANTENNA)) as Sample;
    const tip = s.verts.find((v) => v.motion === MOTION_ANTENNA && v.weight === 1) as GaitVertex;
    const turn = turnLag(trail, heading);
    const still = partAngle(tip, uniforms(s, 1, 1, 0));
    const turning = partAngle(tip, uniforms(s, 1, 1, turn));
    expect(turning - still).toBeCloseTo(Math.abs(tip.gain) * turn, 9);
    expect(Math.abs(tip.gain)).toBeGreaterThan(0);
  });
});
