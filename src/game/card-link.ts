// Links from the game to creature cards (M9 T14): the Lineage section's creatures, its pedigree
// nodes and the death screen each open `card.html?c=<id>` in a new tab. A local `?hub=` is carried
// over, so a card opened from an E2E game reads the same hub; the card ignores any other, so no
// other parameter is carried.

import { HEX64 } from '../ledger/record';
import { hubSocketUrl } from './online-config';

/** The card page of a creature, or null when `creature` is not a creature id (a practice cell). */
export function cardHref(creature: string | null, search: string): string | null {
  if (creature === null || !HEX64.test(creature)) return null;
  const query = new URLSearchParams({ c: creature });
  const hub = new URLSearchParams(search).get('hub');
  if (hub && hubSocketUrl(search, '')) query.set('hub', hub);
  return `card.html?${query}`;
}

/** Makes `link` open a creature's card in a new tab, or hides it when there is no card to open. */
export function setCardLink(link: HTMLAnchorElement, href: string | null): void {
  link.hidden = href === null;
  if (href === null) link.removeAttribute('href');
  else link.href = href;
  link.target = '_blank';
  link.rel = 'noopener';
}
