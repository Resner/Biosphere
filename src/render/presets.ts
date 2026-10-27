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
  /** Checked against `renderer.info` in E2E. */
  budget: { calls: number; triangles: number };
}

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
    budget: { calls: 80, triangles: 150_000 },
  },
  medium: {
    maxPixelRatio: 1.5,
    particles: 1,
    dof: 'half',
    bloom: true,
    grade: true,
    chromaticAberration: false,
    grain: false,
    budget: { calls: 150, triangles: 300_000 },
  },
  high: {
    maxPixelRatio: 2,
    particles: 1.5,
    dof: 'full',
    bloom: true,
    grade: true,
    chromaticAberration: true,
    grain: true,
    budget: { calls: 250, triangles: 600_000 },
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
