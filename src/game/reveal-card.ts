// The result card (M6b T11): after a genesis, a card slides in with what hatched (its preview, its
// species, its rarity in words and stars, and its silhouette class) and slides away after 3 s or on
// any click or key. It never takes a click itself, so the game is playable underneath. The text and
// the timing are pure; `RevealCard` writes them to the DOM.

import type { RarityTier } from '../genome/rarity';
import type { Silhouette } from '../genome/silhouette';
import { capitalise } from './badge';
import type { Body } from './body';
import { pick, setText } from './dom';
import { drawPreview } from './offspring-preview';

/** How long the card stays without a click or a key. */
export const CARD_MS = 3000;

/** Stars by rarity, out of four (the offspring card shows them too). */
export const STARS: Readonly<Record<RarityTier, number>> = {
  common: 1,
  uncommon: 2,
  rare: 3,
  exotic: 4,
};

/** The stars as text, filled and empty, and in words for a screen reader. */
export function starsText(tier: RarityTier): { text: string; label: string } {
  const n = STARS[tier];
  return { text: '★'.repeat(n) + '☆'.repeat(4 - n), label: `${n} of 4 stars` };
}

/** A silhouette class in plain words: `spiny-larva` is "Spiny larva". */
export const shapeName = (s: Silhouette): string => capitalise(s.replace(/-/g, ' '));

export interface RevealCardText {
  name: string;
  rarity: string;
  shape: string;
  tier: RarityTier;
}

/** What the card says about a body. */
export function revealCardText(body: {
  species: string;
  rarity: RarityTier;
  silhouette: Silhouette;
}): RevealCardText {
  return {
    name: body.species,
    rarity: capitalise(body.rarity),
    shape: shapeName(body.silhouette),
    tier: body.rarity,
  };
}

/** When the card shows: for `CARD_MS` from `show`, or until dismissed. */
export class RevealCardClock {
  private until = Number.NEGATIVE_INFINITY;

  show(now: number): void {
    this.until = now + CARD_MS;
  }

  dismiss(): void {
    this.until = Number.NEGATIVE_INFINITY;
  }

  shown(now: number): boolean {
    return now < this.until;
  }
}

/** Puts a body's stars and rarity frame on a card element (this one, or the offspring card). */
export function setStars(card: HTMLElement, stars: HTMLElement, tier: RarityTier): void {
  const { text, label } = starsText(tier);
  setText(stars, text);
  if (stars.getAttribute('aria-label') !== label) stars.setAttribute('aria-label', label);
  if (card.dataset.tier !== tier) card.dataset.tier = tier;
}

/** The card on screen. */
export class RevealCard {
  private readonly clock = new RevealCardClock();
  private readonly el = pick('[data-testid="reveal-card"]');
  private readonly preview = pick<HTMLCanvasElement>('[data-testid="reveal-preview"]');
  private readonly name = pick('[data-testid="reveal-name"]');
  private readonly stars = pick('[data-testid="reveal-stars"]');
  private readonly rarity = pick('[data-testid="reveal-rarity"]');
  private readonly shape = pick('[data-testid="reveal-shape"]');
  private visible = false;
  tier: RarityTier | null = null;

  constructor(target: Window) {
    // Any click or key sends it away, and still does what it does in the game.
    const dismiss = (): void => this.clock.dismiss();
    target.addEventListener('pointerdown', dismiss, { capture: true, passive: true });
    target.addEventListener('keydown', dismiss, { capture: true, passive: true });
  }

  /** A genesis hatched this body: the card slides in. */
  show(body: Body, silhouette: Silhouette, now: number): void {
    const text = revealCardText({ species: body.species, rarity: body.rarity, silhouette });
    setText(this.name, text.name);
    setText(this.rarity, text.rarity);
    setText(this.shape, text.shape);
    setStars(this.el, this.stars, text.tier);
    drawPreview(this.preview, body);
    this.tier = text.tier;
    this.el.hidden = false;
    this.clock.show(now);
  }

  /** Hides the card when its time is up or the play screen is gone. */
  update(now: number, playing: boolean): void {
    const shown = playing && this.clock.shown(now);
    if (!shown && !playing) this.clock.dismiss();
    if (shown === this.visible) return;
    this.visible = shown;
    this.el.toggleAttribute('data-shown', shown);
  }

  get shown(): boolean {
    return this.visible;
  }
}
