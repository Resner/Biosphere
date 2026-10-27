// The rarity badge (M5 T12): one small component for the Lab, the inspect card and the invitation.
// The tier is also the text, so colour is never the only signal.

import type { RarityTier } from '../genome/rarity';

const capitalise = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Sets `el` to the badge for `tier`; an empty tier clears it. */
export function setBadge(el: HTMLElement, tier: RarityTier | ''): void {
  const text = tier === '' ? '' : capitalise(tier);
  if (el.textContent !== text) el.textContent = text;
  el.className = 'badge';
  if (tier !== '') el.dataset.tier = tier;
  else delete el.dataset.tier;
  el.hidden = tier === '';
}

/** A new badge element. */
export function rarityBadge(tier: RarityTier | ''): HTMLElement {
  const el = document.createElement('span');
  setBadge(el, tier);
  return el;
}
