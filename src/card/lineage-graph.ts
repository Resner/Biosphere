// The lineage graph on a creature card (M9 T13): the held creatures of one or more proof bundles, the
// subject at the bottom and the generations above it, laid out by the in-game panel's layout
// (`game/pedigree-layout.ts`). Pure and DOM-free; `graph-view.ts` draws it.
//
// - An edge runs from each birth to both parents.
// - The subject's branch is its chain of chain parents (the creature it took over from, and so on).
// - A genesis creature is a root.
// - Each node carries its own verified mark from the report of the bundle it came in.
// - An ancestor a proof left out (`more`) is a node not loaded, until its own bundle joins.

import { layoutPedigree, type PedigreePlace } from '../game/pedigree-layout';
import { parseGenomeText } from '../genome/codec';
import { speciesName } from '../genome/names';
import { type RarityTier, rarityOf } from '../genome/rarity';
import type { ProofBundle } from '../ledger/proof';
import { HEX64, type StoredRecord } from '../ledger/record';
import type { LineageReport } from '../ledger/verify';
import { creatureOf } from '../ledger/verify-chain';
import { int } from '../ledger/verify-gates';

export const GRAPH_NODE_WIDTH = 172;
export const GRAPH_NODE_HEIGHT = 56;
/** The space between two nodes of a row, and between two rows (where the edges run). */
export const GRAPH_GAP_X = 20;
export const GRAPH_GAP_Y = 44;
/** The margin around the graph, so a focus ring is never cut off by the scroll box. */
export const GRAPH_PAD = 8;

export interface PedigreeEntry {
  id: string;
  /** The genome text, null for a creature not loaded. */
  genome: string | null;
  /** The parents its birth names; null for a genesis creature or one not loaded. */
  parents: readonly string[] | null;
  /** The creature it took over from (its child `promote`), if any. */
  chainParent: string | null;
  generation: number | null;
  /** Its own records checked with no problem; null before a report, or when not loaded. */
  verified: boolean | null;
  loaded: boolean;
  /** The subject of the bundle it came in, whose report gives its mark; null when not loaded. */
  source: string | null;
}

/** Every creature the card knows of, by id. */
export type Pedigree = Map<string, PedigreeEntry>;

export interface CardGraphNode {
  id: string;
  species: string | null;
  generation: number | null;
  tier: RarityTier | null;
  /** This card's own creature. */
  subject: boolean;
  /** On the subject's branch: the subject and its chain parents. */
  branch: boolean;
  /** A genesis creature: hatched, not born. */
  root: boolean;
  verified: boolean | null;
  loaded: boolean;
  /** The top left corner, in pixels inside the graph's box. */
  x: number;
  y: number;
}

export interface CardGraphEdge {
  /** The parent, then the child. */
  from: string;
  to: string;
  /** The subject's branch: a child and the chain parent it took over from. */
  branch: boolean;
}

export interface CardGraph {
  nodes: CardGraphNode[];
  edges: CardGraphEdge[];
  width: number;
  height: number;
}

/** What `__card.state().graph` lists for each node. */
export type GraphNodeState = Pick<
  CardGraphNode,
  'id' | 'generation' | 'branch' | 'root' | 'verified' | 'loaded'
>;

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && HEX64.test(x)) : [];

/**
 * Joins a bundle's held creatures and its `more` to the pedigree, each with its mark from `report`
 * (null before the check ends). A creature already loaded from another bundle keeps what it had;
 * the same bundle joined again (with a later report) updates its marks.
 */
export function joinBundle(p: Pedigree, bundle: ProofBundle, report: LineageReport | null): void {
  const chains = new Map<string, StoredRecord[]>();
  for (const s of bundle.records) {
    const id = creatureOf(s);
    const chain = chains.get(id);
    if (chain) chain.push(s);
    else chains.set(id, [s]);
  }
  const failed = new Set(report?.problems.map((x) => x.creature));
  for (const { id, genome } of bundle.creatures) {
    const had = p.get(id);
    if (had?.loaded && had.source !== bundle.subject) continue;
    const chain = (chains.get(id) ?? []).sort((a, b) => a.record.seq - b.record.seq);
    const first = chain[0]?.record;
    const promote = chain.find((s) => s.record.kind === 'promote' && s.record.body.role === 'child')
      ?.record.body.parent;
    p.set(id, {
      id,
      genome,
      parents: first?.kind === 'birth' ? strings(first.body.parents) : null,
      chainParent: typeof promote === 'string' && HEX64.test(promote) ? promote : null,
      generation: int(first?.body.generation),
      verified: report ? !failed.has(id) : null,
      loaded: true,
      source: bundle.subject,
    });
  }
  for (const id of bundle.more) {
    if (p.has(id)) continue;
    p.set(id, {
      id,
      genome: null,
      parents: null,
      chainParent: null,
      generation: null,
      verified: null,
      loaded: false,
      source: null,
    });
  }
}

/** The graph of `subject` and every ancestor the pedigree reaches from it, laid out. */
export function cardGraph(p: Pedigree, subject: string): CardGraph {
  const parentsOf = (id: string): string[] => {
    const e = p.get(id);
    if (!e) return [];
    const all = [...(e.parents ?? []), ...(e.chainParent ? [e.chainParent] : [])];
    return [...new Set(all)].filter((x) => x !== id && p.has(x));
  };
  // Nearest first, so the layout breaks ties toward the subject.
  const ids: string[] = [];
  const seen = new Set<string>();
  let level = p.has(subject) ? [subject] : [];
  for (const id of level) seen.add(id);
  while (level.length > 0) {
    const next: string[] = [];
    for (const id of level) {
      ids.push(id);
      for (const parent of parentsOf(id)) {
        if (seen.has(parent)) continue;
        seen.add(parent);
        next.push(parent);
      }
    }
    level = next;
  }
  const branch = new Set<string>();
  for (let at = p.get(subject); at && !branch.has(at.id); ) {
    branch.add(at.id);
    at = at.chainParent ? p.get(at.chainParent) : undefined;
  }

  const layout = layoutPedigree(ids, parentsOf);
  const nodes = ids.map((id): CardGraphNode => {
    const e = p.get(id) as PedigreeEntry;
    const place = layout.places.get(id) as PedigreePlace;
    const genome = e.genome ? parseGenomeText(e.genome) : null;
    return {
      id,
      species: genome ? speciesName(genome) : null,
      generation: e.generation,
      tier: genome ? rarityOf(genome).tier : null,
      subject: id === subject,
      branch: branch.has(id),
      root: e.loaded && e.parents === null,
      verified: e.verified,
      loaded: e.loaded,
      x: GRAPH_PAD + place.across * (GRAPH_NODE_WIDTH + GRAPH_GAP_X),
      y: GRAPH_PAD + place.depth * (GRAPH_NODE_HEIGHT + GRAPH_GAP_Y),
    };
  });
  const edges = ids.flatMap((id) =>
    parentsOf(id).map((from) => ({
      from,
      to: id,
      branch: branch.has(id) && p.get(id)?.chainParent === from,
    })),
  );
  const span = (n: number, size: number, gap: number): number =>
    n === 0 ? 0 : 2 * GRAPH_PAD + n * size + (n - 1) * gap;
  return {
    nodes,
    edges,
    width: span(layout.breadth, GRAPH_NODE_WIDTH, GRAPH_GAP_X),
    height: span(layout.depth, GRAPH_NODE_HEIGHT, GRAPH_GAP_Y),
  };
}

export function graphState(g: CardGraph): GraphNodeState[] {
  return g.nodes.map(({ id, generation, branch, root, verified, loaded }) => ({
    id,
    generation,
    branch,
    root,
    verified,
    loaded,
  }));
}

/** The URL of a creature's card, carrying this page's local hub and preset over (for E2E). */
export function cardLink(id: string, search: string): string {
  const from = new URLSearchParams(search);
  const to = new URLSearchParams({ c: id });
  for (const key of ['hub', 'quality']) {
    const value = from.get(key);
    if (value) to.set(key, value);
  }
  return `card.html?${to}`;
}
