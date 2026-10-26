import type { DeathCause } from '../sim/types';
import { pick } from './dom';
import { DEATH_TEXT, livedText } from './life-text';

export type Screen = 'title' | 'playing' | 'dead';

export interface DeathSummary {
  cause: DeathCause;
  /** Seconds the creature lived: its life clock when it has one, else sim time since hatching. */
  survivedSeconds: number;
  peakBiomass: number;
  /** Species and rarity of the body that died. */
  body: string;
}

/** Title and death screens over the live scene; `body[data-screen]` shows exactly one layer. */
export class Screens {
  private readonly cause = pick('[data-testid="death-cause"]');
  private readonly hint = pick('[data-testid="death-hint"]');
  private readonly survived = pick('[data-testid="death-survived"]');
  private readonly peak = pick('[data-testid="death-peak"]');
  private readonly species = pick('[data-testid="death-species"]');

  private readonly buttons: HTMLButtonElement[] = [];
  private readonly practice: HTMLButtonElement[] = [];
  private busy = false;
  private limited = false;

  constructor(handlers: { hatch(): void; practice(): void }) {
    for (const id of ['hatch', 'hatch-again']) {
      const button = pick<HTMLButtonElement>(`[data-testid="${id}"]`);
      this.buttons.push(button);
      button.addEventListener('click', () => {
        handlers.hatch();
      });
    }
    for (const id of ['practice', 'practice-again']) {
      const button = pick<HTMLButtonElement>(`[data-testid="${id}"]`);
      this.practice.push(button);
      button.addEventListener('click', () => {
        handlers.practice();
      });
    }
  }

  /** Greys out the hatch buttons while a hatch waits for the hub. */
  setBusy(busy: boolean): void {
    this.busy = busy;
    this.refresh();
  }

  /** While the recorded hatches are used up, Hatch waits and the practice cell is offered instead. */
  setLimited(limited: boolean): void {
    this.limited = limited;
    this.refresh();
  }

  private refresh(): void {
    for (const button of this.buttons) button.disabled = this.busy || this.limited;
    for (const button of this.practice) {
      button.hidden = !this.limited;
      button.disabled = this.busy;
    }
  }

  show(screen: Screen): void {
    // A focused button would turn the dash key (space) into another click.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    document.body.dataset.screen = screen;
  }

  showDeath(summary: DeathSummary): void {
    const text = DEATH_TEXT[summary.cause];
    this.cause.textContent = text.name;
    this.hint.textContent = text.hint;
    this.survived.textContent = livedText(summary.survivedSeconds * 1000);
    this.peak.textContent = String(Math.round(summary.peakBiomass));
    this.species.textContent = summary.body;
    this.show('dead');
  }
}
