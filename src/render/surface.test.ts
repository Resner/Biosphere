import { describe, expect, it } from 'vitest';
import { express } from '../genome/express';
import { RARITY_TIERS, type RarityTier } from '../genome/rarity';
import { starterGenome } from '../genome/starter';
import { materialParams } from './material-params';
import { creatureMaterial } from './materials';
import fragmentShader from './shaders/creature.frag.glsl?raw';
import {
  DETAIL_FADE,
  DETAIL_SIZE,
  detailFade,
  GLINT_TIERS,
  glintsFor,
  MAX_GLINTS,
} from './surface';

const TIERS = RARITY_TIERS.map(([tier]) => tier);
const IRIDESCENCE = [0, 0.2, 0.55, 0.8, 1];

describe('glintsFor', () => {
  it('gives common 0-1 dim glints, uncommon up to 3, rare up to 8 and exotic up to 16', () => {
    const range = (tier: RarityTier) => IRIDESCENCE.map((i) => glintsFor(tier, i).count);
    expect(Math.min(...range('common'))).toBe(0);
    expect(Math.max(...range('common'))).toBe(1);
    expect(Math.max(...range('uncommon'))).toBe(3);
    expect(Math.max(...range('rare'))).toBe(8);
    expect(Math.max(...range('exotic'))).toBe(16);
    expect(MAX_GLINTS).toBe(16);
    // Common glints are dim: well under the exotic's reference 04/05 intensity.
    expect(glintsFor('common', 1).brightness).toBeLessThanOrEqual(
      0.4 * glintsFor('exotic', 0).brightness,
    );
  });

  it('never gives fewer or dimmer glints to a rarer tier, whatever the iridescence', () => {
    for (let k = 1; k < TIERS.length; k++) {
      const [lower, higher] = [TIERS[k - 1] as RarityTier, TIERS[k] as RarityTier];
      for (const a of IRIDESCENCE) {
        for (const b of IRIDESCENCE) {
          const [lo, hi] = [glintsFor(lower, a), glintsFor(higher, b)];
          expect(hi.count, `${lower} ${a} → ${higher} ${b}`).toBeGreaterThanOrEqual(lo.count);
          expect(hi.brightness).toBeGreaterThanOrEqual(lo.brightness);
          expect(hi.size).toBeGreaterThanOrEqual(lo.size);
        }
      }
    }
  });

  it('adds glints with iridescence within a tier, and is pure', () => {
    for (const tier of TIERS) {
      const counts = IRIDESCENCE.map((i) => glintsFor(tier, i).count);
      for (let k = 1; k < counts.length; k++)
        expect(counts[k]).toBeGreaterThanOrEqual(counts[k - 1] as number);
      expect(glintsFor(tier, 0.55)).toEqual(glintsFor(tier, 0.55));
    }
    // Out-of-range iridescence is clamped, never more than the tier allows.
    expect(glintsFor('exotic', 5).count).toBe(16);
    expect(glintsFor('common', -1).count).toBe(0);
    expect(Object.keys(GLINT_TIERS).sort()).toEqual([...TIERS].sort());
  });
});

describe('detailFade', () => {
  it('pins the fade-out band: nothing below 2 px, all of it from 5 px', () => {
    expect(DETAIL_FADE).toEqual({ from: 2, to: 5 });
    expect(detailFade(0)).toBe(0);
    expect(detailFade(2)).toBe(0);
    expect(detailFade(5)).toBe(1);
    expect(detailFade(40)).toBe(1);
    expect(detailFade(3.5)).toBeCloseTo(0.5, 6);
    let last = 0;
    for (let px = 0; px <= 8; px += 0.25) {
      expect(detailFade(px)).toBeGreaterThanOrEqual(last);
      last = detailFade(px);
    }
  });

  it('keeps the fine detail out of small bodies, so nothing finer than 2 px is drawn', () => {
    // A newborn body at default zoom (960×540) is about 38 px a core radius: its cells show, its
    // pores only hint. A body drawn at 15 px (near the low level of detail) keeps only a hint of
    // its cells, and below 28 px no pore is drawn at all.
    expect(detailFade(DETAIL_SIZE.pore * 38)).toBeLessThan(0.3);
    expect(detailFade(DETAIL_SIZE.pore * 28)).toBe(0);
    expect(detailFade(DETAIL_SIZE.cell * 15)).toBeLessThan(0.5);
    // The gallery's specimens (32 px a core radius) show the cells in full.
    expect(detailFade(DETAIL_SIZE.cell * 32)).toBe(1);
    for (const size of Object.values(DETAIL_SIZE)) expect(size).toBeGreaterThan(0);
  });
});

describe('the creature shader', () => {
  it('fades its detail over the same band and sizes, given as defines', () => {
    const material = creatureMaterial(materialParams(express(starterGenome())), 0.5);
    const defines = material.defines as Record<string, string>;
    expect(Number(defines.DETAIL_FROM)).toBe(DETAIL_FADE.from);
    expect(Number(defines.DETAIL_TO)).toBe(DETAIL_FADE.to);
    expect(Number(defines.DETAIL_PORE)).toBe(DETAIL_SIZE.pore);
    expect(Number(defines.DETAIL_CELL)).toBe(DETAIL_SIZE.cell);
    expect(Number(defines.DETAIL_VEIN)).toBe(DETAIL_SIZE.vein);
    expect(Number(defines.DETAIL_FLAW)).toBe(DETAIL_SIZE.flaw);
    expect(fragmentShader).toMatch(/smoothstep\(DETAIL_FROM, DETAIL_TO, size \* px\)/);
    expect(material.uniforms.uGlint?.value).toBe(0.5);
    // A clone keeps the defines, so every view draws the same detail.
    expect(material.clone().defines).toEqual(defines);
    material.dispose();
  });
});
