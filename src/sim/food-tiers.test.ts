import { describe, expect, it } from 'vitest';
import { speedTest } from '../../tests/heavy';
import { type Mouth, STARTER_PHYS } from './body';
import {
  applyFeeding,
  applyRemoteClaim,
  consumeFood,
  efficiency,
  foodInCell,
  foodNear,
  isFoodSlot,
  parseFoodId,
  slotAnchor,
} from './food';
import { RULES } from './rules';
import { step } from './step';
import type { FoodItem, FoodKind, World } from './types';
import { createWorld, spawnCreature } from './world';

const world = (seed = 'tiers', size?: number) =>
  createWorld({ seed, size: size ?? 8192, currents: false, hazards: false });

/** Biomass at the bottom of each tier: radius 32 × 4^t, squared. */
const BIOMASS = [100, 1024, 16384, 262144];
const MIDDLE: Mouth = { offset: 0.9, radius: 0.35, arc: 3, type: 0.5, digestion: 1 };

/** The first live item of `kind` in layer `layer`. */
function findItem(w: World, layer: number, kind: FoodKind): { item: FoodItem; cx: number } {
  const n = Math.floor(w.size / (RULES.world.cellSize * 4 ** layer));
  for (let cy = 0; cy < n; cy++) {
    for (let cx = 0; cx < n; cx++) {
      const item = foodInCell(w, cx, cy, layer).find((i) => i.kind === kind);
      if (item) return { item, cx };
    }
  }
  throw new Error(`no ${kind} in layer ${layer}`);
}

/** A creature of tier `tier` over `item`, hungry, with a wide middle mouth that reaches it. */
function over(w: World, tier: number, item: FoodItem) {
  const biomass = BIOMASS[tier] as number;
  const creature = spawnCreature(w, {
    id: 'p',
    x: item.x - MIDDLE.offset * Math.sqrt(biomass),
    y: item.y,
    biomass,
    phys: { ...STARTER_PHYS, mouth: MIDDLE },
  });
  creature.energy = 1;
  return creature;
}

const ate = (w: World, tier: number, item: FoodItem) => {
  const creature = over(w, tier, item);
  return applyFeeding(w, creature).flatMap((e) => (e.type === 'eat' ? [e] : []));
};

describe('food layers', () => {
  it('name layer k ≥ 1 items t<k>c<x>_<y>_s<slot>_k<cycle> and keep layer 0 as it was', () => {
    const w = world();
    expect(foodInCell(w, 3, 5)[2]?.id).toBe('c3_5_s2_k0');
    expect(foodInCell(w, 3, 5, 0)[2]?.id).toBe('c3_5_s2_k0');
    expect(foodInCell(w, 3, 5, 1)[2]?.id).toBe('t1c3_5_s2_k0');
    expect(foodInCell(w, 1, 1, 2)[9]?.id).toBe('t2c1_1_s9_k0');
    expect(foodInCell(w, 1, 1, 2).at(-1)?.id).toBe(
      `t2c1_1_s${RULES.food.layers.slotsPerCell - 1}_k0`,
    );
  });

  it('puts a layer’s slots in a cell of 256 × 4^k wu, 4^k times as wide and richness^k times as rich', () => {
    const w = world('scale', 262144);
    for (const layer of [1, 2, 3, 4]) {
      const cell = RULES.world.cellSize * 4 ** layer;
      const items = foodInCell(w, 2, 3, layer);
      expect(items).toHaveLength(RULES.food.layers.slotsPerCell);
      for (const item of items) {
        const base = RULES.food.kinds[item.kind];
        expect(item.value).toBe(base.value * RULES.food.layers.richnessStep ** layer);
        expect(item.radius).toBe(base.radius * 4 ** layer);
        expect(item.x).toBeGreaterThanOrEqual(2 * cell - 12 * 4 ** layer);
        expect(item.x).toBeLessThanOrEqual(3 * cell + 12 * 4 ** layer);
        expect(item.y).toBeGreaterThanOrEqual(3 * cell - 12 * 4 ** layer);
        expect(item.y).toBeLessThanOrEqual(4 * cell + 12 * 4 ** layer);
      }
    }
  });

  it('has a grid of 256 × 4^k wu cells: none outside it, and a layer too coarse for a pond is empty', () => {
    const w = world();
    expect(foodInCell(w, 7, 7, 1)).toHaveLength(RULES.food.layers.slotsPerCell);
    expect(foodInCell(w, 8, 0, 1)).toEqual([]);
    expect(foodInCell(w, 1, 1, 2)).toHaveLength(RULES.food.layers.slotsPerCell);
    expect(foodInCell(w, 2, 0, 2)).toEqual([]);
    expect(foodInCell(w, 0, 0, 3)).toEqual([]);
  });

  it('draws each layer from its own hash stream, and each layer is a pure function of the seed', () => {
    const a = world('hash');
    const b = world('hash');
    const l0 = foodInCell(a, 0, 0, 0).map((i) => [i.x, i.y]);
    expect(foodInCell(a, 0, 0, 1).map((i) => [i.x, i.y])).not.toEqual(l0);
    expect(foodInCell(b, 2, 1, 1)).toEqual(foodInCell(a, 2, 1, 1));
    expect(slotAnchor(a, 2, 1, 3, 0, 1)).toEqual(slotAnchor(b, 2, 1, 3, 0, 1));
  });

  it('are found by foodNear per layer, across cell borders', () => {
    const w = world();
    const found = foodNear(w, 2048, 2048, 700, 1);
    const brute: FoodItem[] = [];
    for (let cy = 0; cy < 8; cy++) {
      for (let cx = 0; cx < 8; cx++) {
        for (const i of foodInCell(w, cx, cy, 1)) {
          if ((i.x - 2048) ** 2 + (i.y - 2048) ** 2 <= 700 * 700) brute.push(i);
        }
      }
    }
    expect(found.length).toBeGreaterThan(0);
    expect(found.map((i) => i.id).sort()).toEqual(brute.map((i) => i.id).sort());
    expect(foodNear(w, 2048, 2048, 700).every((i) => !i.id.startsWith('t'))).toBe(true);
  });
});

describe('who eats what', () => {
  it('lets a T1 creature eat layer-1 detritus for 8 × richness × efficiency × digestion', () => {
    const w = world();
    const { item } = findItem(w, 1, 'detritus');
    const events = ate(w, 1, item).filter((e) => e.food === item.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.value).toBeCloseTo(
      8 * RULES.food.layers.richnessStep * efficiency('detritus', 0.5) * MIDDLE.digestion,
    );
    expect(foodInCell(w, ...cellOf(item, 1), 1).map((i) => i.id)).not.toContain(item.id);
  });

  it('lets a T0 creature pass through layer-1 items', () => {
    const w = world();
    const { item } = findItem(w, 1, 'detritus');
    expect(ate(w, 0, item).filter((e) => e.food.startsWith('t1'))).toEqual([]);
    expect(foodNear(w, item.x, item.y, 1, 1).map((i) => i.id)).toContain(item.id);
  });

  it('lets a T1 creature eat layer-0 items too, and a T2 creature never', () => {
    const w = world();
    const { item } = findItem(w, 0, 'detritus');
    expect(ate(w, 1, item).map((e) => e.food)).toContain(item.id);
    const w2 = world();
    expect(
      ate(w2, 2, findItem(w2, 0, 'detritus').item).filter((e) => !e.food.startsWith('t')),
    ).toEqual([]);
  });

  it('lets a T2 creature eat layer 2 and layer 1 but not layer 0', () => {
    const w = world();
    const l2 = findItem(w, 2, 'detritus').item;
    expect(ate(w, 2, l2).map((e) => e.food)).toContain(l2.id);
    const w1 = world();
    const l1 = findItem(w1, 1, 'detritus').item;
    expect(ate(w1, 2, l1).map((e) => e.food)).toContain(l1.id);
  });

  it('eats in layer, then cell, then slot order', () => {
    const w = world();
    const { item } = findItem(w, 1, 'detritus');
    const creature = over(w, 1, item);
    creature.energy = 0;
    const events = applyFeeding(w, creature).flatMap((e) => (e.type === 'eat' ? [e.food] : []));
    const firstLayer1 = events.findIndex((id) => id.startsWith('t1'));
    expect(firstLayer1).toBeGreaterThanOrEqual(0);
    expect(events.slice(firstLayer1).every((id) => id.startsWith('t1'))).toBe(true);
  });
});

const cellOf = (item: FoodItem, layer: number): [number, number] => {
  const cell = RULES.world.cellSize * 4 ** layer;
  return [Math.floor(item.x / cell), Math.floor(item.y / cell)];
};

describe('claims on layer slots', () => {
  it('parses a layer-1 id into its slot and cycle, and refuses malformed ones', () => {
    expect(parseFoodId('t1c2_3_s4_k0')).toEqual({ slot: 't1c2_3_s4', k: 0 });
    expect(parseFoodId('t4c0_0_s9_k12')).toEqual({ slot: 't4c0_0_s9', k: 12 });
    expect(parseFoodId('c2_3_s4_k7')).toEqual({ slot: 'c2_3_s4', k: 7 });
    expect(parseFoodId('t0c2_3_s4_k0')).toBeNull();
    expect(parseFoodId('t5c2_3_s4_k0')).toBeNull();
    expect(parseFoodId('t1c2_3_s4')).toBeNull();
  });

  it('applies a remote claim for t1c2_3_s4 and respawns it by the layer-0 rule', () => {
    const w = world();
    const tick = w.tick;
    expect(applyRemoteClaim(w, { slot: 't1c2_3_s4', k: 0, tick })).toBe(true);
    const eaten = w.consumed.t1c2_3_s4;
    expect(eaten?.k).toBe(1);
    const delay = (eaten?.until ?? 0) - tick;
    expect(delay).toBeGreaterThanOrEqual(RULES.food.respawnMinTicks);
    expect(delay).toBeLessThanOrEqual(RULES.food.respawnMaxTicks);
    expect(foodInCell(w, 2, 3, 1).map((i) => i.id)).not.toContain('t1c2_3_s4_k0');
    w.tick = eaten?.until ?? 0;
    expect(foodInCell(w, 2, 3, 1)[4]?.id).toBe('t1c2_3_s4_k1');
    // The same slot number in layer 0 and layer 2 is untouched.
    expect(w.consumed.c2_3_s4).toBeUndefined();
    // A claim for a cycle the slot is already past is ignored, as in layer 0.
    expect(applyRemoteClaim(w, { slot: 't1c2_3_s4', k: 1, tick })).toBe(true);
    expect(applyRemoteClaim(w, { slot: 't1c2_3_s4', k: 0, tick })).toBe(false);
  });

  it('consumes a layer item by its id', () => {
    const w = world();
    consumeFood(w, 't1c2_3_s4_k0');
    expect(w.consumed.t1c2_3_s4?.k).toBe(1);
    expect(() => consumeFood(w, 't1c2_3_s4_k0')).toThrow();
    expect(() => consumeFood(w, 't1c8_0_s0_k0')).toThrow();
  });

  it('takes a layer slot only within that layer’s grid', () => {
    const w = world();
    expect(isFoodSlot(w, 't1c7_7_s9')).toBe(true);
    expect(isFoodSlot(w, 'c0_0_s10')).toBe(false);
    expect(isFoodSlot(w, 't1c8_0_s0')).toBe(false);
    expect(isFoodSlot(w, 't1c0_0_s39')).toBe(true);
    expect(isFoodSlot(w, 't1c0_0_s40')).toBe(false);
    expect(isFoodSlot(w, 't2c1_1_s0')).toBe(true);
    expect(isFoodSlot(w, 't2c2_0_s0')).toBe(false);
    expect(isFoodSlot(w, 't3c0_0_s0')).toBe(false);
    expect(isFoodSlot(w, 't0c0_0_s0')).toBe(false);
    expect(isFoodSlot(w, 't5c0_0_s0')).toBe(false);
    expect(isFoodSlot(w, 'c7_7_s9')).toBe(true);
    expect(applyRemoteClaim(w, { slot: 't1c8_0_s0', k: 0, tick: w.tick })).toBe(false);
  });

  it('keeps a layer slot’s consumed entry through steps: a T1 bite is a claim for that slot', () => {
    const w = world();
    const { item } = findItem(w, 1, 'detritus');
    over(w, 1, item);
    const events = step(w, {}).filter((e) => e.type === 'eat');
    const eaten = events.find((e) => e.type === 'eat' && e.food === item.id);
    expect(eaten).toBeDefined();
    const claim = parseFoodId(item.id);
    expect(w.consumed[claim?.slot as string]?.k).toBe(1);
  });
});

describe('a T3 creature in a world', () => {
  speedTest('takes one tick with its visible food in under 2 ms', () => {
    const w = world('t3-speed', 262144);
    const { item } = findItem(w, 3, 'detritus');
    const creature = over(w, 3, item);
    for (let i = 0; i < 30; i++) step(w, {});
    const runs = 60;
    const ms = Math.min(
      ...Array.from({ length: 5 }, () => {
        creature.energy = 1;
        const start = process.hrtime.bigint();
        for (let i = 0; i < runs; i++) step(w, {});
        return Number(process.hrtime.bigint() - start) / 1e6 / runs;
      }),
    );
    expect(ms).toBeLessThan(2);
  });
});
