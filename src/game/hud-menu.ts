// The play screen's one button (M6b T9): a round profile button in the top-left corner, or Esc,
// opens a panel with everything the play screen leaves out: the species, the numbers in words,
// Lineage, Settings and the Controls, the players and the build. Steering carries on under it.

import { pick } from './dom';

export class HudMenu {
  private readonly button = pick<HTMLButtonElement>('[data-testid="hud-menu"]');
  private readonly panel = pick('[data-testid="menu"]');
  private readonly controlsButton = pick('[data-testid="menu-controls"]');
  private readonly controls = pick('[data-testid="controls"]');

  constructor() {
    // The build label the title screen shows, set before the game starts.
    pick('[data-testid="menu-build"]').textContent =
      pick('[data-testid="build-label"]').textContent ?? '';
    this.button.addEventListener('click', () => this.toggle());
    this.controlsButton.addEventListener('click', () => {
      this.controls.hidden = !this.controls.hidden;
      this.controlsButton.setAttribute('aria-expanded', String(!this.controls.hidden));
    });
    // A clicked button keeps no focus, so Space stays the dash key instead of clicking it again.
    for (const root of [this.button, this.panel]) {
      root.addEventListener('click', (e) => {
        const target = e.target instanceof Element ? e.target.closest('button') : null;
        if (target) target.blur();
      });
    }
    // Every new screen (a death, a new life) starts with the menu closed.
    new MutationObserver(() => this.close()).observe(document.body, {
      attributes: true,
      attributeFilter: ['data-screen'],
    });
  }

  get isOpen(): boolean {
    return !this.panel.hidden;
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  open(): void {
    this.set(true);
  }

  close(): void {
    this.set(false);
  }

  private set(open: boolean): void {
    if (this.panel.hidden === !open) return;
    this.panel.hidden = !open;
    this.button.setAttribute('aria-expanded', String(open));
  }
}
