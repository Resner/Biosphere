import { describe, expect, it } from 'vitest';
import { depthAt, zoneAt } from './bathymetry';
import { type Mouth, STARTER_PHYS } from './body';
import {
  applyFeeding,
  applyRemoteClaim,
  consumeFood,
  efficiency,
  foodInCell,
  foodNear,
  slotAnchor,
} from './food';
import { ventNear } from './hazards';
import { RULES } from './rules';
import { step } from './step';
import type { FoodItem, FoodKind, World } from './types';
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

  it('puts about 8 items in a cell', () => {
    const w = world('stats');
    let total = 0;
    const side = w.size / RULES.world.cellSize;
    for (let cy = 0; cy < side; cy++) {
      for (let cx = 0; cx < side; cx++) total += foodInCell(w, cx, cy).length;
    }
    expect(total / (side * side)).toBeGreaterThanOrEqual(6);
    expect(total / (side * side)).toBeLessThanOrEqual(10);
  });

  it('weights each slot by the zone at its anchor, crystals richest near a vent', () => {
    const kinds: FoodKind[] = ['detritus', 'globule', 'crystal'];
    const counts: Record<string, Record<FoodKind, number>> = {};
    const w = world('zones');
    const side = w.size / RULES.world.cellSize;
    for (let cy = 0; cy < side; cy++) {
      for (let cx = 0; cx < side; cx++) {
        for (const item of foodInCell(w, cx, cy)) {
          // The item sits within the drift radius of its anchor; judge by the cell's slot kind only.
          const zone = zoneAt(w.seed32, item.x, item.y);
          const bucket = counts[zone] ?? { detritus: 0, globule: 0, crystal: 0 };
          counts[zone] = bucket;
          bucket[item.kind]++;
        }
      }
    }
    // No crystals above the deep and no globules below twilight, whatever the rounding at an edge.
    for (const zone of ['shallows', 'twilight']) {
      const c = counts[zone] as Record<FoodKind, number>;
      expect(c.crystal / (c.detritus + c.globule + c.crystal)).toBeLessThan(0.02);
    }
    for (const zone of ['deep', 'abyss']) {
      const c = counts[zone] as Record<FoodKind, number>;
      expect(c.globule / (c.detritus + c.globule + c.crystal)).toBeLessThan(0.02);
    }
    const share = (zone: string, kind: FoodKind): number => {
      const c = counts[zone] as Record<FoodKind, number>;
      return c[kind] / kinds.reduce((sum, k) => sum + c[k], 0);
    };
    expect(share('shallows', 'globule')).toBeGreaterThan(share('twilight', 'globule') - 0.02);
    expect(share('abyss', 'crystal')).toBeGreaterThan(share('deep', 'crystal'));
    expect(share('deep', 'crystal')).toBeGreaterThan(0.05);
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

describe('vent crystals', () => {
  it('are richer within reach of a vent than elsewhere in the deep', () => {
    const w = world('vents');
    const cell = RULES.world.cellSize;
    const side = w.size / cell;
    const near = { crystal: 0, all: 0 };
    const far = { crystal: 0, all: 0 };
    for (let cy = 0; cy < side; cy++) {
      for (let cx = 0; cx < side; cx++) {
        for (const slot of foodInCell(w, cx, cy)) {
          const anchor = slotAnchor(w, cx, cy, Number(slot.id.split('_s')[1]?.split('_')[0]), 0);
          if (zoneAt(w.seed32, anchor.x, anchor.y) !== 'deep') continue;
          const bucket = ventNear(w, anchor.x, anchor.y, RULES.food.ventRange) ? near : far;
          bucket.all++;
          if (slot.kind === 'crystal') bucket.crystal++;
        }
      }
    }
    expect(near.all).toBeGreaterThan(100);
    expect(far.all).toBeGreaterThan(100);
    expect(near.crystal / near.all).toBeGreaterThan(2 * (far.crystal / far.all));
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
      { type: 'eat', creature: 'p', food: item.id, value: item.value * efficiency(item.kind, 0.5) },
    ]);
    // The step also bills one tick of basal metabolism (0.8/s).
    expect(creature.energy).toBeCloseTo(
      before + item.value * efficiency(item.kind, 0.5) - 0.8 / 30,
      4,
    );
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

  it('never lowers energy that is above the cap', () => {
    const w = world();
    const { creature } = placeOnItem(w);
    creature.energy = 2 * creature.biomass + 5;
    applyFeeding(w, creature);
    expect(creature.energy).toBe(2 * creature.biomass + 5);
  });

  it('leaves an overlapping item alone at maximum energy', () => {
    const w = world();
    const { item, creature } = placeOnItem(w);
    creature.energy = 2 * creature.biomass;
    expect(applyFeeding(w, creature)).toEqual([]);
    expect(foodNear(w, item.x, item.y, 1).map((i) => i.id)).toContain(item.id);
    creature.energy = 2 * creature.biomass - 1;
    expect(applyFeeding(w, creature)).toHaveLength(1);
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
    expect(() => consumeFood(w, 'c08_8_s0_k1')).toThrow();
  });
});

describe('applyRemoteClaim', () => {
  it('gives the slot the respawn tick the eater would have computed', () => {
    const local = world('claims');
    const remote = world('claims');
    local.tick = 100;
    consumeFood(local, 'c3_5_s2_k0');
    remote.tick = 400; // a different local clock (within the window) changes nothing
    expect(applyRemoteClaim(remote, { slot: 'c3_5_s2', k: 0, tick: 100 })).toBe(true);
    expect(remote.consumed.c3_5_s2).toEqual(local.consumed.c3_5_s2);
  });

  it('lets an earlier claim for the same cycle replace a later one, and ignores older cycles', () => {
    const w = world('claims');
    applyRemoteClaim(w, { slot: 'c3_5_s2', k: 0, tick: 103 });
    const late = w.consumed.c3_5_s2?.until ?? 0;
    expect(applyRemoteClaim(w, { slot: 'c3_5_s2', k: 0, tick: 100 })).toBe(true);
    expect(w.consumed.c3_5_s2?.until).toBe(late - 3);
    applyRemoteClaim(w, { slot: 'c3_5_s2', k: 1, tick: 800 });
    const after = structuredClone(w.consumed);
    expect(applyRemoteClaim(w, { slot: 'c3_5_s2', k: 0, tick: 100 })).toBe(false);
    expect(w.consumed).toEqual(after);
  });

  it('rejects a claim outside the window around the local tick or the cycles a slot can reach', () => {
    const w = world('claims');
    w.tick = 3000;
    const w0 = structuredClone(w.consumed);
    for (const [k, tick] of [
      [4294967295, 3000],
      [0, 4294967295],
      [0, 3000 - RULES.food.claimTickWindow - 1],
      [0, 3000 + RULES.food.claimTickWindow + 1],
      [(3000 + 2 * RULES.food.claimTickWindow) / RULES.food.respawnMinTicks, 3000],
    ] as const) {
      expect(applyRemoteClaim(w, { slot: 'c3_5_s2', k, tick })).toBe(false);
    }
    expect(w.consumed).toEqual(w0);
    expect(applyRemoteClaim(w, { slot: 'c3_5_s2', k: 5, tick: 3000 })).toBe(true);
  });

  it('rejects slots outside the grid', () => {
    const w = world('claims');
    for (const slot of ['c99_0_s0', 'c0_0_s10', 'x1_1_s1', 'c01_0_s0', 'c1_1']) {
      expect(applyRemoteClaim(w, { slot, k: 0, tick: 1 })).toBe(false);
    }
    expect(w.consumed).toEqual({});
  });
});

describe('feeding through the mouth', () => {
  const JAW: Mouth = { offset: 0.9, radius: 0.35, arc: 0.6, type: 1, digestion: 1 };

  /** A live item of `kind` and a starter-sized creature that can eat it, its mouth set to `mouth`. */
  const setup = (kind: FoodKind, mouth: Mouth, bearing = 0, distance = 0, heading = 0) => {
    const w = world('mouth');
    let item: FoodItem | undefined;
    for (let cx = 6; cx < 20 && !item; cx++) {
      item = foodInCell(w, cx, 8).find((i) => i.kind === kind);
    }
    if (!item) throw new Error(`no ${kind}`);
    const r = 10;
    const creature = spawnCreature(w, {
      id: 'p',
      x: item.x - distance * r * Math.cos(heading + bearing),
      y: item.y - distance * r * Math.sin(heading + bearing),
      phys: { ...STARTER_PHYS, mouth },
    });
    creature.heading = heading;
    creature.energy = 20;
    return { w, item, creature };
  };

  const ate = (w: World, creature: ReturnType<typeof spawnCreature>) =>
    applyFeeding(w, creature).flatMap((e) => (e.type === 'eat' ? [e] : []));

  it('lets a starter eat at exactly the old reach, in every direction', () => {
    for (const kind of ['detritus', 'globule', 'crystal'] as const) {
      for (let k = 0; k < 8; k++) {
        const heading = (k * Math.PI) / 4 + 0.3;
        const near = setup(kind, STARTER_PHYS.mouth, 0, 0, heading);
        const r = Math.sqrt(near.creature.biomass);
        const place = (d: number) => {
          near.creature.x = near.item.x - d * Math.cos(heading + 1);
          near.creature.y = near.item.y - d * Math.sin(heading + 1);
        };
        place(r + near.item.radius + 0.1);
        // Another item may sit within reach by chance, so judge this item alone.
        expect(ate(near.w, near.creature).map((e) => e.food)).not.toContain(near.item.id);
        place(r + near.item.radius - 0.1);
        // A starter's mouth is type 0.5, so a crystal still feeds (efficiency 0.6).
        expect(ate(near.w, near.creature).map((e) => e.food)).toContain(near.item.id);
      }
    }
  });

  it('lets a jaw eat a crystal straight ahead at 1.2 r, but not behind or 60 degrees off', () => {
    const ahead = setup('crystal', JAW, 0, 1.2);
    expect(ate(ahead.w, ahead.creature)).toHaveLength(1);
    const behind = setup('crystal', JAW, Math.PI, 1.2);
    expect(ate(behind.w, behind.creature)).toEqual([]);
    const off = setup('crystal', JAW, Math.PI / 3, 1.2);
    expect(ate(off.w, off.creature)).toEqual([]);
    const edge = setup('crystal', JAW, 0.5, 1.2);
    expect(ate(edge.w, edge.creature)).toHaveLength(1);
  });

  it('yields value x efficiency x digestion, linear in the mouth type', () => {
    const table: [number, FoodKind, number][] = [
      [0, 'detritus', 8],
      [0, 'globule', 15],
      [1, 'crystal', 60],
      [1, 'globule', 20],
      [1, 'detritus', 3.2],
      [0.5, 'detritus', 6.4],
      [0.5, 'globule', 25],
      [0.5, 'crystal', 36],
    ];
    for (const [type, kind, expected] of table) {
      for (const digestion of [1, 0.5]) {
        const mouth = { ...STARTER_PHYS.mouth, type, digestion };
        const { w, creature } = setup(kind, mouth);
        const before = creature.energy;
        const events = ate(w, creature);
        expect(events).toHaveLength(1);
        expect(creature.energy - before).toBeCloseTo(expected * digestion, 9);
        expect(events[0]).toMatchObject({ value: expect.closeTo(expected * digestion, 9) });
      }
    }
    expect(efficiency('crystal', 0.25)).toBeCloseTo(0.3, 9);
    expect(efficiency('detritus', 0.75)).toBeCloseTo(0.6, 9);
  });

  it('never eats food with efficiency 0, and leaves its slot alone', () => {
    const { w, item, creature } = setup('crystal', { ...STARTER_PHYS.mouth, type: 0 });
    expect(applyFeeding(w, creature)).toEqual([]);
    expect(creature.energy).toBe(20);
    expect(foodNear(w, item.x, item.y, 1).map((i) => i.id)).toContain(item.id);
    expect(w.consumed).toEqual({});
  });

  it('caps energy at the maximum and leaves food to a full creature', () => {
    const { w, item, creature } = setup('crystal', JAW, 0, 1.2);
    creature.energy = 2 * creature.biomass - 1;
    expect(ate(w, creature)).toHaveLength(1);
    expect(creature.energy).toBe(2 * creature.biomass);
    const full = setup('crystal', JAW, 0, 1.2);
    full.creature.energy = 2 * full.creature.biomass;
    expect(applyFeeding(full.w, full.creature)).toEqual([]);
    expect(foodNear(full.w, item.x, item.y, 1).map((i) => i.id)).toContain(item.id);
  });

  it('keeps a tick of 24 armed creatures in a full pond under 2 ms', () => {
    const w = createWorld({ seed: 'perf' });
    const colliders = [{ x: 0, y: 0, r: 1 }];
    for (let i = 1; i < 12; i++) colliders.push({ x: -0.2 * i, y: 0.1 * i, r: 0.4 });
    for (let i = 0; i < 24; i++) {
      spawnCreature(w, {
        id: `c${String(i).padStart(2, '0')}`,
        x: 3000 + (i % 6) * 40,
        y: 3000 + Math.floor(i / 6) * 40,
        phys: { ...STARTER_PHYS, mouth: JAW, colliders },
      });
    }
    for (let i = 0; i < 30; i++) step(w, {});
    const runs = 60;
    const start = process.hrtime.bigint();
    for (let i = 0; i < runs; i++) step(w, {});
    const ms = Number(process.hrtime.bigint() - start) / 1e6 / runs;
    expect(ms).toBeLessThan(2);
  });

  it('keeps a tick of 24 creatures in the deep, where vents are scanned, under 2 ms', () => {
    const w = createWorld({ seed: 'perf2' });
    let at = { x: 0, y: 0 };
    for (let y = 100; y < 8000; y += 100) {
      for (let x = 100; x < 8000; x += 100) {
        const depth = depthAt(w.seed32, x, y);
        if (depth > 0.6 && depth < 0.68) at = { x, y };
      }
    }
    for (let i = 0; i < 24; i++) {
      const id = `c${String(i).padStart(2, '0')}`;
      spawnCreature(w, { id, x: at.x + (i % 6) * 40, y: at.y + Math.floor(i / 6) * 40 });
    }
    for (let i = 0; i < 30; i++) step(w, {});
    const runs = 60;
    const start = process.hrtime.bigint();
    for (let i = 0; i < runs; i++) step(w, {});
    expect(Number(process.hrtime.bigint() - start) / 1e6 / runs).toBeLessThan(2);
  });
});
