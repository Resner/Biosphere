import { describe, expect, it } from 'vitest';
import type { BodyPlan } from '../genome/develop';
import { starterGenome } from '../genome/starter';
import { RULES } from '../sim/rules';
import { stations } from './creature-loft';
import {
  buildCreatureGeometry,
  FRINGE_TAG,
  meshDetail,
  PART_APPENDAGE,
  PART_SETA,
  partId,
  partKind,
} from './creature-mesh';
import { attr, gallery, LODS, plan, planOf, randoms } from './creature-mesh-kit';
import { MOUTH_PART_ID, MOUTH_SPAN, mouthFeature } from './creature-mouth';
import fragmentShader from './shaders/creature.frag.glsl?raw';
import vertexShader from './shaders/creature.vert.glsl?raw';
import { centreLine } from './spine';

// Pass 1's glass again, limbs of the same glass and a real mouth (M6c T6, ADR 0043). The look is
// judged on the gallery (`m6c-glass.spec.ts`); these pin the shader's model and the mouth's feature.

const constant = (name: string): string | undefined =>
  fragmentShader.match(new RegExp(`const (?:float|vec2) ${name} = ([^;]+);`))?.[1];

describe("the glass is pass 1's (ADR 0043)", () => {
  it('lights the face with pass 1 core and its soft fresnel rim, with no haze layer', () => {
    expect(constant('FACE')).toBe('vec2(0.15, 0.3)');
    expect(constant('RIM')).toBe('1.8');
    expect(constant('BACK')).toBe('0.9');
    expect(fragmentShader).toMatch(/float fres = pow\(1\.0 - z, mix\(2\.0, 1\.4, uMembrane\)\);/);
    expect(fragmentShader).toMatch(/float rim = fres;/);
    expect(fragmentShader).toMatch(
      /vec3 col = uCore \* \(FACE\.x \+ FACE\.y \* z\) \+ uRim \* \(\(rim \* RIM \+ back \* BACK\) \* uRimStrength\);/,
    );
    // M6b T3's steep hairline rim is gone; slim bodies keep their edge.
    expect(fragmentShader).not.toContain('RIM_POWER');
    expect(fragmentShader).toMatch(/const float RIM_MIN_PX = /);
    for (const name of ['HAZE', 'SCATTER', 'HALO']) expect(fragmentShader).not.toContain(name);
  });

  it('draws limbs, membranes and setae as the same glass: a thin limb all rim', () => {
    expect(fragmentShader).toMatch(/if \(kind == 1\) rim = mix\(rim, 1\.0, thin\);/);
    // A limb takes the body's colour model unchanged: its branch sets neither colour nor alpha.
    const limb = fragmentShader.slice(
      fragmentShader.indexOf('} else if (kind == 1) {'),
      fragmentShader.indexOf('} else if (kind == 2) {'),
    );
    expect(limb).not.toMatch(/col =|alpha =/);
    expect(fragmentShader).toMatch(
      /col = uCore \* \(FACE\.x \+ FACE\.y \* z\) \+ uRim \* \(edgeLight \* RIM \* uRimStrength\);/,
    );
    expect(fragmentShader).toMatch(/col = uCore \* FACE\.x \+ uRim \* \(RIM \* uRimStrength\);/);
  });

  it('paints the mouth disc as body glass, with no dark fill', () => {
    expect(fragmentShader).toMatch(/bool hull = kind == 0 \|\| kind == 2 \|\| kind == 3;/);
    expect(fragmentShader).not.toContain('kind == 3)');
    expect(fragmentShader).not.toMatch(/vec3\(0\.03, 0\.02, 0\.025\)/);
    expect(fragmentShader).not.toContain('LIP');
  });

  it('draws fringe as fine, faint cilia', () => {
    expect(fragmentShader).toMatch(/const float FRINGE_TAG = 4\.0;/);
    expect(Number(constant('FRINGE_ALPHA'))).toBeLessThanOrEqual(0.4);
    expect(Number(constant('FRINGE_LUMA'))).toBeLessThan(1);
  });

  it('keeps a part number whole across a triangle, so no kind is blended from two', () => {
    for (const shader of [vertexShader, fragmentShader]) {
      expect(shader).toMatch(/^flat varying float vPart;/m);
    }
  });
});

describe('fringe parts carry their tag (M6c T3, T6)', () => {
  it('tags every vertex of a fringe part, and no other part', () => {
    const bodies = [...gallery.values(), ...randoms.slice(0, 200)].map(planOf);
    let fringed = 0;
    for (const p of bodies) {
      if (!p.appendages.some((a) => a.fringe)) continue;
      fringed++;
      const g = buildCreatureGeometry(p, 'high');
      const [uv, part] = [attr(g, 'uv'), attr(g, 'aPart')];
      for (let i = 0; i < part.length; i++) {
        const v = part[i] as number;
        const id = partId(v);
        if (partKind(v) !== PART_APPENDAGE || id === MOUTH_PART_ID) continue;
        const a = p.appendages[id - 1];
        const u = uv[i * 2] as number;
        if (a?.fringe) expect(u).toBeGreaterThanOrEqual(FRINGE_TAG);
        else expect(u).toBeLessThan(FRINGE_TAG);
      }
      g.dispose();
    }
    expect(fringed).toBeGreaterThan(10);
  });
});

/** The feature's vertices in the frame of the body's front: along (forward) and across. */
function featureOf(p: BodyPlan, lod: (typeof LODS)[number] = 'high') {
  const f = mouthFeature(p, stations(p, centreLine(p.segments), meshDetail(p, lod)));
  const g = buildCreatureGeometry(p, lod);
  const [position, part] = [attr(g, 'position'), attr(g, 'aPart')];
  const kinds = new Set<number>();
  const points: { along: number; across: number; r: number }[] = [];
  const [fx, fy] = [Math.cos(f.heading), Math.sin(f.heading)];
  for (let i = 0; i < part.length; i++) {
    if (partId(part[i] as number) !== MOUTH_PART_ID) continue;
    kinds.add(partKind(part[i] as number));
    const [x, y] = [position[i * 3] as number, position[i * 3 + 1] as number];
    const [dx, dy] = [x - f.x, y - f.y];
    points.push({ along: dx * fx + dy * fy, across: -dx * fy + dy * fx, r: Math.hypot(x, y) });
  }
  g.dispose();
  return { f, kinds, points };
}

describe("the mouth's feature (M6c T6)", () => {
  const bodies = [...gallery.values(), ...randoms.slice(0, 300)].map(planOf);

  it('sits at the front, spans at most 35% of the body, and stays within the bounds', () => {
    for (const p of bodies) {
      const { f, points } = featureOf(p);
      expect(points.length).toBeGreaterThan(0);
      expect(f.span).toBeLessThanOrEqual(MOUTH_SPAN * f.width + 1e-9);
      for (const q of points) {
        expect(Math.abs(q.across)).toBeLessThanOrEqual(f.span / 2 + 1e-6);
        expect(q.r).toBeLessThanOrEqual(RULES.develop.caps.bounds + 1e-6);
      }
    }
  });

  it('is a funnel ringed by cilia on a filter mouth, and a pair of mandibles on a jaw', () => {
    let [filters, jaws] = [0, 0];
    for (const p of bodies) {
      const { f, kinds, points } = featureOf(p);
      if (p.mouth.type >= RULES.develop.jawStart) {
        jaws++;
        expect(f.kind).toBe('jaw');
        // Two tubes, no cilia, reaching ahead of the body's front.
        expect([...kinds]).toEqual([PART_APPENDAGE]);
        expect(Math.max(...points.map((q) => q.along))).toBeGreaterThan(0);
        expect(points.some((q) => q.across > 0) && points.some((q) => q.across < 0)).toBe(true);
      } else {
        filters++;
        expect(f.kind).toBe('filter');
        expect(kinds).toEqual(new Set([PART_APPENDAGE, PART_SETA]));
        const g = buildCreatureGeometry(p, 'high');
        const part = attr(g, 'aPart');
        let cilia = 0;
        for (const v of part) if (v === MOUTH_PART_ID * 16 + PART_SETA) cilia++;
        // Three vertices a cilium, 5 to 9 of them unless the bounds cut some.
        expect(cilia % 3).toBe(0);
        expect(cilia / 3).toBeLessThanOrEqual(9);
        g.dispose();
      }
    }
    expect(filters).toBeGreaterThan(20);
    expect(jaws).toBeGreaterThan(20);
  });

  it('grows with the mouth size gene', () => {
    const base = plan(starterGenome());
    const sized = (size: number): number => {
      const type = 0.2;
      const p: BodyPlan = {
        ...base,
        mouth: { ...base.mouth, type, radius: size * (RULES.develop.mouthRadiusBase - type) },
      };
      return mouthFeature(p, stations(p, centreLine(p.segments), meshDetail(p, 'high'))).span;
    };
    expect(sized(0.2)).toBeLessThan(sized(0.6));
    expect(sized(0.6)).toBeLessThan(sized(1));
  });

  it('is drawn on every level of detail', () => {
    for (const p of bodies.slice(0, 40)) {
      for (const lod of LODS) expect(featureOf(p, lod).points.length).toBeGreaterThan(0);
    }
  });
});
