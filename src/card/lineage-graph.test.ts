import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bundleOf, lineageHistory } from '../../tests/lineage-fixture';
import { genomeToBase64url } from '../genome/codec';
import { genesisGenome } from '../genome/genesis';
import type { ProofBundle } from '../ledger/proof';
import type { StoredRecord } from '../ledger/record';
import { type LineageReport, verifyLineage } from '../ledger/verify';
import { seedFromString } from '../sim/prng';
import {
  type CardGraph,
  cardGraph,
  cardLink,
  GRAPH_NODE_HEIGHT,
  GRAPH_NODE_WIDTH,
  graphState,
  joinBundle,
  type Pedigree,
} from './lineage-graph';

// M9 T13: the card's lineage graph from the golden bundle (A1, born to A0 and B0, took over from
// A0) and from partial and synthetic ones.

const GOLDEN = new URL('../ledger/__golden__/lineage.json', import.meta.url);
const golden = (): ProofBundle => JSON.parse(readFileSync(GOLDEN, 'utf8')) as ProofBundle;
const history = lineageHistory();
const { A0, A1, B0 } = history.ids;

const fresh = (bundle: ProofBundle, report: LineageReport | null = null): Pedigree => {
  const p: Pedigree = new Map();
  joinBundle(p, bundle, report);
  return p;
};
const byId = (g: CardGraph) => new Map(g.nodes.map((n) => [n.id, n]));

/** Two node boxes overlap when they share any area. */
function overlaps(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return Math.abs(a.x - b.x) < GRAPH_NODE_WIDTH && Math.abs(a.y - b.y) < GRAPH_NODE_HEIGHT;
}

function expectNoOverlap(g: CardGraph): void {
  for (const [i, a] of g.nodes.entries()) {
    for (const b of g.nodes.slice(i + 1)) expect(overlaps(a, b), `${a.id} on ${b.id}`).toBe(false);
  }
}

/** The branch is one path of branch edges from the subject up to its last chain parent. */
function expectBranchPath(g: CardGraph, subject: string): string[] {
  const branch = g.nodes.filter((n) => n.branch).map((n) => n.id);
  const path = [subject];
  for (;;) {
    const at = path[path.length - 1] as string;
    const up = g.edges.filter((e) => e.branch && e.to === at);
    expect(up.length).toBeLessThanOrEqual(1);
    const edge = up[0];
    if (!edge) break;
    path.push(edge.from);
  }
  expect([...path].sort()).toEqual([...branch].sort());
  return path;
}

describe('the card lineage graph', () => {
  it('draws the golden: the subject at the bottom, both parents above it as roots', () => {
    const g = cardGraph(fresh(golden()), A1);
    expect(g.nodes.map((n) => n.id).sort()).toEqual([A0, A1, B0].sort());
    const n = byId(g);
    expect(n.get(A1)).toMatchObject({ subject: true, branch: true, root: false, loaded: true });
    expect(n.get(A1)?.generation).toBe(1);
    expect(n.get(A0)).toMatchObject({ branch: true, root: true, loaded: true, generation: 0 });
    expect(n.get(B0)).toMatchObject({ branch: false, root: true, loaded: true, generation: 0 });
    expect(n.get(A1)?.y).toBeGreaterThan(n.get(A0)?.y ?? Infinity);
    expect(n.get(A0)?.y).toBe(n.get(B0)?.y);
    expect(n.get(A0)?.species).toBeTruthy();
    expect(n.get(A0)?.tier).toBeTruthy();
    // One edge from each birth to each parent; only the chain parent's is on the branch.
    expect(g.edges).toHaveLength(2);
    expect(g.edges.find((e) => e.from === A0 && e.to === A1)?.branch).toBe(true);
    expect(g.edges.find((e) => e.from === B0 && e.to === A1)?.branch).toBe(false);
    expect(expectBranchPath(g, A1)).toEqual([A1, A0]);
    expectNoOverlap(g);
  });

  it('marks each node verified once the report comes, and a problem only on its creature', () => {
    const b = golden();
    expect(cardGraph(fresh(b), A1).nodes.every((n) => n.verified === null)).toBe(true);
    const report = verifyLineage(b);
    expect(report.problems).toEqual([]);
    expect(cardGraph(fresh(b, report), A1).nodes.every((n) => n.verified === true)).toBe(true);
    const failed: LineageReport = {
      ...report,
      problems: [{ creature: B0, seq: 1, family: 'chain', code: 'hash' }],
    };
    const n = byId(cardGraph(fresh(b, failed), A1));
    expect(n.get(B0)?.verified).toBe(false);
    expect(n.get(A0)?.verified).toBe(true);
    expect(n.get(A1)?.verified).toBe(true);
  });

  it('shows an ancestor the proof left out as not loaded, and joins it once loaded', () => {
    const partial = bundleOf(history, A1, [A0]);
    expect(partial.more).toEqual([A0]);
    const p = fresh(partial, verifyLineage(partial));
    let n = byId(cardGraph(p, A1));
    expect(n.get(A0)).toMatchObject({
      loaded: false,
      verified: null,
      root: false,
      branch: true,
      species: null,
    });
    // Its own bundle verified, then joined: now a loaded, verified genesis root.
    const own = bundleOf(history, A0);
    joinBundle(p, own, verifyLineage(own));
    n = byId(cardGraph(p, A1));
    expect(n.get(A0)).toMatchObject({ loaded: true, verified: true, root: true, branch: true });
    // Joining never redraws what was loaded: B0 keeps the subject's report.
    expect(n.get(B0)?.verified).toBe(true);
    expect(graphState(cardGraph(p, A1))).toContainEqual({
      id: A0,
      generation: 0,
      branch: true,
      root: true,
      verified: true,
      loaded: true,
    });
  });

  it('lays out a 64-creature pedigree within its box, with no overlap and one branch', () => {
    // A synthetic pedigree five generations deep: every creature born to two parents, the oldest
    // generation hatched, each child's chain parent its first parent.
    const genome = genomeToBase64url(genesisGenome(seedFromString('graph-64')));
    const id = (path: string): string => {
      let h = 0n;
      for (const c of `x${path}`) h = h * 3n + (c === '0' ? 1n : c === '1' ? 2n : 0n);
      return h.toString(16).padStart(64, '0');
    };
    const p: Pedigree = new Map();
    let count = 0;
    const walk = (path: string, level: number): void => {
      count++;
      const parents = level === 0 ? null : [id(`${path}0`), id(`${path}1`)];
      p.set(id(path), {
        id: id(path),
        genome,
        parents,
        chainParent: parents ? (parents[0] as string) : null,
        generation: level,
        verified: true,
        loaded: true,
        source: id(''),
      });
      if (level > 0) {
        walk(`${path}0`, level - 1);
        walk(`${path}1`, level - 1);
      }
    };
    walk('', 5);
    // One more creature, not loaded, above the leftmost root.
    const top = p.get(id('00000')) as NonNullable<ReturnType<Pedigree['get']>>;
    p.set(top.id, { ...top, parents: [id('000000'), id('000001')], generation: 1 });
    p.set(id('000000'), {
      id: id('000000'),
      genome: null,
      parents: null,
      chainParent: null,
      generation: null,
      verified: null,
      loaded: false,
      source: null,
    });
    expect(count + 1).toBe(64);
    const g = cardGraph(p, id(''));
    expect(g.nodes).toHaveLength(64);
    for (const n of g.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.x + GRAPH_NODE_WIDTH).toBeLessThanOrEqual(g.width);
      expect(n.y + GRAPH_NODE_HEIGHT).toBeLessThanOrEqual(g.height);
    }
    expectNoOverlap(g);
    // The subject and its chain parents back to the oldest generation.
    expect(expectBranchPath(g, id(''))).toHaveLength(6);
    // Only the parents a node names are drawn: 62 births to two parents and one more edge.
    expect(g.edges).toHaveLength(63);
  });

  it('ignores records that would loop the graph', () => {
    const b = golden();
    // A0's first record claiming to be born to A1: a cycle no honest proof holds.
    const records = b.records.map((s): StoredRecord => {
      if (s.hash !== A0) return s;
      return {
        ...s,
        record: { ...s.record, kind: 'birth', body: { ...s.record.body, parents: [A1, B0] } },
      } as StoredRecord;
    });
    const g = cardGraph(fresh({ ...b, records }), A1);
    expect(g.nodes).toHaveLength(3);
    expectNoOverlap(g);
  });
});

describe('cardLink', () => {
  const id = 'ab'.repeat(32);
  it('opens a card on its own', () => {
    expect(cardLink(id, '?c=00')).toBe(`card.html?c=${id}`);
  });
  it('carries the local hub and the preset over, and nothing else', () => {
    expect(cardLink(id, `?c=00&hub=http://localhost:8819&quality=high&debug=1`)).toBe(
      `card.html?c=${id}&hub=${encodeURIComponent('http://localhost:8819')}&quality=high`,
    );
  });
});
