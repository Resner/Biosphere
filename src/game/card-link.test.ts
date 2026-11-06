import { describe, expect, it } from 'vitest';
import { genomeToBase64url } from '../genome/codec';
import { genesisGenome } from '../genome/genesis';
import type { LineageEntry, PedigreeNode } from '../net/protocol';
import { seedFromString } from '../sim/prng';
import { cardHref } from './card-link';
import { lineageView } from './lineage-view';

const id = (n: number): string => n.toString(16).padStart(64, '0');
const text = genomeToBase64url(genesisGenome(seedFromString('card-link-test')));
const HUB = 'http://localhost:8820';
const WITH_HUB = `?debug=1&hub=${encodeURIComponent(HUB)}`;

const entry = (n: number, chainParent: string | null): LineageEntry => ({
  creature: id(n),
  status: 'active',
  generation: chainParent ? 1 : 0,
  species: `Species ${n}`,
  genome: text,
  activeMs: 0,
  lifespanMs: 3_600_000,
  hash: id(900 + n),
  chainParent,
});
const node = (n: number, parents: [number, number] | null): PedigreeNode => ({
  id: id(n),
  parents: parents && [id(parents[0]), id(parents[1])],
  species: `Species ${n}`,
  genome: text,
});

// The player's child (2) of their genesis creature (1) and another player's creature (3).
const view = lineageView(
  [entry(2, id(1)), entry(1, null)],
  [node(2, [1, 3]), node(1, null), node(3, null)],
);

describe('cardHref', () => {
  it("links each of the player's creatures in the Lineage section to its card", () => {
    expect(view.chain.map((row) => cardHref(row.creature, ''))).toEqual([
      `card.html?c=${id(2)}`,
      `card.html?c=${id(1)}`,
    ]);
  });

  it('links each pedigree node with a known id, another player’s creature too', () => {
    const other = view.nodes.find((n) => !n.mine);
    expect(other?.id).toBe(id(3));
    expect(cardHref(other?.id ?? null, '')).toBe(`card.html?c=${id(3)}`);
    expect(view.nodes.map((n) => cardHref(n.id, '')).every((h) => h !== null)).toBe(true);
  });

  it('links the dead creature on the death screen, and nothing for a practice cell', () => {
    expect(cardHref(id(7), '')).toBe(`card.html?c=${id(7)}`);
    expect(cardHref(null, '')).toBeNull();
  });

  it('gives no link for an id that is not a creature id', () => {
    expect(cardHref('', '')).toBeNull();
    expect(cardHref('abc', '')).toBeNull();
    expect(cardHref(`${id(1)}0`, '')).toBeNull();
    expect(cardHref('Z'.repeat(64), '')).toBeNull();
  });

  it('carries a local ?hub= over, in every place', () => {
    const want = (n: number): string => `card.html?c=${id(n)}&hub=${encodeURIComponent(HUB)}`;
    expect(cardHref(view.chain[0]?.creature ?? null, WITH_HUB)).toBe(want(2));
    expect(cardHref(view.nodes.find((n) => !n.mine)?.id ?? null, WITH_HUB)).toBe(want(3));
    expect(cardHref(id(7), `?hub=${HUB}`)).toBe(want(7));
  });

  it('drops a ?hub= the card would ignore, and every other parameter', () => {
    expect(cardHref(id(1), '?hub=https://evil.example&debug=1&quality=high')).toBe(
      `card.html?c=${id(1)}`,
    );
    expect(cardHref(id(1), '?hub=not a url')).toBe(`card.html?c=${id(1)}`);
  });
});
