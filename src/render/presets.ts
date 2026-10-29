// The three quality presets of DESIGN §12. Presets only change presentation: nothing in `src/sim`
// reads them.

export type PresetName = 'low' | 'medium' | 'high';
export type QualitySetting = PresetName | 'auto';
export type DofMode = 'none' | 'half' | 'full';

export interface Preset {
  /** Cap on the device pixel ratio. */
  maxPixelRatio: number;
  /** Share of the full particle count that is drawn. */
  particles: number;
  dof: DofMode;
  bloom: boolean;
  grade: boolean;
  chromaticAberration: boolean;
  grain: boolean;
  /** Marine snow catches the light now and then (M6 T17). */
  sparkle: boolean;
  /**
   * Checked against `renderer.info` in E2E (`m6-budget.spec.ts`, M6 T26): draw calls and triangles a
   * frame, and the post chain's render-target colour memory for a 1920×1080 drawing buffer, in bytes.
   */
  budget: { calls: number; triangles: number; targetBytes: number };
}

export type ParticleLayerName = 'far' | 'mid' | 'near';

/**
 * Each particle layer's full (100%) count: far bokeh below the plane, marine snow around it and
 * near bokeh above it. A preset draws its `particles` share of each.
 */
export const PARTICLE_COUNTS: Readonly<Record<ParticleLayerName, number>> = {
  far: 290,
  mid: 2500,
  near: 60,
};

export const PRESET_NAMES: readonly PresetName[] = ['low', 'medium', 'high'];

export const PRESETS: Readonly<Record<PresetName, Preset>> = {
  low: {
    maxPixelRatio: 1,
    particles: 0.3,
    dof: 'none',
    bloom: false,
    grade: false,
    chromaticAberration: false,
    grain: false,
    sparkle: false,
    budget: { calls: 80, triangles: 150_000, targetBytes: 0 },
  },
  medium: {
    maxPixelRatio: 1.5,
    particles: 1,
    dof: 'half',
    bloom: true,
    grade: true,
    chromaticAberration: false,
    grain: false,
    sparkle: false,
    budget: { calls: 150, triangles: 300_000, targetBytes: 48_000_000 },
  },
  high: {
    maxPixelRatio: 2,
    particles: 1.5,
    dof: 'full',
    bloom: true,
    grade: true,
    chromaticAberration: true,
    grain: true,
    sparkle: true,
    budget: { calls: 250, triangles: 600_000, targetBytes: 96_000_000 },
  },
};

export const isPresetName = (value: unknown): value is PresetName =>
  typeof value === 'string' && (PRESET_NAMES as readonly string[]).includes(value);

/** An explicit setting stands; `auto` takes the detected preset (medium until a benchmark says otherwise). */
export const resolvePreset = (
  setting: QualitySetting,
  detected: PresetName = 'medium',
): PresetName => (setting === 'auto' ? detected : setting);

/** The device ratio up to the preset's cap, never below 1. */
export const pixelRatio = (preset: PresetName, devicePixelRatio: number): number => {
  const dpr = Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1;
  return Math.max(1, Math.min(dpr, PRESETS[preset].maxPixelRatio));
};
