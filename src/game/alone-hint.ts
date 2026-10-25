/** How long a player is alone in a pond before the hint shows. */
export const ALONE_AFTER_MS = 8000;

/** Decides when to say "Alone in the pond": 8 s of an online life with nobody else in the roster. */
export class AloneHint {
  private since: number | null = null;

  /** Call once per frame; returns whether the hint shows. */
  update(nowMs: number, inPond: boolean, others: number): boolean {
    if (!inPond || others > 0) {
      this.since = null;
      return false;
    }
    this.since ??= nowMs;
    return nowMs - this.since >= ALONE_AFTER_MS;
  }
}
