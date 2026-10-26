import type { DeathCause } from '../sim/types';
import { pick } from './dom';

export type Screen = 'title' | 'playing' | 'dead';

export interface DeathSummary {
  cause: DeathCause;
  /** Seconds of sim time between hatching and dying. */
  survivedSeconds: number;
  peakBiomass: number;
  /** Species and rarity of the body that died. */
  body: string;
}

/** What the death screen says: a short name and one line of advice. */
const DEATH_TEXT: Readonly<Record<DeathCause, { name: string; hint: string }>> = {
  starved: { name: 'Starved', hint: 'Your energy ran out. Eat drifting food to keep it up.' },
  toxin: {
    name: 'Poisoned',
    hint: 'You drifted into a toxic cloud. Steer clear of the dark haze.',
  },
  'old-age': { name: 'Old age', hint: 'Your cell lived out its time.' },
  uv: { name: 'Burned', hint: 'Sunlight was too strong up here.' },
  pressure: { name: 'Crushed', hint: 'The deep water was too heavy.' },
  killed: { name: 'Killed', hint: 'Another creature got you.' },
};

/** Title and death screens over the live scene; `body[data-screen]` shows exactly one layer. */
export class Screens {
  private readonly cause = pick('[data-testid="death-cause"]');
  private readonly hint = pick('[data-testid="death-hint"]');
  private readonly survived = pick('[data-testid="death-survived"]');
  private readonly peak = pick('[data-testid="death-peak"]');
  private readonly species = pick('[data-testid="death-species"]');

  private readonly buttons: HTMLButtonElement[] = [];

  constructor(handlers: { hatch(): void }) {
    for (const id of ['hatch', 'hatch-again']) {
      const button = pick<HTMLButtonElement>(`[data-testid="${id}"]`);
      this.buttons.push(button);
      button.addEventListener('click', () => {
        handlers.hatch();
      });
    }
  }

  /** Greys out the hatch buttons while a hatch waits for the hub. */
  setBusy(busy: boolean): void {
    for (const button of this.buttons) button.disabled = busy;
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
    this.survived.textContent = `${Math.floor(summary.survivedSeconds)} s`;
    this.peak.textContent = String(Math.round(summary.peakBiomass));
    this.species.textContent = summary.body;
    this.show('dead');
  }
}
