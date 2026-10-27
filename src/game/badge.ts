// The rarity badge (M5 T12): one small component for the Lab, the inspect card and the invitation.
// The tier is also the text, so colour is never the only signal.

import type { RarityTier } from '../genome/rarity';

const capitalise = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Sets `el` to the badge for `tier`; an empty tier hides it. Writes only what changed. */
export function setBadge(el: HTMLElement, tier: RarityTier | ''): void {
  const text = tier === '' ? '' : capitalise(tier);
  if (el.textContent !== text) el.textContent = text;
  if (!el.classList.contains('badge')) el.classList.add('badge');
  if (el.dataset.tier !== tier) {
    if (tier === '') delete el.dataset.tier;
    else el.dataset.tier = tier;
  }
  if (el.hidden !== (tier === '')) el.hidden = tier === '';
}

/** A new badge element. */
export function rarityBadge(tier: RarityTier | ''): HTMLElement {
  const el = document.createElement('span');
  setBadge(el, tier);
  return el;
}
