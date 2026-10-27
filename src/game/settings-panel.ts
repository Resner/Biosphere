// The Settings panel (M6 T1): graphics quality now; sound and motion join in later tasks. It owns
// no state: the app hands it the current settings and applies what it reports.

import type { PresetName, QualitySetting } from '../render/presets';
import type { Settings } from '../render/settings';
import { pick } from './dom';

const QUALITIES: readonly QualitySetting[] = ['auto', 'low', 'medium', 'high'];

export class SettingsPanel {
  private readonly panel = pick('[data-testid="settings"]');
  private readonly note = pick('[data-testid="quality-note"]');
  private readonly radios = new Map<QualitySetting, HTMLInputElement>(
    QUALITIES.map((q) => [q, pick<HTMLInputElement>(`[data-testid="quality-${q}"]`)]),
  );
  private resolved: PresetName = 'medium';

  constructor(
    private readonly onChange: (settings: Settings) => void,
    openers: readonly string[],
  ) {
    for (const [quality, radio] of this.radios) {
      radio.addEventListener('change', () => {
        if (radio.checked) this.onChange({ quality });
      });
    }
    for (const id of openers)
      pick(`[data-testid="${id}"]`).addEventListener('click', () => this.open());
    pick('[data-testid="settings-close"]').addEventListener('click', () => this.close());
    this.panel.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.close();
    });
  }

  get isOpen(): boolean {
    return !this.panel.hidden;
  }

  /** Shows the settings in force and the preset they resolve to. */
  show(settings: Settings, resolved: PresetName): void {
    this.resolved = resolved;
    const radio = this.radios.get(settings.quality);
    if (radio) radio.checked = true;
    this.note.textContent =
      settings.quality === 'auto' ? `Auto uses the ${resolved} preset on this device.` : '';
  }

  open(): void {
    this.panel.hidden = false;
    (this.radios.get(this.checked()) ?? this.radios.get('auto'))?.focus();
  }

  close(): void {
    this.panel.hidden = true;
  }

  private checked(): QualitySetting {
    for (const [quality, radio] of this.radios) if (radio.checked) return quality;
    return this.resolved;
  }
}
