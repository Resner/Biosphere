import type { DeathCause } from '../sim/types';
import { cardHref, setCardLink } from './card-link';
import { pick } from './dom';
import { DEATH_TEXT, deathName, livedText } from './life-text';
import type { FallbackId, FallbackOption } from './offspring-text';

export type Screen = 'title' | 'playing' | 'dead';

export interface DeathSummary {
  cause: DeathCause;
  /** Seconds the creature lived: its life clock when it has one, else sim time since hatching. */
  survivedSeconds: number;
  peakBiomass: number;
  /** Species and rarity of the body that died. */
  body: string;
  /** The killer's name, when the hub settled a kill and named it (M7 T13). */
  by: string | null;
  /** The recorded creature that died, whose card the screen links (M9 T14); null for a practice cell. */
  creature: string | null;
}

/** Title and death screens over the live scene; `body[data-screen]` shows exactly one layer. */
export class Screens {
  private readonly cause = pick('[data-testid="death-cause"]');
  private readonly hint = pick('[data-testid="death-hint"]');
  private readonly survived = pick('[data-testid="death-survived"]');
  private readonly peak = pick('[data-testid="death-peak"]');
  private readonly species = pick('[data-testid="death-species"]');
  private readonly card = pick<HTMLAnchorElement>('[data-testid="death-card"]');

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
  /** "Back to the fight" takes the title's main button (M8 T10). */
  private readonly resumeButton = pick<HTMLButtonElement>('[data-testid="resume-fight"]');
  private readonly resumeLine = pick('[data-testid="resume-line"]');
  private resuming = false;
  /** What happened while the player was away (M8 T12), on the title and on the death screen. */
  private readonly reports = [
    pick('[data-testid="away-report"]'),
    pick('[data-testid="death-report"]'),
  ];

  constructor(
    private readonly handlers: {
      hatch(): void;
      practice(): void;
      choose(id: FallbackId): void;
      resume(): void;
    },
  ) {
    this.resumeButton.addEventListener('click', () => handlers.resume());
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
    });
    this.refresh();
  }

  /** The away report's lines, one paragraph each; none hides it (a new life clears it). */
  setReport(lines: readonly string[]): void {
    for (const box of this.reports) {
      box.replaceChildren(
        ...lines.map((line) => {
          const p = document.createElement('p');
          p.textContent = line;
          return p;
        }),
      );
      box.hidden = lines.length === 0;
    }
  }

  /** While the creature is locked in a running fight, the title offers only "Back to the fight". */
  setResume(on: boolean): void {
    if (on === this.resuming) return;
    this.resuming = on;
    this.refresh();
  }

  /** Enter, Space or a click on the title goes back to the fight. */
  get resumeOffered(): boolean {
    return this.resuming;
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
    // The title's own choices give way to "Back to the fight"; the death screen keeps its own.
    const onTitle = (button: HTMLElement) => button.closest('[data-for="title"]') !== null;
    const away = (button: HTMLElement) => this.resuming && onTitle(button);
    for (const button of this.fallbackButtons) button.disabled = this.busy;
    this.fallbackBoxes.forEach((box) => {
      box.hidden = !choosing || away(box);
    });
    for (const button of this.buttons) {
      button.hidden = choosing || away(button);
      button.disabled = this.busy || this.limited;
    }
    for (const button of this.practice) {
      button.hidden = !this.limited || away(button);
      button.disabled = this.busy;
    }
    this.resumeButton.hidden = !this.resuming;
    this.resumeLine.hidden = !this.resuming;
    this.resumeButton.disabled = this.busy;
  }

  show(screen: Screen): void {
    // A focused button would turn the dash key (space) into another click.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    document.body.dataset.screen = screen;
  }

  showDeath(summary: DeathSummary): void {
    const text = DEATH_TEXT[summary.cause];
    this.cause.textContent = deathName(summary.cause, summary.by);
    this.hint.textContent = text.hint;
    this.survived.textContent = livedText(summary.survivedSeconds * 1000);
    this.peak.textContent = String(Math.round(summary.peakBiomass));
    this.species.textContent = summary.body;
    setCardLink(this.card, cardHref(summary.creature, window.location.search));
    this.show('dead');
  }
}
