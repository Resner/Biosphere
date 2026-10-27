// Player settings kept in the browser (`localStorage['bs.settings']`). A blocked or damaged store
// never breaks the game: it just means the defaults.

import { isPresetName, type PresetName, type QualitySetting } from './presets';

export interface Settings {
  quality: QualitySetting;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = { quality: 'auto' };

export const SETTINGS_KEY = 'bs.settings';

/** The part of `Storage` the settings use. */
export interface SettingsStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The browser's store, or null when reaching it throws (private windows, blocked site data). */
export function browserStore(): SettingsStore | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadSettings(store: SettingsStore | null = browserStore()): Settings {
  try {
    const text = store?.getItem(SETTINGS_KEY);
    if (!text) return { ...DEFAULT_SETTINGS };
    const data: unknown = JSON.parse(text);
    if (typeof data !== 'object' || data === null) return { ...DEFAULT_SETTINGS };
    const { quality } = data as { quality?: unknown };
    if (quality === 'auto' || isPresetName(quality)) return { quality };
  } catch {
    // A throwing store or damaged JSON: use the defaults.
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(
  settings: Settings,
  store: SettingsStore | null = browserStore(),
): void {
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
