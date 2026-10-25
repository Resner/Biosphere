import { describe, expect, it } from 'vitest';
import { consumeFood } from '../sim/food';
import { createWorld } from '../sim/world';
import { ClaimBook, ConsumedJoin, consumedParts } from './claims';
import { CONSUMED_MAX_ENTRIES, EVENT_MAX_BYTES, parsePeerEvent } from './protocol';

const world = (tick = 0) => {
  const w = createWorld({ seed: 'pond-claims', currents: false, hazards: false });
  w.tick = tick;
  return w;
};
const SLOT = 'c3_5_s2';
const ITEM = `${SLOT}_k0`;

describe('ClaimBook', () => {
  it('keeps the earlier eater and reverses the later one', () => {
    // A ate at tick 100, B at 103; each client sees its own bite first, then the other's claim.
    const wa = world(100);
    const a = new ClaimBook('A');
    consumeFood(wa, ITEM);
    a.local({ slot: SLOT, k: 0, tick: 100 }, 12);
    const wb = world(103);
    const b = new ClaimBook('B');
    consumeFood(wb, ITEM);
    b.local({ slot: SLOT, k: 0, tick: 103 }, 12);

    expect(a.remote(wa, { t: 'claim', slot: SLOT, k: 0, tick: 103 }, 'B')).toBeNull();
    expect(b.remote(wb, { t: 'claim', slot: SLOT, k: 0, tick: 100 }, 'A')).toEqual({
      slot: SLOT,
      k: 0,
      value: 12,
    });
    expect(wa.consumed[SLOT]).toEqual(wb.consumed[SLOT]);
  });

  it('breaks a tick tie by the lower playerId', () => {
    const wa = world(100);
    const a = new ClaimBook('A');
    consumeFood(wa, ITEM);
    a.local({ slot: SLOT, k: 0, tick: 100 }, 5);
    expect(a.remote(wa, { t: 'claim', slot: SLOT, k: 0, tick: 100 }, 'B')).toBeNull();
    const wb = world(100);
    const b = new ClaimBook('B');
    consumeFood(wb, ITEM);
    b.local({ slot: SLOT, k: 0, tick: 100 }, 5);
    expect(b.remote(wb, { t: 'claim', slot: SLOT, k: 0, tick: 100 }, 'A')?.value).toBe(5);
  });

  it('converges whatever order three claims arrive in', () => {
    const claims = [
      { from: 'C', tick: 101 },
      { from: 'B', tick: 103 },
      { from: 'D', tick: 101 },
    ];
    const orders = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    const reference = world(101);
    consumeFood(reference, ITEM); // the tick-101 eater with the lower id (C) wins
    for (const order of orders) {
      const w = world(500);
      const book = new ClaimBook('Z');
      for (const i of order) {
        const c = claims[i] as { from: string; tick: number };
        book.remote(w, { t: 'claim', slot: SLOT, k: 0, tick: c.tick }, c.from);
      }
      expect(w.consumed[SLOT]).toEqual(reference.consumed[SLOT]);
    }
  });

  it('ignores a claim for an older cycle', () => {
    const w = world(0);
    const book = new ClaimBook('Z');
    book.remote(w, { t: 'claim', slot: SLOT, k: 1, tick: 900 }, 'B');
    const before = structuredClone(w.consumed);
    expect(book.remote(w, { t: 'claim', slot: SLOT, k: 0, tick: 10 }, 'C')).toBeNull();
    expect(w.consumed).toEqual(before);
  });

  it('does not reverse a bite twice and ignores invalid slots', () => {
    const w = world(103);
    const book = new ClaimBook('B');
    consumeFood(w, ITEM);
    book.local({ slot: SLOT, k: 0, tick: 103 }, 12);
    const claim = { t: 'claim', slot: SLOT, k: 0, tick: 100 } as const;
    expect(book.remote(w, claim, 'A')).not.toBeNull();
    expect(book.remote(w, claim, 'A')).toBeNull();
    expect(book.remote(w, { t: 'claim', slot: 'c99_0_s0', k: 0, tick: 1 }, 'A')).toBeNull();
  });

  it('adopts a claim that arrives for a cycle it never saw eaten', () => {
    const w = world(0);
    const book = new ClaimBook('Z');
    expect(book.remote(w, { t: 'claim', slot: SLOT, k: 0, tick: 40 }, 'B')).toBeNull();
    expect(w.consumed[SLOT]?.k).toBe(1);
  });
});

describe('late join', () => {
  const big = (n: number) => {
    const w = world(0);
    for (let i = 0; i < n; i++) {
      w.consumed[`c${i % 32}_${Math.floor(i / 32) % 32}_s${i % 10}`] = {
        k: 1 + (i % 3),
        until: 100 + i,
      };
    }
    return w;
  };

  it('splits 500 entries into parts under 40 entries and 2 KB', () => {
    const parts = consumedParts(big(500));
    expect(Object.keys(big(500).consumed).length).toBe(500);
    for (const part of parts) {
      expect(part.entries.length).toBeLessThanOrEqual(CONSUMED_MAX_ENTRIES);
      expect(JSON.stringify(part).length).toBeLessThan(EVENT_MAX_BYTES);
      expect(parsePeerEvent(JSON.stringify(part))).toEqual(part);
    }
    expect(parts.every((p, i) => p.part === i && p.of === parts.length)).toBe(true);
  });

  it('sends one empty part for an empty set', () => {
    expect(consumedParts(world())).toEqual([{ t: 'consumed', part: 0, of: 1, entries: [] }]);
  });

  it('rebuilds the sender set from shuffled and duplicated parts', () => {
    const source = big(500);
    const parts = consumedParts(source);
    const shuffled = [...parts, ...parts.slice(0, 3)].sort(
      (a, b) => ((a.part * 7) % 11) - ((b.part * 7) % 11),
    );
    const joiner = world(0);
    const join = new ConsumedJoin();
    for (const part of shuffled) join.receive(joiner, 'P1', part);
    expect(join.complete).toBe(true);
    expect(joiner.consumed).toEqual(source.consumed);
  });

  it('stays incomplete when a part is lost, and the next peer completes it', () => {
    const source = big(500);
    const parts = consumedParts(source);
    const joiner = world(0);
    const join = new ConsumedJoin();
    parts.forEach((part, i) => {
      if (i !== 4) join.receive(joiner, 'P1', part);
    });
    expect(join.complete).toBe(false);
    for (const part of parts) join.receive(joiner, 'P2', part);
    expect(join.complete).toBe(true);
    expect(joiner.consumed).toEqual(source.consumed);
  });

  it('keeps the higher cycle and the earlier respawn when merging', () => {
    const joiner = world(0);
    joiner.consumed[SLOT] = { k: 2, until: 900 };
    joiner.consumed.c1_1_s1 = { k: 1, until: 800 };
    const join = new ConsumedJoin();
    join.receive(joiner, 'P1', {
      t: 'consumed',
      part: 0,
      of: 1,
      entries: [
        [SLOT, 1, 100],
        ['c1_1_s1', 1, 700],
        ['c2_2_s2', 4, 50],
      ],
    });
    expect(joiner.consumed).toEqual({
      [SLOT]: { k: 2, until: 900 },
      c1_1_s1: { k: 1, until: 700 },
      c2_2_s2: { k: 4, until: 50 },
    });
  });

  it('ignores entries outside the grid and inconsistent part counts', () => {
    const joiner = world(0);
    const join = new ConsumedJoin();
    join.receive(joiner, 'P1', { t: 'consumed', part: 0, of: 2, entries: [['c99_0_s0', 1, 5]] });
    join.receive(joiner, 'P1', { t: 'consumed', part: 1, of: 3, entries: [] });
    expect(joiner.consumed).toEqual({});
    expect(join.complete).toBe(false);
  });
});
