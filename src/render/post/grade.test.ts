import { describe, expect, it } from 'vitest';
import postFragment from '../shaders/post.frag.glsl?raw';
import { POST_LOOK } from './chain';
import { GRADE, gradeHighlights } from './grade';

// No white clipping (M6b T4, ADR 0034): the grade's shoulder rolls highlights off to a cool
// near-white whose red stays below 245, however bright the scene and its bloom, except on a
// glint's hot point, which still reaches white.

const byte = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 255);
const luma = ([r, g, b]: readonly number[]): number =>
  0.2126 * (r as number) + 0.7152 * (g as number) + 0.0722 * (b as number);

describe('the grade', () => {
  it('keeps every non-glint pixel short of solid white, however bright', () => {
    for (const v of [0.8, 1, 1.3, 2, 3, 5, 10, 100]) {
      // Inside a bright cloud of setae: the scene is a stroke's (about 1.5) all round, the rest bloom.
      const out = gradeHighlights([v, v, v], 1.5, 1.2);
      expect(Math.min(...out.map(byte)), `${v}`).toBeLessThan(245);
    }
  });

  it('rolls off to a cool near-white: blue above green above red', () => {
    const [r, g, b] = gradeHighlights([50, 50, 50], 1.5, 1.5);
    expect(b).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(r);
    expect(byte(b)).toBeGreaterThanOrEqual(250);
  });

  it("lets a glint's hot point reach white", () => {
    const out = gradeHighlights([4, 4, 4], 2.4, 0.3);
    expect(Math.min(...out.map(byte))).toBeGreaterThanOrEqual(250);
    expect(luma(out.map(byte))).toBeGreaterThanOrEqual(250);
  });

  it('leaves tones below the knee alone and stays monotonic above it', () => {
    expect(gradeHighlights([0.5, 0.3, 0.7], 0.5, 0)).toEqual([0.5, 0.3, 0.7]);
    let last = 0;
    for (let v = 0; v <= 6; v += 0.05) {
      const [r] = gradeHighlights([v, v, v], 1, 1);
      expect(r).toBeGreaterThanOrEqual(last);
      last = r;
    }
  });

  it('is the shoulder the composite shader draws', () => {
    // The film grain adds up to half its amplitude after the grade.
    expect(GRADE.white[0] + POST_LOOK.grain / 2).toBeLessThan(245 / 255);
    expect(postFragment).toContain('uniform vec3 uWhite;');
    expect(postFragment).toContain('uniform vec2 uHot;');
    expect(postFragment).toContain('uniform vec2 uAround;');
    expect(postFragment).toMatch(/smoothstep\(uHot\.x, uHot\.y, dot\(scene, LUMA\) - around\)/);
  });
});
