// Plain-words text for the life clock, the hatch countdown and the history list (M4 T10).
// Nothing here may say "activeMs", "checkpoint" or "ledger": the player sees a creature, not records.

import type { LifeStage } from '../sim/life';
import type { DeathCause } from '../sim/types';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** The remaining time shows only when this little is left. */
const SHOW_REMAINING_MS = 10 * MINUTE;

const STAGES: Readonly<Record<LifeStage, string>> = {
  young: 'Young',
  mature: 'Mature',
  old: 'Old',
};

export const stageWord = (stage: LifeStage): string => STAGES[stage];

/** "About 8 min left" in the last 10 minutes; empty before that. */
export function remainingText(remainingMs: number): string {
  if (remainingMs > SHOW_REMAINING_MS) return '';
  const ms = Math.max(0, remainingMs);
  if (ms >= MINUTE) return `About ${Math.round(ms / MINUTE)} min left`;
  return `About ${Math.round(ms / SECOND)} s left`;
}

/** "Next recorded hatch in 3:42", rounded up so a zero never shows while the wait is on. */
export function countdownText(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / SECOND));
  const seconds = String(total % 60).padStart(2, '0');
  return `Next recorded hatch in ${Math.floor(total / 60)}:${seconds}`;
}

/** How long a creature lived: "42 s", "2 min 5 s", "1 h 15 min". */
export function livedText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / SECOND));
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return total % 60 === 0 ? `${minutes} min` : `${minutes} min ${total % 60} s`;
  return minutes % 60 === 0
    ? `${Math.floor(minutes / 60)} h`
    : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** How long ago something happened: "just now", "5 min ago", "3 h ago", "2 days ago". */
export function whenText(agoMs: number): string {
  if (agoMs < MINUTE) return 'just now';
  if (agoMs < HOUR) return `${Math.floor(agoMs / MINUTE)} min ago`;
  if (agoMs < DAY) return `${Math.floor(agoMs / HOUR)} h ago`;
  const days = Math.floor(agoMs / DAY);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

/** What the death screen and the history say about a cause: a short name and one line of advice. */
export const DEATH_TEXT: Readonly<Record<DeathCause, { name: string; hint: string }>> = {
  starved: { name: 'Starved', hint: 'Your energy ran out. Eat drifting food to keep it up.' },
  toxin: {
    name: 'Poisoned',
    hint: 'You drifted into a toxic cloud. Steer clear of the dark haze.',
  },
  'old-age': { name: 'Died of old age', hint: 'Your creature lived out its time.' },
  uv: { name: 'Burned', hint: 'Sunlight was too strong up here.' },
  pressure: { name: 'Crushed', hint: 'The deep water was too heavy.' },
  killed: { name: 'Killed', hint: 'Another creature got you.' },
};
