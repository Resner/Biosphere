/** How long a player is alone in a pond before the hint shows. */
export const ALONE_AFTER_MS = 8000;
/** How long it then shows: no text stays on the play screen (M6b T9). */
export const ALONE_SHOW_MS = 8000;

/**
 * Decides when to say "Alone in the pond": after 8 s of an online life with nobody else in the
 * roster, for 8 s.
 */
export class AloneHint {
  private since: number | null = null;

  /** Call once per frame; returns whether the hint shows. */
  update(nowMs: number, inPond: boolean, others: number): boolean {
    if (!inPond || others > 0) {
      this.since = null;
      return false;
    }
    this.since ??= nowMs;
    const alone = nowMs - this.since;
    return alone >= ALONE_AFTER_MS && alone < ALONE_AFTER_MS + ALONE_SHOW_MS;
  }
}
