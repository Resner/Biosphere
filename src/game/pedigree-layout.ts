// The family graph's layout (M9 T13), shared by the in-game Lineage panel and the creature card so
// both draw the same graph. DOM-free: ids and their parents in, a place per id out. Each caller turns
// places into its own coordinates (the panel runs generations left to right, the card top to bottom).

export interface PedigreePlace {
  /** The row of generations, 0 for the oldest: every parent sits in an earlier row than its child. */
  depth: number;
  /** The place across the row, from 0 to `breadth - 1`; rows narrower than the widest are centred. */
  across: number;
}

export interface PedigreeLayout {
  places: Map<string, PedigreePlace>;
  /** How many rows. */
  depth: number;
  /** The widest row's count. */
  breadth: number;
}

/**
 * Lays out `ids` (in their order of priority: the newest first) by `parentsOf`, which may name
 * creatures outside `ids` (they are left out).
 *
 * - A row is the longest run of ancestors above a creature, so a parent always sits above its child.
 * - A creature with children then moves down to just above its nearest child, so a parent with no
 *   ancestors sits beside its mate rather than with the oldest generation.
 * - Within a row, from the newest up, each creature sits over the middle of its children, which
 *   keeps each side of a family on its own side.
 */
export function layoutPedigree(
  ids: readonly string[],
  parentsOf: (id: string) => readonly string[],
): PedigreeLayout {
  const shown = new Set(ids);
  const order = new Map(ids.map((id, i) => [id, i]));
  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const id of ids) {
    const own = [...new Set(parentsOf(id))].filter((p) => p !== id && shown.has(p));
    parents.set(id, own);
    for (const p of own) children.get(p)?.push(id);
  }

  // The longest run of ancestors above each creature; `seen` breaks a cycle no honest record makes.
  const rank = new Map<string, number>();
  const rankOf = (id: string, seen: ReadonlySet<string>): number => {
    const memo = rank.get(id);
    if (memo !== undefined) return memo;
    const above = (parents.get(id) ?? []).filter((p) => !seen.has(p));
    const next = new Set(seen).add(id);
    const r = above.length === 0 ? 0 : 1 + Math.max(...above.map((p) => rankOf(p, next)));
    rank.set(id, r);
    return r;
  };
  for (const id of ids) rankOf(id, new Set());

  // Children first, each parent moves down to just above its nearest child (never up).
  const byRank = [...ids].sort((a, b) => (rank.get(b) ?? 0) - (rank.get(a) ?? 0));
  for (const id of byRank) {
    const below = children.get(id) ?? [];
    if (below.length === 0) continue;
    const r = Math.min(...below.map((c) => rank.get(c) ?? 0)) - 1;
    if (r > (rank.get(id) ?? 0)) rank.set(id, r);
  }

  const lowest = ids.length === 0 ? 0 : Math.min(...ids.map((id) => rank.get(id) ?? 0));
  const rows = new Map<number, string[]>();
  for (const id of ids) {
    const r = (rank.get(id) ?? 0) - lowest;
    const row = rows.get(r);
    if (row) row.push(id);
    else rows.set(r, [id]);
  }
  const depth = rows.size === 0 ? 0 : Math.max(...rows.keys()) + 1;
  const breadth = Math.max(0, ...[...rows.values()].map((row) => row.length));

  const places = new Map<string, PedigreePlace>();
  for (let r = depth - 1; r >= 0; r--) {
    const row = rows.get(r) ?? [];
    // Over the middle of its children already placed; a creature with none keeps its order, last.
    const key = (id: string): number => {
      const xs = (children.get(id) ?? []).flatMap((c) => {
        const at = places.get(c);
        return at ? [at.across] : [];
      });
      return xs.length === 0 ? Number.POSITIVE_INFINITY : xs.reduce((s, x) => s + x, 0) / xs.length;
    };
    const keys = new Map(row.map((id) => [id, key(id)]));
    row.sort(
      (a, b) =>
        (keys.get(a) ?? 0) - (keys.get(b) ?? 0) || (order.get(a) ?? 0) - (order.get(b) ?? 0),
    );
    const offset = (breadth - row.length) / 2;
    for (const [slot, id] of row.entries()) places.set(id, { depth: r, across: slot + offset });
  }
  return { places, depth, breadth };
}
