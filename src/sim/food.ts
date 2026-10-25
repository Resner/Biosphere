import { clamp, sin, TAU } from './math';
import { hashU32 } from './prng';
import { RULES } from './rules';
import type { CreatureState, FoodItem, FoodKind, StepEvent, Vec2, World } from './types';
import { maxEnergy } from './vitals';

// Independent hash streams per property of a slot's cycle, so adding one never shifts another.
const SALT = { kind: 1, x: 2, y: 3, delay: 4, bobX: 5, bobY: 6 } as const;
const KINDS = Object.keys(RULES.food.kinds) as FoodKind[];
const TOTAL_WEIGHT = KINDS.reduce((sum, kind) => sum + RULES.food.kinds[kind].weight, 0);
const MAX_ITEM_RADIUS = Math.max(...KINDS.map((kind) => RULES.food.kinds[kind].radius));
const ID_PATTERN = /^c(\d+)_(\d+)_s(\d+)_k(\d+)$/;

const cellsPerSide = (world: World): number => Math.floor(world.size / RULES.world.cellSize);

function slotHash(world: World, cx: number, cy: number, slot: number, k: number, salt: number) {
  return hashU32(...world.seed32, cx, cy, slot, k, salt) >>> 0;
}

const unit = (hash: number): number => hash / 4294967296;
const slotKey = (cx: number, cy: number, slot: number): string => `c${cx}_${cy}_s${slot}`;

/** Where cycle k of a slot is anchored: inside its cell, kept clear of the world edge. */
export function slotAnchor(world: World, cx: number, cy: number, slot: number, k: number): Vec2 {
  const cell = RULES.world.cellSize;
  const margin = RULES.food.driftRadius;
  const place = (cell0: number, salt: number): number => {
    const p = cell0 * cell + unit(slotHash(world, cx, cy, slot, k, salt)) * cell;
    return clamp(p, margin, world.size - margin);
  };
  return { x: place(cx, SALT.x), y: place(cy, SALT.y) };
}

/** Position along one axis of the bobbing drift: a sine with a hash-chosen period and phase. */
function bob(world: World, cx: number, cy: number, slot: number, k: number, salt: number) {
  const f = RULES.food;
  const h = slotHash(world, cx, cy, slot, k, salt);
  const span = f.bobPeriodMaxTicks - f.bobPeriodMinTicks + 1;
  const period = f.bobPeriodMinTicks + (h % span);
  const phase = unit(hashU32(h, salt)) * TAU;
  return f.driftRadius * f.bobFraction * sin(phase + ((world.tick % period) / period) * TAU);
}

function itemFor(
  world: World,
  cx: number,
  cy: number,
  slot: number,
  eaten: { k: number; until: number } | undefined,
): FoodItem {
  const k = eaten?.k ?? 0;
  let roll = slotHash(world, cx, cy, slot, k, SALT.kind) % TOTAL_WEIGHT;
  let kind = KINDS[KINDS.length - 1] as FoodKind;
  for (const candidate of KINDS) {
    roll -= RULES.food.kinds[candidate].weight;
    if (roll < 0) {
      kind = candidate;
      break;
    }
  }
  const anchor = slotAnchor(world, cx, cy, slot, k);
  const spec = RULES.food.kinds[kind];
  return {
    id: `${slotKey(cx, cy, slot)}_k${k}`,
    kind,
    x: anchor.x + bob(world, cx, cy, slot, k, SALT.bobX),
    y: anchor.y + bob(world, cx, cy, slot, k, SALT.bobY),
    value: spec.value,
    radius: spec.radius,
    respawnTick: eaten?.until ?? 0,
  };
}

/**
 * The food alive in one grid cell at `world.tick`, in slot order. A slot shows cycle 0 until it is
 * eaten; then it is empty until its respawn tick and shows the next cycle. `respawnTick` is the
 * tick the item appeared.
 */
export function foodInCell(world: World, cx: number, cy: number): FoodItem[] {
  const n = cellsPerSide(world);
  if (cx < 0 || cy < 0 || cx >= n || cy >= n) return [];
  const items: FoodItem[] = [];
  for (let slot = 0; slot < RULES.food.slotsPerCell; slot++) {
    const eaten = world.consumed[slotKey(cx, cy, slot)];
    if (eaten === undefined || world.tick >= eaten.until) {
      items.push(itemFor(world, cx, cy, slot, eaten));
    }
  }
  return items;
}

/** Food within `radius` of a point, ordered by cell then slot (a stable order). */
export function foodNear(world: World, x: number, y: number, radius: number): FoodItem[] {
  const cell = RULES.world.cellSize;
  const reach = radius + RULES.food.driftRadius;
  const n = cellsPerSide(world);
  const x0 = Math.max(0, Math.floor((x - reach) / cell));
  const x1 = Math.min(n - 1, Math.floor((x + reach) / cell));
  const y0 = Math.max(0, Math.floor((y - reach) / cell));
  const y1 = Math.min(n - 1, Math.floor((y + reach) / cell));
  const found: FoodItem[] = [];
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      for (const item of foodInCell(world, cx, cy)) {
        const dx = item.x - x;
        const dy = item.y - y;
        if (dx * dx + dy * dy <= radius * radius) found.push(item);
      }
    }
  }
  return found;
}

/** Marks a live item as eaten; its slot is empty until a hash-chosen 20-60 s have passed. */
export function consumeFood(world: World, id: string): void {
  const m = ID_PATTERN.exec(id);
  if (!m) throw new Error(`bad food id ${id}`);
  const [cx, cy, slot, k] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as const;
  if (`${slotKey(cx, cy, slot)}_k${k}` !== id) throw new Error(`bad food id ${id}`);
  const eaten = world.consumed[slotKey(cx, cy, slot)];
  const inGrid = cx < cellsPerSide(world) && cy < cellsPerSide(world);
  const alive =
    inGrid &&
    slot < RULES.food.slotsPerCell &&
    k === (eaten?.k ?? 0) &&
    world.tick >= (eaten?.until ?? 0);
  if (!alive) throw new Error(`food ${id} is not alive`);
  const f = RULES.food;
  const span = f.respawnMaxTicks - f.respawnMinTicks + 1;
  const delay = f.respawnMinTicks + (slotHash(world, cx, cy, slot, k, SALT.delay) % span);
  world.consumed[slotKey(cx, cy, slot)] = { k: k + 1, until: world.tick + delay };
}

/**
 * Eats every item the creature overlaps (distance < radius + item radius), unless its energy is
 * already at the cap: then the item stays for someone hungrier.
 */
export function applyFeeding(world: World, creature: CreatureState): StepEvent[] {
  if (!creature.alive) return [];
  const radius = Math.sqrt(creature.biomass);
  const energyCap = maxEnergy(creature.biomass);
  const events: StepEvent[] = [];
  for (const item of foodNear(world, creature.x, creature.y, radius + MAX_ITEM_RADIUS)) {
    const dx = item.x - creature.x;
    const dy = item.y - creature.y;
    const reach = radius + item.radius;
    if (dx * dx + dy * dy >= reach * reach) continue;
    if (creature.energy >= energyCap) continue;
    consumeFood(world, item.id);
    creature.energy = Math.max(creature.energy, Math.min(creature.energy + item.value, energyCap));
    events.push({ type: 'eat', creature: creature.id, food: item.id, value: item.value });
  }
  return events;
}
