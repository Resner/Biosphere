import { pick } from './dom';

/** How long the notice stays on the title screen: two sentences, read once (M6c T2). */
export const RENEWAL_SHOW_MS = 15_000;

/**
 * The world renewal notice (ADR 0040): the hub says `renewed` once per returning identity, and the
 * title screen shows it as a glass toast. Its text is in `index.html`; the version is the release
 * that renewed the world, not the one running.
 */
export class RenewalNotice {
  private readonly element = pick('[data-testid="renewed"]');
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** What the hub's last `life` said on this page; null before one (`state().renewed`). */
  heard: boolean | null = null;

  receive(renewed: boolean): void {
    this.heard = renewed;
    if (!renewed) return;
    this.element.hidden = false;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.element.hidden = true;
    }, RENEWAL_SHOW_MS);
  }
}
