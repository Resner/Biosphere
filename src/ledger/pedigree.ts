// Pedigree maths (M5 T5, ADR 0021): Malécot's coefficient of kinship on the birth records, six
// generations deep, and the inbreeding bands the mate card shows. Pure and deterministic; the
// authority builds the pedigree from SQL and the client from the `lineage` message. The client shows
// the numbers as a warning and never uses them as a rule.

/** Creature id -> its two parents, null for a genesis creature. An id the map lacks is a founder. */
export type Pedigree = ReadonlyMap<string, readonly [string, string] | null>;

/** Ancestors further up than this, counted from each queried creature, are ignored. */
export const KINSHIP_GENERATIONS = 6;

/** The longest chain down to a founder; it orders two creatures so the younger one is expanded first. */
function generations(p: Pedigree, cache: Map<string, number>, root: string): number {
  const known = cache.get(root);
  if (known !== undefined) return known;
  const stack = [root];
  const open = new Set(stack);
  while (stack.length > 0) {
    const id = stack[stack.length - 1] as string;
    const parents = p.get(id);
    if (!parents) {
      cache.set(id, 0);
      open.delete(stack.pop() as string);
      continue;
    }
    const missing = parents.filter((q) => !cache.has(q));
    if (missing.length === 0) {
      cache.set(id, 1 + Math.max(cache.get(parents[0]) as number, cache.get(parents[1]) as number));
      open.delete(stack.pop() as string);
      continue;
    }
    for (const q of missing) {
      // A parent already on the path is a cycle in malformed data: break it so the walk ends.
      if (open.has(q)) cache.set(q, 0);
      else {
        open.add(q);
        stack.push(q);
      }
    }
  }
  return cache.get(root) as number;
}

class Kin {
  private readonly gens = new Map<string, number>();
  private readonly memo = new Map<string, number>();

  constructor(private readonly p: Pedigree) {}

  /** `la` and `lb` count the generations above each queried creature that `a` and `b` sit. */
  phi(a: string, b: string, la: number, lb: number): number {
    const key = `${a}|${b}|${la}|${lb}`;
    const known = this.memo.get(key);
    if (known !== undefined) return known;
    const value = this.compute(a, b, la, lb);
    this.memo.set(key, value);
    return value;
  }

  private compute(a: string, b: string, la: number, lb: number): number {
    if (a === b) {
      const parents = this.p.get(a);
      const f =
        parents && Math.max(la, lb) < KINSHIP_GENERATIONS
          ? this.phi(parents[0], parents[1], la + 1, lb + 1)
          : 0;
      return 0.5 * (1 + f);
    }
    const older = generations(this.p, this.gens, a) < generations(this.p, this.gens, b);
    // Only a younger creature can descend from the other, so expand the younger (the first on a tie).
    const [x, other, lx, lo] = older ? [b, a, lb, la] : [a, b, la, lb];
    const parents = this.p.get(x);
    if (!parents || lx >= KINSHIP_GENERATIONS) return 0;
    const at = (parent: string): number =>
      older ? this.phi(other, parent, lo, lx + 1) : this.phi(parent, other, lx + 1, lo);
    return 0.5 * (at(parents[0]) + at(parents[1]));
  }
}

/** Coefficient of kinship of two creatures: the chance that a random allele of each is a copy of one ancestor's. */
export function kinship(p: Pedigree, a: string, b: string): number {
  return new Kin(p).phi(a, b, 0, 0);
}

/** A creature's own inbreeding: the kinship of its parents (0 for a founder). */
export function inbreeding(p: Pedigree, id: string): number {
  const parents = p.get(id);
  return parents ? new Kin(p).phi(parents[0], parents[1], 1, 1) : 0;
}

export type InbreedingBand = 'none' | 'low' | 'moderate' | 'high';

/** DESIGN §5: none under 3%, low under 10%, moderate under 20%, else high. */
export function inbreedingBand(f: number): InbreedingBand {
  return f < 0.03 ? 'none' : f < 0.1 ? 'low' : f < 0.2 ? 'moderate' : 'high';
}

export const BAND_TEXT: Readonly<Record<InbreedingBand, string>> = {
  none: 'Not related: a healthy mix.',
  low: 'Distant relatives: weak offspring are a little more likely.',
  moderate: 'Close relatives: weak offspring are noticeably more likely.',
  high: 'Very close relatives: weak offspring are much more likely.',
};
