// The Lineage panel's view model (M5 T13): the player's chain, newest first, and the family graph
// behind it. Pure data in, plain data out; the DOM lives in lineage-panel.ts. No "pedigree",
// "ledger" or "chain_parent" in any text.

import { parseGenomeText } from '../genome/codec';
import { type RarityTier, rarityOf } from '../genome/rarity';
import type { LineageEntry, PedigreeNode } from '../net/protocol';
import { lifeLeftText } from './offspring-text';

/** Generations of ancestors the graph shows above the newest creature. */
export const GRAPH_GENERATIONS = 6;
/** Nodes the graph draws before it says "and more". */
export const GRAPH_MAX_NODES = 64;

export const COLUMN_WIDTH = 150;
export const ROW_HEIGHT = 40;
export const NODE_WIDTH = 120;
export const NODE_HEIGHT = 26;

export interface ChainRow {
  creature: string;
  species: string;
  generation: number;
  tier: RarityTier | '';
  /** "Swimming", "Egg", "Frozen" or "Gone"; the word, not only a colour. */
  state: string;
  /** Remaining life for a creature that can still live; "frozen" for a parent that waits, else empty. */
  life: string;
  genome: string;
}

export interface GraphNode {
  id: string;
  /** The name drawn in the node: the species for mine, "Another player" otherwise. */
  name: string;
  /** The full line for the tooltip. */
  label: string;
  /** Mine, or another player's creature (anonymous). */
  mine: boolean;
  /** On the chosen branch: the newest creature and its chain back. */
  branch: boolean;
  /** Has no parents on record: a genesis creature. */
  root: boolean;
  /** The genome to open in the Lab; empty when not known. */
  genome: string;
  x: number;
  y: number;
}

export interface GraphEdge {
  /** The parent, then the child. */
  from: string;
  to: string;
  branch: boolean;
}

export interface LineageView {
  empty: boolean;
  chain: ChainRow[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  width: number;
  height: number;
  /** True when more ancestors exist than the graph draws. */
  more: boolean;
}

const STATE: Record<LineageEntry['status'], string> = {
  active: 'Swimming',
  pending: 'Egg',
  checkpoint: 'Frozen',
  dead: 'Gone',
};

const tierOf = (genome: string): RarityTier | '' => {
  const parsed = parseGenomeText(genome);
  return parsed ? rarityOf(parsed).tier : '';
};

/** Newest first: the higher generation, then the one still swimming. */
function chainOrder(a: LineageEntry, b: LineageEntry): number {
  return b.generation - a.generation || a.creature.localeCompare(b.creature);
}

function chainRow(c: LineageEntry): ChainRow {
  let life = '';
  if (c.status === 'checkpoint') life = 'frozen';
  else if (c.status === 'active' || c.status === 'pending') life = lifeLeftText(c);
  return {
    creature: c.creature,
    species: c.species,
    generation: c.generation,
    tier: tierOf(c.genome),
    state: STATE[c.status],
    life,
    genome: c.genome,
  };
}

/** Ancestors within `GRAPH_GENERATIONS` of any of the roots, nearest first, and how many were left out. */
function collect(
  roots: readonly string[],
  parentsOf: ReadonlyMap<string, PedigreeNode>,
): { ids: string[]; more: boolean } {
  const ids: string[] = [];
  const level = new Map<string, number>();
  let more = false;
  let frontier = [...roots];
  for (const id of frontier) level.set(id, 0);
  for (let depth = 0; frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      if (ids.length >= GRAPH_MAX_NODES) {
        more = true;
        continue;
      }
      ids.push(id);
      const parents = parentsOf.get(id)?.parents;
      if (!parents) continue;
      if (depth >= GRAPH_GENERATIONS) {
        more = true;
        continue;
      }
      for (const p of parents) {
        if (level.has(p) || !parentsOf.has(p)) continue;
        level.set(p, depth + 1);
        next.push(p);
      }
    }
    frontier = next;
  }
  return { ids, more };
}

export function lineageView(
  creatures: readonly LineageEntry[],
  pedigree: readonly PedigreeNode[],
): LineageView {
  const chain = [...creatures].sort(chainOrder);
  const empty: LineageView = {
    empty: true,
    chain: [],
    nodes: [],
    edges: [],
    width: 0,
    height: 0,
    more: false,
  };
  if (chain.length === 0) return empty;

  const known = new Map<string, PedigreeNode>(pedigree.map((n) => [n.id, n]));
  const mine = new Map<string, LineageEntry>(chain.map((c) => [c.creature, c]));
  // A creature the pedigree lacks still shows, as a root with the data the chain has.
  for (const c of chain) {
    if (!known.has(c.creature)) {
      known.set(c.creature, {
        id: c.creature,
        parents: null,
        species: c.species,
        genome: c.genome,
      });
    }
  }

  // The chosen branch: the newest creature and the chain back from it.
  const branch = new Set<string>();
  let at: LineageEntry | undefined = chain[0];
  while (at && !branch.has(at.creature)) {
    branch.add(at.creature);
    at = at.chainParent ? mine.get(at.chainParent) : undefined;
  }

  const { ids, more } = collect(
    chain.map((c) => c.creature),
    known,
  );
  const shown = new Set(ids);
  // Oldest generation at the left: a column is the longest run of shown ancestors above a creature,
  // so a parent always sits left of its child, even when both are the player's own.
  const columns = new Map<string, number>();
  const columnOf = (id: string, seen: ReadonlySet<string>): number => {
    const memo = columns.get(id);
    if (memo !== undefined) return memo;
    const parents = (known.get(id)?.parents ?? []).filter((p) => shown.has(p) && !seen.has(p));
    const next = new Set(seen).add(id);
    const col = parents.length === 0 ? 0 : 1 + Math.max(...parents.map((p) => columnOf(p, next)));
    columns.set(id, col);
    return col;
  };
  const deepest = Math.max(...ids.map((id) => columnOf(id, new Set())));
  const rows = new Map<number, number>();
  const nodes: GraphNode[] = ids.map((id) => {
    const node = known.get(id) as PedigreeNode;
    const column = columnOf(id, new Set());
    const row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    const own = mine.get(id);
    return {
      id,
      name: own ? node.species : 'Another player',
      label: own
        ? `${node.species}, generation ${own.generation}`
        : `${node.species} (another player)`,
      mine: own !== undefined,
      branch: branch.has(id),
      root: node.parents === null,
      genome: node.genome,
      x: column * COLUMN_WIDTH,
      y: row * ROW_HEIGHT,
    };
  });
  const edges: GraphEdge[] = [];
  for (const id of ids) {
    const parents = known.get(id)?.parents;
    if (!parents) continue;
    for (const p of parents) {
      if (shown.has(p)) edges.push({ from: p, to: id, branch: branch.has(p) && branch.has(id) });
    }
  }
  return {
    empty: false,
    chain: chain.map(chainRow),
    nodes,
    edges,
    width: deepest * COLUMN_WIDTH + NODE_WIDTH,
    height: Math.max(...rows.values()) * ROW_HEIGHT,
    more,
  };
}
