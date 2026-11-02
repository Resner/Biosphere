import { describe, expect, it } from 'vitest';
import { express } from '../genome/express';
import { RARITY_TIERS, type RarityTier } from '../genome/rarity';
import { starterGenome } from '../genome/starter';
import { materialParams } from './material-params';
import { creatureMaterial } from './materials';
import fragmentShader from './shaders/creature.frag.glsl?raw';
import {
  DETAIL_FADE,
  DETAIL_LINE,
  DETAIL_SIZE,
  detailFade,
  FINE_FADE,
  fineFade,
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
  it('pins the fade-in band: nothing below 6 px a feature, all of it from 10 px (M6c T8)', () => {
    expect(DETAIL_FADE).toEqual({ from: 6, to: 10 });
    expect(detailFade(0)).toBe(0);
    expect(detailFade(6)).toBe(0);
    expect(detailFade(10)).toBe(1);
    expect(detailFade(40)).toBe(1);
    expect(detailFade(8)).toBeCloseTo(0.5, 6);
    let last = 0;
    for (let px = 0; px <= 12; px += 0.25) {
      expect(detailFade(px)).toBeGreaterThanOrEqual(last);
      last = detailFade(px);
    }
  });

  it('keeps the fine detail out of small bodies: no cell under 6 px, no pore under 86 px a radius', () => {
    // Firefox drew the cell texture of a body at default zoom as a coarse pattern (M6c T8): a cell
    // starts at 6 px (30 px a core radius), a pore at 86 px a core radius.
    expect(detailFade(DETAIL_SIZE.cell * 30)).toBe(0);
    expect(detailFade(DETAIL_SIZE.pore * 85)).toBe(0);
    expect(detailFade(DETAIL_SIZE.cell * 50)).toBe(1);
    for (const size of Object.values(DETAIL_SIZE)) expect(size).toBeGreaterThan(0);
  });
});

describe('fineFade', () => {
  it('fades a line or tube narrower than 1.5 px instead of drawing it (M6c T8)', () => {
    expect(FINE_FADE).toEqual({ from: 0.75, to: 1.5 });
    expect(fineFade(0.5)).toBe(0);
    expect(fineFade(0.75)).toBe(0);
    expect(fineFade(1.5)).toBe(1);
    expect(fineFade(1.125)).toBeCloseTo(0.5, 6);
    // A cell wall is about DETAIL_LINE.cell of a cell wide: at 10 px a cell it is still sub-pixel.
    expect(fineFade(DETAIL_LINE.cell * 10)).toBe(0);
    expect(fineFade(DETAIL_LINE.cell * 24)).toBe(1);
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
    expect(Number(defines.FINE_FROM)).toBe(FINE_FADE.from);
    expect(Number(defines.FINE_TO)).toBe(FINE_FADE.to);
    expect(Number(defines.LINE_CELL)).toBe(DETAIL_LINE.cell);
    expect(Number(defines.LINE_VEIN)).toBe(DETAIL_LINE.vein);
    expect(fragmentShader).toMatch(/smoothstep\(FINE_FROM, FINE_TO, widthPx\)/);
    expect(material.uniforms.uGlint?.value).toBe(0.5);
    // A clone keeps the defines, so every view draws the same detail.
    expect(material.clone().defines).toEqual(defines);
    material.dispose();
  });

  it('runs at high precision, whatever precision the renderer settles on (M6c T8)', () => {
    // three.js prefixes the precision it detected; a driver that reports no highp gets mediump,
    // which turns the hash noise into blocks and the wall's derivatives into steps.
    const material = creatureMaterial(materialParams(express(starterGenome())), 0.5);
    expect(
      material.fragmentShader.startsWith('precision highp float;\nprecision highp int;\n'),
    ).toBe(true);
    material.dispose();
  });

  it('draws no line or tube narrower than 1.5 px: the walls, the gut, the limbs and the setules fade (M6c T8)', () => {
    // The cell texture's and the vein network's walls by their own width, the gut and the setules by
    // their width on screen.
    expect(fragmentShader).toMatch(/float fine\(float widthPx\)/);
    expect(fragmentShader).toMatch(/fine\(LINE_CELL \* DETAIL_CELL \* px\)/);
    expect(fragmentShader).toMatch(/fine\(LINE_VEIN \* DETAIL_VEIN \* px\)/);
    expect(fragmentShader).toMatch(/kind == PART_GUT[\s\S]*?alpha \*= fine\(2\.0 \* across\)/);
    expect(fragmentShader).toMatch(/kind == PART_SETULE[\s\S]*?alpha = SETULE_ALPHA \* fine\(/);
    // Limbs, fringe and pearls too: a sub-pixel antenna came and went as the zoom moved it.
    expect(fragmentShader).toMatch(/if \(kind == 1\) alpha \*= fine\(2\.0 \* across\);/);
    // A tube's width reads the smaller of its two turns' rates, so its wrap band is no thin rod.
    expect(fragmentShader).toMatch(/min\(rate, turnRate\)/);
    // No NaN: a normal is never normalised from nothing, and a facing never passes 1.
    expect(fragmentShader).not.toMatch(/normalize\(vNormal\)/);
    expect(fragmentShader).toMatch(/float z = min\(abs\(normal\.z\), 1\.0\);/);
    // The segment walls come from the continuous wall coordinate: no floor before a derivative.
    expect(fragmentShader).toMatch(/fwidth\(vWall\)/);
    expect(fragmentShader).not.toMatch(/(fwidth|dFdx|dFdy)\([^)]*(floor|fract)/);
  });
});
