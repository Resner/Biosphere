import type { CreatureState } from '../sim/types';
import { maxEnergy, maxHealth } from '../sim/vitals';
import { pick } from './dom';
import type { LifeClock } from './life';
import { remainingText, stageWord } from './life-text';

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
  private readonly species = pick('[data-testid="hud-species"]');
  private readonly lifeMeter = pick('[data-testid="hud-life"]');
  private readonly stage = pick('[data-testid="hud-stage"]');
  private readonly lifeLeft = pick('[data-testid="hud-remaining"]');
  private readonly ready = pick('[data-testid="hud-ready"]');
  private readonly lifeBar = pick('[data-bar="life"]');
  private readonly toastElement = pick('[data-testid="toast"]');
  private toastTimer: ReturnType<typeof setTimeout> | undefined;
  private low = false;

  /** Names the body of the life that has just started. */
  setBody(label: string): void {
    setText(this.species, label);
  }

  /** The life bar, stage word and time left; null hides them (a practice cell has no lifespan). */
  setLife(clock: LifeClock | null): void {
    if (this.lifeMeter.hidden !== (clock === null)) this.lifeMeter.hidden = clock === null;
    if (!clock) {
      // A new life starts without the last one's toast.
      clearTimeout(this.toastTimer);
      this.toastElement.hidden = true;
      return;
    }
    setText(this.stage, stageWord(clock.stage));
    setText(this.lifeLeft, remainingText(clock.remainingMs));
    setBar(this.lifeBar, clock.remainingMs / clock.lifespanMs);
    const old = clock.stage === 'old';
    if (this.lifeMeter.hasAttribute('data-old') !== old)
      this.lifeMeter.toggleAttribute('data-old', old);
  }

  /** The mating readiness under the life bar: "Ready to mate", "Ready in 2:10", or nothing. */
  setReady(text: string): void {
    setText(this.ready, text);
  }

  /** A short line in the middle of the screen. */
  toast(text: string, ms = 4000): void {
    this.toastElement.textContent = text;
    this.toastElement.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toastElement.hidden = true;
    }, ms);
  }

  /** Restarts the short brightening of the energy readout after eating. */
  pulseEnergy(): void {
    for (const part of [this.energy, this.energyBar]) {
      part.animate(
        [{ filter: 'brightness(2.2) drop-shadow(0 0 6px #8de88a)' }, { filter: 'none' }],
        { duration: 450, easing: 'ease-out' },
      );
    }
  }

  update(creature: CreatureState): void {
    const energy = Math.max(0, creature.energy / maxEnergy(creature.biomass));
    const low = energy < LOW_ENERGY;
    if (low !== this.low) {
      this.low = low;
      this.energyMeter.toggleAttribute('data-low', low);
    }
    setText(this.biomass, String(Math.round(creature.biomass)));
    setText(this.energy, `${Math.round(energy * 100)}%`);
    setText(this.health, String(Math.round(creature.health)));
    setBar(this.energyBar, energy);
    setBar(this.healthBar, creature.health / maxHealth(creature.biomass));
  }
}
