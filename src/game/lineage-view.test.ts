import { describe, expect, it } from 'vitest';
import { genomeToBase64url } from '../genome/codec';
import { genesisGenome } from '../genome/genesis';
import type { LineageEntry, PedigreeNode } from '../net/protocol';
import { seedFromString } from '../sim/prng';
import { GRAPH_GENERATIONS, GRAPH_MAX_NODES, lineageView } from './lineage-view';

const id = (n: number): string => n.toString(16).padStart(64, '0');
const text = genomeToBase64url(genesisGenome(seedFromString('lineage-test')));

function entry(n: number, over: Partial<LineageEntry> = {}): LineageEntry {
  return {
    creature: id(n),
    status: 'checkpoint',
    generation: 0,
    species: `Species ${n}`,
    genome: text,
    activeMs: 0,
    lifespanMs: 3_600_000,
    hash: id(900 + n),
    chainParent: null,
    ...over,
  };
}
const node = (n: number, parents: [number, number] | null): PedigreeNode => ({
  id: id(n),
  parents: parents && [id(parents[0]), id(parents[1])],
  species: `Species ${n}`,
  genome: text,
});

describe('lineageView', () => {
  it('says empty when there is no lineage', () => {
    const v = lineageView([], []);
    expect(v.empty).toBe(true);
    expect(v.nodes).toEqual([]);
  });

  it('orders the chain newest first and words each state', () => {
    const v = lineageView(
      [
        entry(1, { generation: 0, status: 'dead' }),
        entry(3, { generation: 2, status: 'active', activeMs: 3_000_000, chainParent: id(2) }),
        entry(2, { generation: 1, status: 'checkpoint', chainParent: id(1) }),
      ],
      [],
    );
    expect(v.chain.map((r) => r.generation)).toEqual([2, 1, 0]);
    expect(v.chain.map((r) => r.state)).toEqual(['Swimming', 'Frozen', 'Gone']);
    expect(v.chain[0]?.life).toBe('about 10 min of life left');
    expect(v.chain[1]?.life).toBe('frozen');
    expect(v.chain[2]?.life).toBe('');
    expect(v.chain[0]?.tier).not.toBe('');
  });

  it('draws both parents and the sibling, and highlights the chosen branch', () => {
    // 3 is the child of 1 (mine) and 2 (another player's); 4 is its sibling, a pending egg.
    const v = lineageView(
      [
        entry(1, { status: 'checkpoint' }),
        entry(3, { generation: 1, status: 'active', chainParent: id(1) }),
        entry(4, { generation: 1, status: 'pending', chainParent: id(1) }),
      ],
      [node(1, null), node(2, null), node(3, [1, 2]), node(4, [1, 2])],
    );
    expect(v.nodes.map((n) => n.id).sort()).toEqual([id(1), id(2), id(3), id(4)]);
    expect(v.edges).toHaveLength(4);
    const byId = new Map(v.nodes.map((n) => [n.id, n]));
    expect(byId.get(id(2))?.mine).toBe(false);
    expect(byId.get(id(2))?.label).toContain('another player');
    expect(byId.get(id(1))?.root).toBe(true);
    expect(byId.get(id(3))?.branch).toBe(true);
    expect(byId.get(id(1))?.branch).toBe(true);
    expect(byId.get(id(4))?.branch).toBe(false);
    expect(v.edges.find((e) => e.from === id(1) && e.to === id(3))?.branch).toBe(true);
    expect(v.edges.find((e) => e.from === id(2) && e.to === id(3))?.branch).toBe(false);
    // Oldest on the left.
    expect(byId.get(id(1))?.x).toBeLessThan(byId.get(id(3))?.x ?? 0);
    expect(v.more).toBe(false);
  });

  it('shows a creature the pedigree lacks as a root', () => {
    const v = lineageView([entry(1, { status: 'active' })], []);
    expect(v.nodes).toHaveLength(1);
    expect(v.nodes[0]?.root).toBe(true);
  });

  it('stops six generations back and says there is more', () => {
    const depth = GRAPH_GENERATIONS + 3;
    const nodes: PedigreeNode[] = [node(0, null), node(1000, null)];
    for (let i = 1; i <= depth; i++) nodes.push(node(i, [i - 1, 1000]));
    const v = lineageView([entry(depth, { status: 'active' })], nodes);
    expect(v.more).toBe(true);
    expect(v.nodes.some((n) => n.id === id(0))).toBe(false);
    expect(v.nodes.some((n) => n.id === id(depth - GRAPH_GENERATIONS))).toBe(true);
  });

  it('truncates at 64 nodes', () => {
    // A wide family: one child with many ancestors across few generations.
    const nodes: PedigreeNode[] = [];
    let next = 1;
    const build = (level: number): number => {
      const me = next++;
      if (level === 0 || next > 200) {
        nodes.push(node(me, null));
        return me;
      }
      const a = build(level - 1);
      const b = build(level - 1);
      nodes.push(node(me, [a, b]));
      return me;
    };
    const top = build(6);
    const v = lineageView([entry(top, { status: 'active' })], nodes);
    expect(v.nodes.length).toBeLessThanOrEqual(GRAPH_MAX_NODES);
    expect(v.more).toBe(true);
    const ids = new Set(v.nodes.map((n) => n.id));
    for (const e of v.edges) expect(ids.has(e.from) && ids.has(e.to)).toBe(true);
  });

  it('uses no record words in any text', () => {
    const v = lineageView([entry(1, { status: 'active' })], [node(1, null)]);
    const all = JSON.stringify([
      v.chain.map((r) => [r.state, r.life]),
      v.nodes.map((n) => n.label),
    ]);
    expect(all).not.toMatch(/pedigree|ledger|chain_parent|checkpoint/i);
  });
});
