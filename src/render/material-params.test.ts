import { describe, expect, it } from 'vitest';
import { decodeGenome } from '../genome/codec';
import { express, type Traits } from '../genome/express';
import { GENOME_BYTES } from '../genome/karyotype';
import { starterGenome } from '../genome/starter';
import { createRng, seedFromString } from '../sim/prng';
import {
  luminance,
  MIN_RIM_LUMINANCE,
  materialParams,
  ORGAN_HUES,
  PATTERN,
} from './material-params';

const rng = createRng(seedFromString('material-params'), 'bytes');
const randomTraits = (): Traits =>
  express(decodeGenome(Uint8Array.from({ length: GENOME_BYTES }, () => rng.nextU32() & 0xff)));
const base = express(starterGenome());
const withColour = (
  colour: Partial<Traits['colour']>,
  skin: Partial<Traits['skin']> = {},
): Traits => ({
  ...base,
  colour: { ...base.colour, ...colour },
  skin: { ...base.skin, ...skin },
});
const hsvSaturation = ([r, g, b]: readonly number[]): number => {
  const max = Math.max(r as number, g as number, b as number);
  return max === 0 ? 0 : (max - Math.min(r as number, g as number, b as number)) / max;
};

describe('materialParams', () => {
  it('maps the pattern alleles to one shader kind', () => {
    expect(materialParams(withColour({ pattern: ['none'] })).pattern).toBe(PATTERN.none);
    expect(materialParams(withColour({ pattern: ['rings'] })).pattern).toBe(PATTERN.rings);
    expect(materialParams(withColour({ pattern: ['spots'] })).pattern).toBe(PATTERN.spots);
    expect(materialParams(withColour({ pattern: ['stripes'] })).pattern).toBe(PATTERN.stripes);
    expect(materialParams(withColour({ pattern: ['bands'] })).pattern).toBe(PATTERN.bands);
    expect(materialParams(withColour({ pattern: ['spots', 'stripes'] })).pattern).toBe(
      PATTERN.spotsStripes,
    );
    expect(materialParams(withColour({ pattern: ['stripes', 'spots'] })).pattern).toBe(
      PATTERN.spotsStripes,
    );
  });

  it('gives the pattern a whole number of repeats so it closes around the body', () => {
    for (const s of [0, 0.25, 0.5, 1]) {
      const n = materialParams(withColour({ patternScale: s })).patternCount;
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(12);
    }
    const lo = materialParams(withColour({ patternScale: 0 })).patternCount;
    const hi = materialParams(withColour({ patternScale: 1 })).patternCount;
    expect(hi).toBeGreaterThan(lo);
  });

  it("keeps an albino's organs one pink whatever its rarity tier", () => {
    const albino = withColour({ hue: 0.3, saturation: 1, value: 0.9, albino: 'albino' });
    for (const tier of ['common', 'uncommon', 'rare', 'exotic'] as const) {
      const p = materialParams(albino, tier);
      expect(p.organ2).toEqual(p.organ);
      expect(p.vivid).toBe(0);
    }
  });

  it('turns an albino body pale pink and a pale one only washed out', () => {
    const vivid = { hue: 0.6, saturation: 1, value: 0.9 };
    const albino = materialParams(withColour({ ...vivid, albino: 'albino' }));
    expect(albino.saturation).toBeLessThanOrEqual(0.1);
    expect(hsvSaturation(albino.core)).toBeLessThanOrEqual(0.12);
    const [r, g, b] = albino.rim;
    expect(r).toBeGreaterThan(g);
    expect(r).toBeGreaterThanOrEqual(b); // pink: red leads, blue above green
    expect(b).toBeGreaterThan(g);
    const pale = materialParams(withColour({ ...vivid, albino: 'pale' }));
    expect(pale.saturation).toBeGreaterThan(0.1);
    expect(pale.saturation).toBeLessThan(1);
    expect(materialParams(withColour({ ...vivid, albino: 'normal' })).saturation).toBe(1);
  });

  it('shows iridescence only when expressed', () => {
    expect(materialParams(withColour({}, { iridescence: 'plain' })).iridescence).toBe(0);
    const irid = materialParams(withColour({}, { iridescence: 'iridescent' })).iridescence;
    const oil = materialParams(withColour({}, { iridescence: 'oil' })).iridescence;
    expect(irid).toBeGreaterThan(0);
    expect(oil).toBeGreaterThan(irid);
    expect(oil).toBeLessThanOrEqual(1);
  });

  it('glows only when expressed, with its own hue and a pulse for the pulsing allele', () => {
    const off = materialParams(withColour({ luminescence: 'off', lumHue: 0.3 }));
    expect(off.luminescence).toBe(0);
    const on = materialParams(withColour({ luminescence: 'on', lumHue: 0.3 }));
    const pulse = materialParams(withColour({ luminescence: 'pulse', lumHue: 0.3 }));
    expect(on.luminescence).toBeGreaterThan(0);
    expect(on.lumPulse).toBe(0);
    expect(pulse.luminescence).toBeGreaterThan(0);
    expect(pulse.lumPulse).toBeGreaterThan(0);
    const other = materialParams(withColour({ luminescence: 'on', lumHue: 0.8 }));
    expect(other.lumColor).not.toEqual(on.lumColor);
    // Green (hue 0.3) glows green; the glow is bright.
    expect(on.lumColor[1]).toBeGreaterThan(on.lumColor[0]);
    expect(on.lumColor[1]).toBeGreaterThan(on.lumColor[2]);
  });

  it('maps translucency, membrane and plating monotonically into their ranges', () => {
    const t0 = materialParams(withColour({}, { translucency: 0 }));
    const t1 = materialParams(withColour({}, { translucency: 1 }));
    expect(t1.translucency).toBeGreaterThan(t0.translucency);
    expect(t0.translucency).toBeGreaterThanOrEqual(0);
    expect(t1.translucency).toBeLessThanOrEqual(1);
    const m0 = materialParams(withColour({}, { membrane: 0 })).membrane;
    const m1 = materialParams(withColour({}, { membrane: 1 })).membrane;
    expect(m1).toBeGreaterThan(m0);
    const p0 = materialParams(withColour({}, { plating: 0 })).plating;
    const p1 = materialParams(withColour({}, { plating: 1 })).plating;
    expect(p0).toBeGreaterThanOrEqual(0.5);
    expect(p1).toBe(1);
  });

  it('keeps every body readable: the rim is bright and stays lit whatever the colour', () => {
    for (let i = 0; i < 1000; i++) {
      const p = materialParams(randomTraits());
      expect(luminance(p.rim)).toBeGreaterThanOrEqual(MIN_RIM_LUMINANCE - 1e-9);
      expect(p.rimStrength).toBeGreaterThanOrEqual(1);
      for (const c of [...p.core, ...p.rim, ...p.lumColor]) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
      }
    }
  });

  it('gives genomes of different hue different colours', () => {
    const red = materialParams(withColour({ hue: 0, saturation: 1, value: 1 }));
    const blue = materialParams(withColour({ hue: 0.6, saturation: 1, value: 1 }));
    expect(red.core).not.toEqual(blue.core);
    expect(red.core[0]).toBeGreaterThan(red.core[2]);
    expect(blue.core[2]).toBeGreaterThan(blue.core[0]);
  });

  it('keeps every shell nearly clear: a saturation of at most 0.15 for every genome (M6 T12)', () => {
    const vivid = [0, 0.3, 0.6, 0.9].map((hue) => withColour({ hue, saturation: 1, value: 1 }));
    const dark = withColour({ hue: 0.7, saturation: 1, value: 0 });
    for (const t of [...vivid, dark, ...Array.from({ length: 1000 }, randomTraits)]) {
      const p = materialParams(t);
      expect(hsvSaturation(p.core)).toBeLessThanOrEqual(0.15 + 1e-9);
      expect(hsvSaturation(p.rim)).toBeLessThanOrEqual(0.15 + 1e-9);
    }
  });

  it('makes every shell silvery pale blue, with a hint of the gene hue (M6 T13)', () => {
    for (const value of [0, 0.5, 1]) {
      const grey = materialParams(withColour({ saturation: 0, value }));
      for (const c of [grey.core, grey.rim]) {
        expect(c[2]).toBeGreaterThan(c[0]);
        expect(c[2]).toBeGreaterThanOrEqual(c[1]);
        expect(hsvSaturation(c)).toBeGreaterThan(0.02);
      }
    }
    // A vivid gene still tints its shell: a red gene's shell leans red, a green one's green.
    const red = materialParams(withColour({ hue: 0, saturation: 1, value: 1 }));
    expect(red.rim[0]).toBeGreaterThan(red.rim[2]);
    const green = materialParams(withColour({ hue: 0.33, saturation: 1, value: 1 }));
    expect(green.rim[1]).toBeGreaterThan(green.rim[0]);
  });

  it('puts the pigment inside: the organs carry the hue gene at the gene saturation', () => {
    const hueOf = ([r, g, b]: readonly number[]): number => {
      const [max, min] = [Math.max(r ?? 0, g ?? 0, b ?? 0), Math.min(r ?? 0, g ?? 0, b ?? 0)];
      const d = max - min;
      if (d === 0) return 0;
      const h =
        max === r
          ? ((g ?? 0) - (b ?? 0)) / d
          : max === g
            ? 2 + ((b ?? 0) - (r ?? 0)) / d
            : 4 + ((r ?? 0) - (g ?? 0)) / d;
      return (((h / 6) % 1) + 1) % 1;
    };
    for (const t of Array.from({ length: 500 }, randomTraits)) {
      const p = materialParams(t);
      const albino = t.colour.albino === 'albino';
      expect(hsvSaturation(p.organ)).toBeCloseTo(albino ? 0.45 : p.saturation, 6);
      expect(Math.max(...p.organ)).toBeGreaterThanOrEqual(0.75 - 1e-9);
      if (p.saturation > 0.05) {
        const d = Math.abs(hueOf(p.organ) - (albino ? 0.96 : t.colour.hue));
        expect(Math.min(d, 1 - d)).toBeLessThan(1e-6);
      }
      // Oil droplets are lipid at the same saturation, their hue turned toward amber (0.11).
      expect(hsvSaturation(p.oil)).toBeCloseTo(hsvSaturation(p.organ), 6);
      if (p.saturation > 0.05) {
        const arc = (a: number, b: number) => Math.min(Math.abs(a - b), 1 - Math.abs(a - b));
        const organHue = hueOf(p.organ);
        expect(arc(hueOf(p.oil), 0.11)).toBeLessThanOrEqual(arc(organHue, 0.11) + 1e-6);
        expect(arc(hueOf(p.oil), organHue)).toBeLessThanOrEqual(0.5 * 0.4 + 1e-6);
      }
    }
    // A vivid gene: a saturated inside under a near-clear shell.
    const vivid = materialParams(withColour({ hue: 0.8, saturation: 0.9, value: 0.8 }));
    expect(hsvSaturation(vivid.organ)).toBeCloseTo(0.9, 6);
    expect(hsvSaturation(vivid.rim)).toBeLessThanOrEqual(0.15);
    // An albino's shell is clear and its organs show the pink of the blood.
    const albino = materialParams(withColour({ hue: 0.3, saturation: 1, albino: 'albino' }));
    expect(hsvSaturation(albino.rim)).toBeLessThanOrEqual(0.02);
    expect(hsvSaturation(albino.organ)).toBeGreaterThan(0.3);
    expect(albino.organ[0]).toBeGreaterThan(albino.organ[1]);
  });

  it('mixes a second organ hue, further round the wheel and more vivid as rarity rises (look pass 2)', () => {
    const tiers = ['common', 'uncommon', 'rare', 'exotic'] as const;
    // The HSV hue of a colour, in turns.
    const hueOf = ([r, g, bl]: readonly number[]): number => {
      const [x, y, z] = [r as number, g as number, bl as number];
      const [max, min] = [Math.max(x, y, z), Math.min(x, y, z)];
      const d = max - min || 1;
      const h = max === x ? (y - z) / d : max === y ? 2 + (z - x) / d : 4 + (x - y) / d;
      return (((h / 6) % 1) + 1) % 1;
    };
    const arc = (a: readonly number[], b: readonly number[]): number => {
      const d = Math.abs(hueOf(a) - hueOf(b));
      return Math.min(d, 1 - d);
    };
    for (const t of Array.from({ length: 200 }, randomTraits)) {
      if (t.colour.albino !== 'normal' || t.colour.saturation < 0.3) continue;
      let [lastArc, lastVivid] = [0, 0];
      for (const tier of tiers) {
        const p = materialParams(t, tier);
        const spread = arc(p.organ, p.organ2);
        expect(spread).toBeCloseTo(ORGAN_HUES[tier].spread, 2);
        expect(spread).toBeGreaterThan(lastArc);
        expect(p.vivid).toBeGreaterThanOrEqual(lastVivid);
        expect(hsvSaturation(p.organ2)).toBeGreaterThanOrEqual(hsvSaturation(p.organ) - 1e-9);
        [lastArc, lastVivid] = [spread, p.vivid];
      }
      // The tier never touches the shell: the colour lives inside.
      expect(materialParams(t, 'exotic').rim).toEqual(materialParams(t, 'common').rim);
      expect(materialParams(t, 'exotic').organ).toEqual(materialParams(t).organ);
    }
    expect(materialParams(base).vivid).toBe(0);
  });

  it('is deterministic', () => {
    const t = randomTraits();
    expect(materialParams(t)).toEqual(materialParams(t));
  });
});
