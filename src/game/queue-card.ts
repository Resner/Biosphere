// The admission line in the page (M13 T10): while the hub keeps the session waiting, the title and
// death screens show why, the place and the wait in words, and offer the practice cell meanwhile.

import type { QueuePlace } from '../net/hub-client';
import type { QueueWhy } from '../net/protocol';
import { pick, setText } from './dom';

const DAY_MS = 86_400_000;

/** Why the session waits, by the guard that holds. */
export const REASON_TEXT: Record<QueueWhy, string> = {
  full: 'The water is full',
  budget: "Today's room is used up",
  storage: 'No room for new players right now',
};

/** The toast when the hub seats a session that waited. */
export const SEATED_TEXT = 'A place is free: your next hatch is recorded';

/** The local time's offset from UTC in minutes at `ms` (east positive). */
export type OffsetAt = (ms: number) => number;
export const localOffset: OffsetAt = (ms) => -new Date(ms).getTimezoneOffset();

/** "1st", "2nd", "3rd", "4th", "11th", "22nd". */
export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suffix}`;
}

/** "2nd in line". */
export const placeText = (position: number): string => `${ordinal(position)} in line`;

/** The wait in words: under a minute, then whole minutes, then whole hours ("about 2 h"). */
export function waitText(etaS: number): string {
  if (etaS < 60) return 'under a minute';
  const min = Math.round(etaS / 60);
  if (min < 60) return `about ${min} min`;
  return `about ${Math.round(etaS / 3600)} h`;
}

/** When a spent day's budget reopens: the next 00:00 UTC after `now`, in local time ("opens at 01:00"). */
export function reopenText(now: number, offsetAt: OffsetAt = localOffset): string {
  const next = (Math.floor(now / DAY_MS) + 1) * DAY_MS;
  const local = new Date(next + offsetAt(next) * 60_000);
  const hh = String(local.getUTCHours()).padStart(2, '0');
  const mm = String(local.getUTCMinutes()).padStart(2, '0');
  return `opens at ${hh}:${mm}`;
}

/** The card's words: why, the place, and the wait (none while the store is nearly full). */
export function cardWords(
  q: QueuePlace,
  now: number,
  offsetAt: OffsetAt = localOffset,
): { reason: string; place: string; wait: string } {
  const wait =
    q.why === 'budget' ? reopenText(now, offsetAt) : q.why === 'storage' ? '' : waitText(q.etaS);
  return { reason: REASON_TEXT[q.why], place: placeText(q.position), wait };
}

/** The place and the wait in one line, as the status chip shows it: "2nd in line · about 1 min". */
export function lineText(q: QueuePlace, now: number, offsetAt: OffsetAt = localOffset): string {
  const { place, wait } = cardWords(q, now, offsetAt);
  return wait ? `${place} · ${wait}` : place;
}

/** The glass card on the title and death screens (`queue-card`, `death-queue-card`). */
export class QueueCard {
  private readonly cards = ['queue-card', 'death-queue-card'].map((id) => {
    const root = pick(`[data-testid="${id}"]`);
    return {
      root,
      reason: pick(`[data-testid="${id}"] .queue-reason`),
      line: pick(`[data-testid="${id}"] .queue-line`),
    };
  });

  constructor(swim: () => void) {
    for (const id of ['queue-swim', 'death-queue-swim']) {
      pick(`[data-testid="${id}"]`).addEventListener('click', swim);
    }
  }

  /** Shows the place in line, or hides the card (null). */
  show(q: QueuePlace | null, now: number): void {
    for (const card of this.cards) {
      if (card.root.hidden !== (q === null)) card.root.hidden = q === null;
      if (!q) continue;
      setText(card.reason, REASON_TEXT[q.why]);
      setText(card.line, lineText(q, now));
    }
  }
}
