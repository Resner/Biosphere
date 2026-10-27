import type { DeathCause } from '../sim/types';
import { pick } from './dom';
import { DEATH_TEXT, livedText } from './life-text';
import type { FallbackId, FallbackOption } from './offspring-text';

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
  private readonly fallbackBoxes = [
    pick('[data-testid="title-fallback"]'),
    pick('[data-testid="death-fallback"]'),
  ];
  private fallbackButtons: HTMLButtonElement[] = [];
  private options: FallbackOption[] = [];
  private busy = false;
  private limited = false;

  constructor(
    private readonly handlers: { hatch(): void; practice(): void; choose(id: FallbackId): void },
  ) {
    const bind = (ids: string[], into: HTMLButtonElement[], click: () => void): void => {
      for (const id of ids) {
        const button = pick<HTMLButtonElement>(`[data-testid="${id}"]`);
        into.push(button);
        button.addEventListener('click', click);
      }
    };
    bind(['hatch', 'hatch-again'], this.buttons, handlers.hatch);
    bind(['practice', 'practice-again'], this.practice, handlers.practice);
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

  /** What the player can become instead of hatching: the offspring and the nearest ancestor. Empty means hatch. */
  setFallback(options: FallbackOption[]): void {
    const same =
      options.length === this.options.length &&
      options.every((o, i) => o.id === this.options[i]?.id && o.label === this.options[i]?.label);
    if (same) return;
    this.options = options;
    this.fallbackButtons = [];
    this.fallbackBoxes.forEach((box, i) => {
      const prefix = i === 0 ? 'title' : 'death';
      box.replaceChildren(
        ...options.map((option) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'action';
          button.dataset.testid = `${prefix}-fallback-${option.id}`;
          button.textContent = option.label;
          button.addEventListener('click', () => this.handlers.choose(option.id));
          this.fallbackButtons.push(button);
          return button;
        }),
      );
      box.hidden = options.length === 0;
    });
    this.refresh();
  }

  /** The ids of the choices on offer, first one first. */
  get optionIds(): FallbackId[] {
    return this.options.map((o) => o.id);
  }

  /** The option Enter takes, or null when Enter hatches. */
  get firstOption(): FallbackId | null {
    return this.options[0]?.id ?? null;
  }

  private refresh(): void {
    const choosing = this.options.length > 0;
    for (const button of this.fallbackButtons) button.disabled = this.busy;
    for (const button of this.buttons) {
      button.hidden = choosing;
      button.disabled = this.busy || this.limited;
    }
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
