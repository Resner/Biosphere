// Plain words for courting (M5 T10): why a creature cannot mate, how long it must rest and how
// related two creatures are. The player sees creatures, never records: no "commit" or "ledger" here.

import { BAND_TEXT, inbreedingBand } from '../ledger/pedigree';

const SECOND = 1000;

const REASONS: Readonly<Record<string, string>> = {
  'not-active': 'Not swimming yet',
  locked: 'Busy right now',
  'in-flight': 'Already mating',
  pending: 'Already has an offspring waiting',
  'not-mature': 'Not mature yet',
  'low-energy': 'Needs more energy',
  tier: 'Too big or too small',
  self: 'That is you',
  'not-here': 'Out of reach',
  'pair-mismatch': 'They moved on. Try again.',
  used: 'Try again',
  expired: 'Too slow',
  'no-court': 'No offer to answer',
  'no-creature': 'Not swimming yet',
};
const FALLBACK = 'Cannot mate right now';
const PARTNER = 'partner-';

/** "3:20", rounded up so a zero never shows while a wait is on. */
export const clock = (ms: number): string => {
  const total = Math.max(0, Math.ceil(ms / SECOND));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

/** "Rest for 3:20": the wait before the next mating, rounded up. */
const cooldownText = (ms: number): string => `Rest for ${clock(ms)}`;

/** The life meter's word for the cooldown: ready, or the wait. */
export const readyText = (leftMs: number): string =>
  leftMs > 0 ? `Ready in ${clock(leftMs)}` : 'Ready to mate';

/**
 * Why a mating is off, from a `MateRefusal` or the hub's reason (`partner-` marks the other
 * player's). `cooldownLeftMs` fills in a rest time; `name` goes in front of a partner's reason.
 */
export function refusalText(reason: string, cooldownLeftMs = 0, name?: string): string {
  const theirs = reason.startsWith(PARTNER);
  const own = theirs ? reason.slice(PARTNER.length) : reason;
  const words = own === 'cooldown' ? cooldownText(cooldownLeftMs) : (REASONS[own] ?? FALLBACK);
  return theirs && name ? `${name}: ${words}` : words;
}

/** What the inbreeding band says about a child of two creatures this related. */
export const bandWords = (kinship: number): string => BAND_TEXT[inbreedingBand(kinship)];
