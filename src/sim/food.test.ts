import { describe, expect, it } from 'vitest';
import { applyFeeding, consumeFood, foodInCell, foodNear, slotAnchor } from './food';
import { RULES } from './rules';
import { step } from './step';
import type { FoodKind } from './types';
import { createWorld, spawnCreature } from './world';

const world = (seed = 'food') => createWorld({ seed, currents: false, hazards: false });

describe('foodInCell', () => {
  it('is identical across calls and differs by world seed', () => {
    const a = foodInCell(world('pond-1'), 3, 5);
    expect(foodInCell(world('pond-1'), 3, 5)).toEqual(a);
    expect(a).toHaveLength(RULES.food.slotsPerCell);
    expect(foodInCell(world('pond-2'), 3, 5).map((i) => [i.x, i.y])).not.toEqual(
      a.map((i) => [i.x, i.y]),
    );
  });

  it('names items by cell, slot and cycle', () => {
    const ids = foodInCell(world(), 3, 5).map((i) => i.id);
    expect(ids[2]).toBe('c3_5_s2_k0');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('is empty outside the grid', () => {
    expect(foodInCell(world(), -1, 0)).toEqual([]);
    expect(foodInCell(world(), 0, 32)).toEqual([]);
  });

  it('keeps items near their slot anchor as the tick advances', () => {
    const w = world();
    for (let t = 0; t < 600; t += 7) {
      w.tick = t;
      for (const item of foodInCell(w, 4, 4)) {
        const slot = Number(/_s(\d+)_/.exec(item.id)?.[1]);
        const anchor = slotAnchor(w, 4, 4, slot, 0);
        expect(Math.hypot(item.x - anchor.x, item.y - anchor.y)).toBeLessThanOrEqual(12);
      }
    }
  });

  it('moves items over time', () => {
    const w = world();
    const before = foodInCell(w, 4, 4);
    w.tick = 45;
    const after = foodInCell(w, 4, 4);
    expect(after.some((item, i) => item.x !== (before[i]?.x ?? 0))).toBe(true);
  });

  it('puts about 8 items in a cell and splits kinds 70:25:5', () => {
    const w = world('stats');
    const counts: Record<FoodKind, number> = { detritus: 0, globule: 0, crystal: 0 };
    let total = 0;
    for (let cy = 0; cy < 32; cy++) {
      for (let cx = 0; cx < 31; cx++) {
        for (const item of foodInCell(w, cx, cy)) {
          counts[item.kind]++;
          total++;
        }
      }
    }
    const cells = 32 * 31;
    expect(cells).toBeGreaterThanOrEqual(992);
    expect(total / cells).toBeGreaterThanOrEqual(6);
    expect(total / cells).toBeLessThanOrEqual(10);
    expect(Math.abs((counts.detritus / total) * 100 - 70)).toBeLessThan(5);
    expect(Math.abs((counts.globule / total) * 100 - 25)).toBeLessThan(5);
    expect(Math.abs((counts.crystal / total) * 100 - 5)).toBeLessThan(5);
  });

  it('keeps every item inside the world', () => {
    const w = world();
    for (const [cx, cy] of [
      [0, 0],
      [31, 31],
    ] as const) {
      for (const item of foodInCell(w, cx, cy)) {
        expect(item.x).toBeGreaterThanOrEqual(0);
        expect(item.x).toBeLessThanOrEqual(w.size);
        expect(item.y).toBeGreaterThanOrEqual(0);
        expect(item.y).toBeLessThanOrEqual(w.size);
      }
    }
  });
});

describe('foodNear', () => {
  it('finds exactly the items within the radius, across cell borders', () => {
    const w = world();
    const x = 512;
    const y = 768;
    const near = foodNear(w, x, y, 150);
    const brute: string[] = [];
    for (let cy = 2; cy <= 3; cy++) {
      for (let cx = 1; cx <= 2; cx++) {
        for (const i of foodInCell(w, cx, cy)) {
          if ((i.x - x) ** 2 + (i.y - y) ** 2 <= 22500) brute.push(i.id);
        }
      }
    }
    expect(near.map((i) => i.id).sort()).toEqual(brute.sort());
    expect(near.length).toBeGreaterThan(0);
  });
});

describe('feeding', () => {
  const placeOnItem = (w: ReturnType<typeof world>, id = 'p') => {
    const item = foodInCell(w, 8, 8)[0];
    if (!item) throw new Error('no item');
    return { item, creature: spawnCreature(w, { id, x: item.x, y: item.y }) };
  };

  it('eats an overlapping item on the next step and raises energy', () => {
    const w = world();
    const { item, creature } = placeOnItem(w);
    const before = creature.energy;
    const events = step(w, {});
    expect(events.filter((e) => e.type === 'eat')).toEqual([
      { type: 'eat', creature: 'p', food: item.id, value: item.value },
    ]);
    expect(creature.energy).toBe(before + item.value);
    expect(foodInCell(w, 8, 8).map((i) => i.id)).not.toContain(item.id);
  });

  it('respawns the slot as the next cycle at a new position, 20-60 s later', () => {
    const w = world();
    const { item } = placeOnItem(w);
    consumeFood(w, item.id);
    const eatenAt = w.tick;
    const slot = item.id.slice(0, item.id.indexOf('_k'));
    const entry = w.consumed[slot];
    expect(entry?.k).toBe(1);
    expect(entry?.until).toBeGreaterThanOrEqual(eatenAt + RULES.food.respawnMinTicks);
    expect(entry?.until).toBeLessThanOrEqual(eatenAt + RULES.food.respawnMaxTicks);
    const until = entry?.until as number;

    w.tick = until - 1;
    expect(foodInCell(w, 8, 8).some((i) => i.id.startsWith(`${slot}_`))).toBe(false);
    w.tick = until;
    const back = foodInCell(w, 8, 8).find((i) => i.id.startsWith(`${slot}_`));
    expect(back?.id).toBe(`${slot}_k1`);
    expect(slotAnchor(w, 8, 8, 0, 1)).not.toEqual(slotAnchor(w, 8, 8, 0, 0));
    w.tick = until + 100_000;
    expect(foodInCell(w, 8, 8).find((i) => i.id.startsWith(`${slot}_`))?.id).toBe(`${slot}_k1`);
  });

  it('caps energy at the maximum', () => {
    const w = world();
    const { creature } = placeOnItem(w);
    creature.energy = 2 * creature.biomass - 1;
    applyFeeding(w, creature);
    expect(creature.energy).toBe(2 * creature.biomass);
  });

  it('does not eat a distant item or feed a dead creature', () => {
    const w = world();
    const { item, creature } = placeOnItem(w);
    creature.x += 30;
    expect(applyFeeding(w, creature)).toEqual([]);
    creature.x = item.x;
    creature.alive = false;
    expect(applyFeeding(w, creature)).toEqual([]);
  });

  it('refuses to eat the same item twice', () => {
    const w = world();
    const { item } = placeOnItem(w);
    consumeFood(w, item.id);
    expect(() => consumeFood(w, item.id)).toThrow();
    expect(() => consumeFood(w, 'nonsense')).toThrow();
  });
});
