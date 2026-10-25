import type { CreatureState } from '../sim/types';
import { maxEnergy, maxHealth } from '../sim/vitals';
import { pick } from './dom';

/** Writes only when the text changed, so a steady readout costs no DOM work. */
function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}

function setBar(bar: HTMLElement, fraction: number): void {
  const width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
  if (bar.style.width !== width) bar.style.width = width;
}

/** Below this share of its energy the readout pulses (DESIGN §10). */
const LOW_ENERGY = 0.2;

/** Biomass, energy and health readouts; text and bars, so colour is never the only signal. */
export class Hud {
  private readonly biomass = pick('[data-testid="hud-biomass"]');
  private readonly energy = pick('[data-testid="hud-energy"]');
  private readonly health = pick('[data-testid="hud-health"]');
  private readonly energyBar = pick('[data-bar="energy"]');
  private readonly healthBar = pick('[data-bar="health"]');

  private readonly energyMeter = pick('[data-meter="energy"]');

  /** Restarts the short brightening of the energy readout after eating. */
  pulseEnergy(): void {
    this.energyMeter.removeAttribute('data-pulse');
    // Reading a layout property flushes the style, so re-adding the attribute restarts the animation.
    void this.energyMeter.offsetWidth;
    this.energyMeter.setAttribute('data-pulse', '');
  }

  update(creature: CreatureState): void {
    const energy = Math.max(0, creature.energy / maxEnergy(creature.biomass));
    this.energyMeter.toggleAttribute('data-low', energy < LOW_ENERGY);
    setText(this.biomass, String(Math.round(creature.biomass)));
    setText(this.energy, `${Math.round(energy * 100)}%`);
    setText(this.health, String(Math.round(creature.health)));
    setBar(this.energyBar, energy);
    setBar(this.healthBar, creature.health / maxHealth(creature.biomass));
  }
}
