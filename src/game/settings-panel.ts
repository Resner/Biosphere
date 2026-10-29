// The Settings panel: graphics quality (M6 T1), sound volume and mute, and reduced motion
// (M6 T22). It owns no state: the app hands it the current settings and applies what it reports.

import type { PresetName, QualitySetting } from '../render/presets';
import { capitalise } from './badge';
import { pick } from './dom';
import type { Settings } from './settings';

const QUALITIES: readonly QualitySetting[] = ['auto', 'low', 'medium', 'high'];

export class SettingsPanel {
  private readonly panel = pick('[data-testid="settings"]');
  private readonly note = pick('[data-testid="quality-note"]');
  private readonly autoName = pick('[data-testid="quality-auto-name"]');
  private readonly radios = new Map<QualitySetting, HTMLInputElement>(
    QUALITIES.map((q) => [q, pick<HTMLInputElement>(`[data-testid="quality-${q}"]`)]),
  );
  private readonly volume = pick<HTMLInputElement>('[data-testid="volume"]');
  private readonly volumeValue = pick('[data-testid="volume-value"]');
  private readonly mute = pick<HTMLInputElement>('[data-testid="mute"]');
  private readonly motion = pick<HTMLInputElement>('[data-testid="reduced-motion"]');
  private readonly motionNote = pick('[data-testid="motion-note"]');
  /** The settings last shown, which each change starts from. */
  private current: Settings | null = null;

  constructor(
    private readonly onChange: (settings: Settings) => void,
    openers: readonly string[],
  ) {
    for (const [quality, radio] of this.radios) {
      radio.addEventListener('change', () => {
        if (radio.checked) this.change({ quality });
      });
    }
    // The volume follows the slider as it moves; mute lands with the click.
    this.volume.addEventListener('input', () => this.change({ volume: Number(this.volume.value) }));
    this.mute.addEventListener('change', () => this.change({ muted: this.mute.checked }));
    this.motion.addEventListener('change', () =>
      this.change({ reducedMotion: this.motion.checked }),
    );
    for (const id of openers)
      pick(`[data-testid="${id}"]`).addEventListener('click', () => this.open());
    pick('[data-testid="settings-close"]').addEventListener('click', () => this.close());
    this.panel.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.close();
    });
  }

  private change(part: Partial<Settings>): void {
    if (this.current) this.onChange({ ...this.current, ...part });
  }

  get isOpen(): boolean {
    return !this.panel.hidden;
  }

  /**
   * Shows the settings in force, the preset they resolve to, the one Auto detected and whether
   * motion is reduced now (the system's preference until the player picks).
   */
  show(settings: Settings, resolved: PresetName, detected: PresetName, reduced: boolean): void {
    this.current = settings;
    const radio = this.radios.get(settings.quality);
    if (radio) radio.checked = true;
    this.autoName.textContent = `Auto (${capitalise(detected)})`;
    this.note.textContent =
      settings.quality === 'auto' ? `Auto uses the ${resolved} preset on this device.` : '';
    this.volume.value = String(settings.volume);
    this.volumeValue.textContent = String(settings.volume);
    this.mute.checked = settings.muted;
    this.motion.checked = reduced;
    this.motionNote.textContent =
      settings.reducedMotion === null ? 'Motion follows your system setting.' : '';
  }

  open(): void {
    this.panel.hidden = false;
    this.panel.querySelector<HTMLInputElement>('input:checked')?.focus();
  }

  close(): void {
    this.panel.hidden = true;
  }
}
