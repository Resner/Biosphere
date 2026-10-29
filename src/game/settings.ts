// Player settings kept in the browser (`localStorage['bs.settings']`). A blocked or damaged store
// never breaks the game: it just means the defaults.

import { isPresetName, type PresetName, type QualitySetting } from '../render/presets';
import type { Store } from './online-config';

export interface Settings {
  quality: QualitySetting;
  /** Sound volume, 0..100 in whole steps (M6 T22). */
  volume: number;
  muted: boolean;
  /** Reduced motion: null follows `prefers-reduced-motion`, a boolean is the player's choice. */
  reducedMotion: boolean | null;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  quality: 'auto',
  volume: 60,
  muted: false,
  reducedMotion: null,
};

const SETTINGS_KEY = 'bs.settings';

/** Reads each field on its own, so one damaged field (or settings from before it existed) keeps the rest. */
export function loadSettings(store: Store | null): Settings {
  const out: Settings = { ...DEFAULT_SETTINGS };
  try {
    const text = store?.getItem(SETTINGS_KEY);
    if (!text) return out;
    const data: unknown = JSON.parse(text);
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return out;
    const { quality, volume, muted, reducedMotion } = data as Record<string, unknown>;
    if (quality === 'auto' || isPresetName(quality)) out.quality = quality;
    if (typeof volume === 'number' && Number.isFinite(volume))
      out.volume = Math.min(100, Math.max(0, Math.round(volume)));
    if (typeof muted === 'boolean') out.muted = muted;
    if (typeof reducedMotion === 'boolean' || reducedMotion === null)
      out.reducedMotion = reducedMotion;
  } catch {
    // A throwing store or damaged JSON: use the defaults.
  }
  return out;
}

/** Whether motion is reduced: the player's choice, else the system's `prefers-reduced-motion`. */
export function reducedMotion(settings: Settings, systemPrefers: boolean): boolean {
  return settings.reducedMotion ?? systemPrefers;
}

export function saveSettings(settings: Settings, store: Store | null): void {
  try {
    store?.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Not saving is fine; the choice still holds for this visit.
  }
}

/** `?quality=low|medium|high` beats the stored value for this visit without being written. */
export function qualityFromSearch(search: string): PresetName | null {
  const value = new URLSearchParams(search).get('quality');
  return isPresetName(value) ? value : null;
}

const BENCH_KEY = 'bs.bench';
/** A browser keeps the benchmark results of this many GPUs (a laptop docked and undocked). */
export const BENCH_GPUS = 8;

function readBench(store: Store | null): Map<string, PresetName> {
  const out = new Map<string, PresetName>();
  try {
    const text = store?.getItem(BENCH_KEY);
    const data: unknown = text ? JSON.parse(text) : null;
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return out;
    for (const [gpu, preset] of Object.entries(data))
      if (isPresetName(preset)) out.set(gpu, preset);
  } catch {
    // A throwing store or damaged JSON: nothing is known.
  }
  return out;
}

/** The auto-detected preset stored for this GPU (`bs.bench`), or null: then it benchmarks. */
export function loadBench(store: Store | null, gpu: string): PresetName | null {
  return readBench(store).get(gpu) ?? null;
}

/** Stores the auto-detected preset for this GPU; the oldest GPUs past `BENCH_GPUS` are dropped. */
export function saveBench(store: Store | null, gpu: string, preset: PresetName): void {
  const results = readBench(store);
  results.delete(gpu);
  results.set(gpu, preset);
  const kept = [...results].slice(-BENCH_GPUS);
  try {
    store?.setItem(BENCH_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Not saving means benchmarking again next visit.
  }
}
