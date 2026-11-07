// Crowd instances (M12, ADR 0064), shared by the page, the hub and the harness. A crowded area is
// split into instances of at most `INSTANCE_MAX`; creatures of different instances can't see or
// affect each other, and the open water (instance 0) around a crowd shares water with every one.

/** A page that wants this many links of P0 and P1 that share its water is crowded. */
export const CROWD_AT = 24;
/** A crowded page's `where` carries its crowd at once, then this often while it stays crowded. */
export const CROWD_EVERY_MS = 10_000;
/** The members an instance is filled to (fixture `INSTANCE_MAX` 1–16). */
export const INSTANCE_MAX = 16;

/** Whether creatures in instances `a` and `b` share water: the same instance, or either in the open water. */
export function sameWater(a: number, b: number): boolean {
  return a === b || a === 0 || b === 0;
}
