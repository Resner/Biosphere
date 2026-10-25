/**
 * Defers the field query (food and plumes around the player) to the render frame: ticks only mark
 * it stale, so a burst of catch-up ticks costs one query.
 */
export function createFieldSync(refresh: () => void) {
  let dirty = true;
  return {
    markDirty(): void {
      dirty = true;
    },
    /** Refreshes if a tick made the field stale. */
    flush(): void {
      if (dirty) this.now();
    },
    /** Refreshes at once and clears the stale mark. */
    now(): void {
      dirty = false;
      refresh();
    },
  };
}
