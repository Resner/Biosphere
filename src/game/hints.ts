// First-life hints (M6b T9): the play screen keeps no control lines, so a browser's first life
// shows two short hints at the bottom, each for a few seconds. Later lives show none; the menu's
// Controls section always lists every key.

/** Where this browser remembers that its first life has had the hints. */
export const HINT_KEY = 'bs.hints';
/** How long each hint shows, in milliseconds of play. */
export const HINT_SHOW_MS = 8000;
/** The hints, in order, and when each starts (milliseconds of play). */
export const HINTS = [
  'Mouse or WASD to swim · Space to dash',
  'G wheel · M map · Enter chat',
] as const;
const HINT_AT_MS = [0, 30_000] as const;

/** The hint shown `playMs` into a life, or null; only the first life has any. */
export function hintAt(firstLife: boolean, playMs: number): string | null {
  if (!firstLife) return null;
  for (let i = 0; i < HINTS.length; i++) {
    const from = HINT_AT_MS[i] as number;
    if (playMs >= from && playMs < from + HINT_SHOW_MS) return HINTS[i] as string;
  }
  return null;
}

/** Decides, life by life, whether this browser still gets the hints. */
export class Hints {
  /** Whether a life with the hints has started in this visit. */
  private given = false;
  private firstLife = false;

  constructor(private readonly store: Storage | null) {}

  /** A new life starts: the first one this browser plays gets the hints, and that is stored. */
  startLife(): void {
    this.firstLife = !this.given && !this.seen();
    if (!this.firstLife) return;
    this.given = true;
    try {
      this.store?.setItem(HINT_KEY, 'seen');
    } catch {
      // A blocked store forgets it: the next visit shows the hints again.
    }
  }

  /** The hint shown `playMs` into the current life, or null. */
  at(playMs: number): string | null {
    return hintAt(this.firstLife, playMs);
  }

  private seen(): boolean {
    try {
      return this.store?.getItem(HINT_KEY) != null;
    } catch {
      return false;
    }
  }
}
